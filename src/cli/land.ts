// `whq land <jobId>`: land a work job's server-made worktree in one step (see src/server/worktrees.ts).
//   1. worktree.sh land --keep [--check]   rebase on main, check, fast-forward the main checkout, push
//   2. publish (if configured)             e.g. scripts/publish.sh github, from the landed worktree
//   3. remove the worktree and its branch
//   4. restart (if configured)             only when non-doc files changed; prints the new PID. For the server's
//                                          own checkout it asks the server (POST /api/restart), which waits for
//                                          running sweeps first (src/server/restart.ts)
// Stops at the first failure with the worktree intact, so the agent can fix, commit and run it again.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../server/config.ts";
import { WORKTREE_SCRIPT, type WorktreeInfo } from "../server/worktrees.ts";

/** Files that never need a restart. */
export const NO_RESTART = /(^|\/)(docs|test)\/|\.md$/;

type Sh = (cmd: string[], cwd: string, show?: boolean) => { ok: boolean; out: string; err: string };

const sh: Sh = (cmd, cwd, show = false) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const out = r.stdout.toString().trim();
  const err = r.stderr.toString().trim();
  if (show) [err, out].filter(Boolean).forEach((t) => console.error(t));
  return { ok: r.exitCode === 0, out, err };
};

export interface LandResult {
  ok: boolean;
  sha?: string;
  mirror?: string;
  pid?: string;
  restarted?: boolean;
  /** The server took the restart but holds it for these headless jobs; it restarts itself when they finish. */
  queuedBehind?: string[];
  error?: string;
}

export async function land(info: WorktreeInfo, opts: { script?: string; port?: number; run?: Sh } = {}): Promise<LandResult> {
  const run = opts.run ?? sh;
  const script = opts.script ?? WORKTREE_SCRIPT;
  if (!existsSync(info.dir)) return { ok: false, error: `${info.dir} is gone — already landed or removed` };

  // What this job changes. From the worktree's start, not merge-base with main: after a failed publish the first
  // attempt's commits are already on main, so a retry's merge-base would see only the fix commit and skip the
  // restart (job_mvgb7t9fh3uxm). Rebased-in main commits can add files too; an extra restart is the cheap side.
  const base = info.base ?? run(["git", "merge-base", "HEAD", "main"], info.dir).out;
  const files = base ? run(["git", "diff", "--name-only", base, "HEAD"], info.dir).out.split("\n").filter(Boolean) : [];

  const landArgs = ["bash", script, "land", "--keep", ...(info.check ? ["--check", info.check] : [])];
  const l = run(landArgs, info.dir, true);
  const sha = /landed (\w+)/.exec(l.out)?.[1];
  if (!l.ok || !sha) return { ok: false, error: (l.err || l.out).split("\n").pop() || "land failed" };

  let mirror: string | undefined;
  if (info.publish) {
    const p = run(["bash", "-c", info.publish], info.dir, true);
    if (!p.ok) return { ok: false, sha, error: `landed ${sha}, but publish failed: ${(p.err || p.out).split("\n").pop()} — fix, commit, run whq land again` };
    mirror = /published (\w+)/.exec(p.out)?.[1] ?? (/already matches/.test(p.out) ? "unchanged" : undefined);
  }

  const rm = run(["git", "worktree", "remove", info.dir], info.repo);
  if (rm.ok) run(["git", "branch", "-q", "-d", info.branch], info.repo);
  else console.error(`couldn't remove ${info.dir}: ${rm.err}`);

  const restart = Boolean(info.restart && files.some((f) => !NO_RESTART.test(f)));
  let pid: string | undefined;
  if (restart) {
    const port = opts.port ?? config.port;
    const asked = await askServer(port, info);
    if (asked?.status === "queued") return { ok: true, sha, mirror, restarted: true, queuedBehind: asked.waitingFor };
    if (asked?.status === "now") pid = await waitForPid(port, run, info.repo, String(asked.pid));
    else {
      const r = run(["bash", "-c", info.restart!], info.repo, true);
      if (!r.ok) return { ok: false, sha, mirror, error: `landed ${sha}, but restart failed: ${r.err || r.out}` };
      pid = await waitForPid(port, run, info.repo);
    }
  }
  return { ok: true, sha, mirror, pid, restarted: restart };
}

/** Ask the running server to restart itself. Undefined = not ours (409), not up, or not a Work HQ server: run the command. */
async function askServer(port: number, info: WorktreeInfo): Promise<{ status: "now" | "queued"; waitingFor: string[]; pid: number } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: info.repo, reason: info.jobId }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return undefined;
    const r = (await res.json()) as { status?: string; waitingFor?: string[]; pid?: number };
    return r.status === "now" || r.status === "queued" ? { status: r.status, waitingFor: r.waitingFor ?? [], pid: r.pid ?? 0 } : undefined;
  } catch {
    return undefined;
  }
}

/** PID listening on the port once the restarted server is back (up to ~20 s). `not`: the old server's PID. */
async function waitForPid(port: number, run: Sh, cwd: string, not?: string) {
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    const pid = run(["lsof", "-t", "-sTCP:LISTEN", `-iTCP:${port}`], cwd).out.split("\n")[0];
    if (pid && pid !== not) return pid;
  }
  return undefined;
}

export function summarize(r: LandResult) {
  if (!r.ok) return `not landed: ${r.error}`;
  return [
    `landed ${r.sha} on main and pushed`,
    r.mirror && `mirror ${r.mirror}`,
    r.queuedBehind?.length
      ? `server restart queued behind ${r.queuedBehind.join(", ")} (it restarts itself when they finish)`
      : r.restarted ? `server restarted, PID ${r.pid ?? "unknown (not listening yet)"}` : "no restart needed",
  ].filter(Boolean).join(" · ");
}

if (import.meta.main) {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("usage: whq land <jobId>");
    process.exit(2);
  }
  const file = resolve(config.stateDir, "jobs", jobId, "worktree.json");
  if (!existsSync(file)) {
    console.error(`no worktree for ${jobId} (${file}) — land by hand: scripts/worktree.sh land inside your worktree`);
    process.exit(1);
  }
  const r = await land(JSON.parse(readFileSync(file, "utf8")));
  console.log(summarize(r));
  process.exit(r.ok ? 0 : 1);
}
