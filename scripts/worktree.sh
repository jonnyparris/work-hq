#!/bin/bash
# worktree.sh — one git worktree per agent session, so concurrent sessions never share an index.
#
# Two sessions in one checkout sweep each other's staged hunks into their commits
# (10-20: a reply-claim fix landed inside an unrelated dead-button commit). Each session
# works on its own branch in its own directory and lands with a fast-forward.
#
#   scripts/worktree.sh new <slug>             # → ../<repo>-<slug> on branch wt/<slug>; prints the path
#   scripts/worktree.sh land [--check 'cmd'] [--no-push] [--keep] [--no-restart]
#                                              # run inside the worktree: rebase on main, run the check,
#                                              # fast-forward the main checkout, push origin main,
#                                              # remove the worktree + branch, ask Work HQ to restart.
#                                              # Prints the landed SHA.
#   scripts/worktree.sh list                   # worktrees + commits ahead of main
#
# Never removes or merges a worktree it didn't get pointed at: others may be in-flight.
# Landed code (not docs/tests) → land asks the running Work HQ server to restart (POST /api/restart). It answers
# only for its own checkout and waits for headless jobs first (src/server/restart.ts). Never launchctl kickstart
# it yourself: that kills running jobs (11-04: a kickstart after a land killed another job mid-land).
set -euo pipefail

die() { echo "worktree.sh: $*" >&2; exit 1; }
MAIN="$(git worktree list --porcelain | awk 'NR==1 && $1=="worktree" { sub(/^worktree /, ""); print; exit }')"
[[ -n "$MAIN" ]] || die "not in a git repo"
BASE="${WORKTREE_BASE:-main}"
REMOTE="${WORKTREE_REMOTE:-origin}"

# Ask the Work HQ server to restart for code just landed in $MAIN. Never fails the land: it already happened.
#   200 now/queued → the server restarts itself (now, or once its headless jobs finish)
#   409            → not that server's checkout, or it has no restart command: nothing restarted
#   no answer      → down (launchd restarts a crashed server on the new code) or too busy: says how to ask again
ask_restart() {
  [[ -f "$MAIN/src/server/restart.ts" ]] || return 0 # not a Work HQ checkout: no server of ours runs from it
  local url port repo reason data out code status waiting
  # WORK_HQ_PORT (explicit) > WORK_HQ_URL (set in Work HQ's own agents) > the config's port, read with the main
  # checkout's code (bounded: never hang a land) > 7717.
  port="${WORK_HQ_PORT:-}"
  if [[ -n "$port" ]]; then url="http://127.0.0.1:$port"
  elif [[ -n "${WORK_HQ_URL:-}" ]]; then url="${WORK_HQ_URL%/}"
  else
    command -v bun >/dev/null && port="$(cd "$MAIN" && perl -e 'alarm shift; exec @ARGV' 5 bun src/cli/config.ts port 2>/dev/null || true)"
    [[ "$port" =~ ^[0-9]+$ ]] || port=7717
    url="http://127.0.0.1:$port"
  fi
  repo="${MAIN//\\/\\\\}"; repo="${repo//\"/\\\"}"
  reason="${WORK_HQ_JOB:-$1}" # a Work HQ job sends its id: the gate never holds a restart behind the job asking
  reason="${reason//\\/\\\\}"; reason="${reason//\"/\\\"}"
  data="{\"repo\":\"$repo\",\"reason\":\"$reason\"}"
  out="$(curl -s --connect-timeout 2 -m 10 -w $'\n%{http_code}' -X POST -H 'content-type: application/json' \
    --data "$data" "$url/api/restart" 2>/dev/null || true)"
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  status="$(sed -n 's/.*"status" *: *"\([a-z]*\)".*/\1/p' <<<"$out")"
  waiting="$(sed -n 's/.*"waitingFor" *: *\[\([^]]*\)\].*/\1/p' <<<"$out" | tr -d '"' | sed 's/,/, /g')"
  case "$code:$status" in
    200:now) echo "server restart: now (Work HQ at $url is restarting itself)" ;;
    200:queued) echo "server restart: queued behind ${waiting:-headless jobs} (it restarts itself when they finish)" ;;
    409:*) echo "server restart: none (Work HQ at $url doesn't run from $MAIN, or has no restart command)" >&2 ;;
    *) echo "server restart: Work HQ at $url didn't take it (${code:-no answer}). Down? launchd starts it again. Busy? ask again, don't kickstart:" \
         "curl -X POST -H 'content-type: application/json' -d '$data' $url/api/restart" >&2 ;;
  esac
}

