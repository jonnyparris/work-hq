#!/bin/bash
# publish.sh — push a squashed snapshot of HEAD to a second remote (e.g. a public or
# shared mirror) without its history. Each run adds one commit on top of the mirror.
#
#   scripts/publish.sh [remote=github] [message]
#
# Publishes HEAD's committed tree only: uncommitted edits (yours or another session's
# sharing the checkout) are never read, so a dirty tree just warns. Refuses if HEAD's
# tree matches any pattern in the denylist ($WORK_HQ_PUBLISH_DENYLIST, default ~/.config/work-hq/publish-denylist.txt):
# one case-insensitive extended regex per line, # for comments. Put internal hostnames,
# colleague names, account ids there.
#
# Author identity for mirror commits: git config publish.name / publish.email (e.g. your
# GitHub noreply address), so your work email doesn't leak into the mirror.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
REMOTE="${1:-github}"
MSG="${2:-Sync from $(git rev-parse --short HEAD): $(git log -1 --format=%s)}"
DENY="${WORK_HQ_PUBLISH_DENYLIST:-$HOME/.config/work-hq/publish-denylist.txt}"

[[ -z "$(git status --porcelain)" ]] || echo "note: working tree dirty — publishing committed HEAD $(git rev-parse --short HEAD) only" >&2
git remote get-url "$REMOTE" >/dev/null 2>&1 || { echo "no remote '$REMOTE'" >&2; exit 1; }

if [[ -f "$DENY" ]]; then
  patterns="$(grep -vE '^\s*(#|$)' "$DENY" || true)"
  if [[ -n "$patterns" ]] && hits="$(git grep -I -n -i -E -f <(printf '%s\n' "$patterns") HEAD -- . ':!bun.lock' || true)" && [[ -n "$hits" ]]; then
    echo "denylist matches — not publishing:" >&2; echo "$hits" | sed 's/^HEAD://' | head -40 >&2; exit 1
  fi
else
  echo "warning: no denylist at $DENY — publishing without a scan" >&2
fi

if pe="$(git config --get publish.email)"; then
  export GIT_AUTHOR_EMAIL="$pe" GIT_COMMITTER_EMAIL="$pe"
  pn="$(git config --get publish.name || git config --get user.name)"; export GIT_AUTHOR_NAME="$pn" GIT_COMMITTER_NAME="$pn"
fi

tree="$(git rev-parse 'HEAD^{tree}')"
if git fetch -q "$REMOTE" main 2>/dev/null; then
  parent="$(git rev-parse FETCH_HEAD)"
  [[ "$(git rev-parse "$parent^{tree}")" == "$tree" ]] && { echo "$REMOTE/main already matches HEAD"; exit 0; }
  commit="$(git commit-tree "$tree" -p "$parent" -m "$MSG")"
else
  commit="$(git commit-tree "$tree" -m "$MSG")"
fi
git push "$REMOTE" "$commit:refs/heads/main"
echo "published $(git rev-parse --short "$commit") → $REMOTE/main"
