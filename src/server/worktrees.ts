// Server-made worktrees for work jobs on shared repos (config `repos`).
//
// Two sessions committing in one checkout sweep each other's staged hunks (10-20: a reply-claim fix landed
// inside 97880fc). The work prompt used to ask agents to make a worktree; one that skipped the line still
// committed in the main checkout. Now the server makes it before launch, the prompt names it, and
// `whq land <jobId>` (src/cli/land.ts) lands, publishes, cleans up and restarts in one step.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ActionKind, Item } from "../shared/types.ts";
import { jobDir } from "./cmux.ts";
import { config, ROOT, type RepoRule } from "./config.ts";

export const WORKTREE_SCRIPT = resolve(ROOT, "scripts/worktree.sh");

/** What a job's worktree is and how to land it. Saved as <jobDir>/worktree.json for `whq land`. */
export interface WorktreeInfo {
  jobId: string;
  repo: string;
  dir: string;
  branch: string;
  /** The commit the worktree started from. `whq land` diffs from here, so a retry after a failed publish still restarts for code the first attempt already pushed. */
  base?: string;
  check?: string;
  publish?: string;
  restart?: string;
}

export type WorktreeResult = WorktreeInfo | { repo: string; slug: string; error: string };

/** The repo rule for this item and action, if any. */
export function repoFor(item: Pick<Item, "project" | "title">, action: ActionKind, rules: RepoRule[] = config.repos): RepoRule | undefined {
  return rules.find((r) => {
    if (!r.dir || !(r.actions ?? ["work"]).includes(action)) return false;
    if (r.project && item.project?.toLowerCase() === r.project.toLowerCase()) return true;
    if (r.match) {
      try {
        return new RegExp(r.match, "i").test(item.title);
      } catch {
        return false;
      }
    }
    return false;
  });
}

/** job_mvgau8kp2ysm3 → job-mvgau8kp2ysm3 (worktree.sh slugs: lowercase, digits, hyphens). */
export function slugFor(jobId: string) {
  return `job-${jobId.replace(/^job_/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 40);
}

const infoPath = (jobId: string) => resolve(jobDir(jobId), "worktree.json");

export function readWorktree(jobId: string): WorktreeInfo | undefined {
  try {
    return JSON.parse(readFileSync(infoPath(jobId), "utf8"));
  } catch {
    return undefined;
  }
}

async function run(cmd: string[], cwd: string) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

/** `worktree.sh new job-<id>` in the rule's repo. Never throws: an error result tells the prompt to make one by hand. */
export async function createWorktree(rule: RepoRule, jobId: string, script = WORKTREE_SCRIPT): Promise<WorktreeResult> {
  const slug = slugFor(jobId);
  if (!existsSync(rule.dir)) return { repo: rule.dir, slug, error: `${rule.dir} doesn't exist` };
  const r = await run(["bash", script, "new", slug], rule.dir);
  const dir = r.out.split("\n").pop() ?? "";
  if (!r.ok || !dir || !existsSync(dir)) return { repo: rule.dir, slug, error: (r.err || r.out || "worktree.sh new failed").split("\n").pop()! };
  const base = (await run(["git", "rev-parse", "HEAD"], dir)).out || undefined;
  const info: WorktreeInfo = { jobId, repo: rule.dir, dir, branch: `wt/${slug}`, base, check: rule.check, publish: rule.publish, restart: rule.restart };
  writeFileSync(infoPath(jobId), JSON.stringify(info, null, 2));
  return info;
}

/**
 * When a job ends: remove its worktree if the agent left nothing in it (clean, no commits past main).
 * Anything else stays — unlanded commits or edits are the owner's to look at. Returns what happened.
 */
export async function cleanupWorktree(jobId: string): Promise<"removed" | "kept" | undefined> {
  const info = readWorktree(jobId);
  if (!info || !existsSync(info.dir)) return undefined;
  const status = await run(["git", "status", "--porcelain"], info.dir);
  const ahead = await run(["git", "rev-list", "--count", `main..${info.branch}`], info.repo);
  if (!status.ok || status.out || !ahead.ok || ahead.out !== "0") return "kept";
  const rm = await run(["git", "worktree", "remove", info.dir], info.repo);
  if (!rm.ok) return "kept";
  await run(["git", "branch", "-q", "-D", info.branch], info.repo); // 0 ahead, so nothing is lost
  return "removed";
}