cmd="${1:-}"; shift || true
case "$cmd" in
  new)
    slug="${1:-}"
    [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "usage: new <slug> (lowercase, digits, hyphens)"
    dir="$(dirname "$MAIN")/$(basename "$MAIN")-$slug"
    branch="wt/$slug"
    [[ -e "$dir" ]] && die "$dir already exists — pick another slug (it may be another session's)"
    git -C "$MAIN" show-ref -q --verify "refs/heads/$branch" && die "branch $branch exists — pick another slug"
    git -C "$MAIN" fetch -q "$REMOTE" "$BASE" 2>/dev/null || echo "warning: fetch $REMOTE failed; branching from local $BASE" >&2
    start="$BASE"
    # Branch from whichever of local/remote main is newer, so we don't start behind.
    if git -C "$MAIN" merge-base --is-ancestor "$BASE" "$REMOTE/$BASE" 2>/dev/null; then start="$REMOTE/$BASE"; fi
    git -C "$MAIN" worktree add -q -b "$branch" "$dir" "$start"
    git -C "$dir" branch -q --unset-upstream 2>/dev/null || true
    # Dependencies aren't shared across worktrees; link them (re-install if you change package.json).
    [[ -d "$MAIN/node_modules" && ! -e "$dir/node_modules" ]] && ln -s "$MAIN/node_modules" "$dir/node_modules"
    echo "$dir"
    ;;

  land)
    check=""; push=1; keep=0; restart=1
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --check) check="${2:?--check needs a command}"; shift 2 ;;
        --no-push) push=0; shift ;;
        --keep) keep=1; shift ;;
        --no-restart) restart=0; shift ;;
        *) die "unknown flag $1" ;;
      esac
    done
    here="$(git rev-parse --show-toplevel)"
    [[ "$here" != "$MAIN" ]] || die "run land inside your worktree, not the main checkout"
    branch="$(git symbolic-ref --short HEAD)" || die "detached HEAD"
    [[ -z "$(git status --porcelain)" ]] || die "worktree dirty — commit first"

    # One lander at a time: two fast-forwards racing would make the loser fail anyway.
    lock="$(git rev-parse --git-common-dir)/worktree-land.lock"
    [[ "$lock" = /* ]] || lock="$here/$lock"
    got=0
    for _ in $(seq 1 "${WORKTREE_LOCK_WAIT:-120}"); do
      mkdir "$lock" 2>/dev/null && { got=1; break; }
      # A lander that crashed or was killed leaves its lock behind (10-22: pid 17677 blocked lands for
      # hours). If the owner's pid is gone, take the lock over. `ps -p`, not `kill -0`: kill fails with
      # EPERM on live processes of other users. Rename first so only one waiter wins the takeover, then
      # re-read owner in case a live lander replaced the stale lock between our read and the rename.
      owner="$(cat "$lock/owner" 2>/dev/null || true)"; pid="${owner##* pid }"
      if [[ "$pid" =~ ^[0-9]+$ ]] && ! ps -p "$pid" >/dev/null 2>&1 && mv "$lock" "$lock.stale.$$" 2>/dev/null; then
        if [[ "$(cat "$lock.stale.$$/owner" 2>/dev/null || true)" == "$owner" ]]; then
          rm -rf "$lock.stale.$$"
          echo "took over a stale land lock ($owner; that process is gone)" >&2
          continue
        fi
        [[ -e "$lock" ]] || mv "$lock.stale.$$" "$lock"
      fi
      sleep 1
    done
    (( got )) || die "another land holds $lock ($(cat "$lock/owner" 2>/dev/null)) — still running; wait for it, or rm -r the lock if that session is stuck"
    echo "$branch pid $$" > "$lock/owner"
    trap 'rm -rf "$lock"' EXIT

    # What the server's checkout ran before this land: the catch-up below can bring in code too.
    before="$(git -C "$MAIN" rev-parse "$BASE")"
    # Catch the main checkout up with the remote first (fast-forward only).
    if git fetch -q "$REMOTE" "$BASE" 2>/dev/null && ! git merge-base --is-ancestor "$REMOTE/$BASE" "$BASE"; then
      git -C "$MAIN" merge -q --ff-only "$REMOTE/$BASE" \
        || die "main checkout can't fast-forward to $REMOTE/$BASE (diverged, or local edits in the way) — sort that out in $MAIN first"
    fi

    if ! git rebase -q "$BASE"; then
      git rebase --abort || true
      die "rebase onto $BASE conflicts — resolve by hand: git rebase $BASE"
    fi
    git merge-base --is-ancestor "$BASE" HEAD || die "rebase didn't put $branch on top of $BASE"
    if [[ "$(git rev-parse HEAD)" == "$(git rev-parse "$BASE")" ]]; then die "nothing to land: $branch has no commits past $BASE"; fi

    if [[ -n "$check" ]]; then
      echo "check: $check" >&2
      # Many agents land at once on one machine; overlapping suites time out under load
      # (10-21: load avg 255 on 12 cores). If a `test-lock` wrapper is on PATH, it caps how
      # many suites run at once machine-wide (TEST_SLOTS, default 3; TEST_LOCK=0 disables).
      # Not `lock`: the EXIT trap removes "$lock", so reusing the name leaked the land lock (10-22).
      gate=""; command -v test-lock >/dev/null && gate=test-lock
      $gate bash -c "$check" || die "check failed — fix, commit, land again"
    fi

    # The main checkout's own uncommitted edits stay put; git refuses only if they touch the same files.
    git -C "$MAIN" merge -q --ff-only "$branch" \
      || die "main checkout refused the fast-forward (uncommitted edits to the same files in $MAIN?) — nothing landed"
    sha="$(git rev-parse --short HEAD)"
    # The main checkout has the new code now, pushed or not: ask before the push, so a failed push (retry by hand,
    # not by landing again) doesn't skip the restart. Same rule as src/cli/land.ts NO_RESTART: docs and tests never
    # need one.
    if (( restart )); then
      files="$(git -C "$MAIN" diff --name-only "$before" "$sha")"
      if [[ -n "$files" ]] && grep -Eqv '(^|/)(docs|test)/|\.md$' <<<"$files"; then ask_restart "$branch"; fi
    fi
    if (( push )); then git -C "$MAIN" push -q "$REMOTE" "$BASE" || die "landed $sha locally but push failed — retry: git -C $MAIN push $REMOTE $BASE"; fi

    if (( ! keep )); then
      git -C "$MAIN" worktree remove "$here" && git -C "$MAIN" branch -q -d "$branch"
      echo "removed $here — cd $MAIN" >&2
    fi
    echo "landed $sha on $BASE$( (( push )) && echo " and pushed to $REMOTE")"
    ;;

  list)
    git -C "$MAIN" worktree list --porcelain | awk '$1=="worktree"{d=$2} $1=="branch"{sub("refs/heads/","",$2); print d" "$2}' |
      while read -r d b; do
        [[ "$d" == "$MAIN" ]] && continue
        ahead="$(git -C "$MAIN" rev-list --count "$BASE..$b" 2>/dev/null || echo ?)"
        dirty="$( [[ -n "$(git -C "$d" status --porcelain 2>/dev/null)" ]] && echo ", dirty" || true)"
        echo "$d  $b  ($ahead ahead$dirty)"
      done
    ;;

  *) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
