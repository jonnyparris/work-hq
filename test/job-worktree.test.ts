import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { land, summarize } from "../src/cli/land.ts";
import { actionPrompt } from "../src/server/prompts.ts";
import { cleanupWorktree, createWorktree, readWorktree, repoFor, slugFor, type WorktreeInfo } from "../src/server/worktrees.ts";
import type { Item } from "../src/shared/types.ts";

// Work jobs on shared repos get a server-made worktree and land with `whq land` (10-20: 97880fc swept another
// job's staged fix; the worktree rule lived only in the prompt, so an agent could skip it).
const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", WORKTREE_LOCK_WAIT: "2" };
Object.assign(process.env, env);

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jobwt-")));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const main = join(root, "repo");
  git(root, "clone", "-q", origin, main);
  git(main, "checkout", "-q", "-b", "main");
  writeFileSync(join(main, "a.ts"), "a\n");
  git(main, "add", "a.ts");
  git(main, "commit", "-q", "-m", "init");
  git(main, "push", "-q", "-u", "origin", "main");
  return { root, origin, main };
}

const item = (p: Partial<Item>): Item => ({ id: "it_1", title: "Fix the thing", kind: "task", status: "inbox", source: { type: "agent" }, createdAt: "", updatedAt: "", ...p }) as Item;
let n = 0;
// Git-heavy tests (setup + worktree + land) take 1.4-3.5 s idle, close to bun's 5 s default once other suites
// run in parallel; worktree.test.ts flaked the same way (10-21, bb78e82).
const SLOW = 30_000;
const jobId = () => `job_t${Date.now().toString(36)}${n++}`;

describe("repoFor", () => {
  const rules = [{ project: "Work-HQ", dir: "/r/whq" }, { match: "^site:", dir: "/r/site", actions: ["work", "draft"] }];
  test("matches the item's project case-insensitively, for work jobs only by default", () => {
    expect(repoFor(item({ project: "work-hq" }), "work", rules)?.dir).toBe("/r/whq");
    expect(repoFor(item({ project: "work-hq" }), "reply", rules)).toBeUndefined();
    expect(repoFor(item({ project: "PAY" }), "work", rules)).toBeUndefined();
  });
  test("or the title regex, for the listed actions", () => {
    expect(repoFor(item({ title: "Site: new post" }), "draft", rules)?.dir).toBe("/r/site");
    expect(repoFor(item({ title: "Site: new post" }), "ticket", rules)).toBeUndefined();
  });
  test("slugs fit worktree.sh", () => {
    expect(slugFor("job_mvgau8kp2ysm3")).toBe("job-mvgau8kp2ysm3");
    expect(slugFor("job_ABC_x")).toMatch(/^[a-z0-9][a-z0-9-]{0,40}$/);
  });
});

describe("server-made worktree", () => {
  test("createWorktree makes job-<id> next to the repo and saves how to land it", async () => {
    const { root, main } = setup();
    const id = jobId();
    const wt = await createWorktree({ dir: main, check: "true" }, id);
    if ("error" in wt) throw new Error(wt.error);
    expect(wt.dir).toBe(join(root, `repo-${slugFor(id)}`));
    expect(git(wt.dir, "symbolic-ref", "--short", "HEAD")).toBe(`wt/${slugFor(id)}`);
    expect(readWorktree(id)).toEqual(wt);
  }, SLOW);

  test("a repo that isn't there gives an error result, not a throw", async () => {
    const wt = await createWorktree({ dir: "/nope/never" }, jobId());
    expect("error" in wt).toBe(true);
  });

  test("the work prompt names the worktree and whq land; a failed one says how to make it by hand", async () => {
    const { main } = setup();
    const id = jobId();
    const wt = await createWorktree({ dir: main, check: "bun test", publish: "scripts/publish.sh github", restart: "true" }, id);
    if ("error" in wt) throw new Error(wt.error);
    const p = actionPrompt(id, item({ project: "work-hq" }), "work", undefined, wt);
    expect(p).toContain(`WORKTREE: Work HQ made ${wt.dir}`);
    expect(p).toContain(`bin/whq land ${id}`);
    expect(p).toContain(`Never edit or commit in ${main} itself`);
    expect(p).toContain("mirror SHA and server PID");
    const failed = actionPrompt(id, item({}), "work", undefined, { repo: main, slug: "job-x", error: "boom" });
    expect(failed).toContain("couldn't\nmake a worktree for it (boom)");
    expect(actionPrompt(id, item({}), "work")).not.toContain("WORKTREE");
  }, SLOW);

  test("cleanup removes an untouched worktree and keeps one with commits", async () => {
    const { main } = setup();
    const a = jobId();
    const b = jobId();
    const wa = (await createWorktree({ dir: main }, a)) as WorktreeInfo;
    const wb = (await createWorktree({ dir: main }, b)) as WorktreeInfo;
    writeFileSync(join(wb.dir, "a.ts"), "b\n");
    git(wb.dir, "commit", "-q", "-am", "b");
    expect(await cleanupWorktree(a)).toBe("removed");
    expect(existsSync(wa.dir)).toBe(false);
    expect(await cleanupWorktree(b)).toBe("kept");
    expect(existsSync(wb.dir)).toBe(true);
  }, SLOW);
});

describe("whq land", () => {
  test("lands, publishes, removes the worktree, restarts on code changes and reports SHA, mirror and PID", async () => {
    const { main, origin } = setup();
    const wt = (await createWorktree({ dir: main, check: "test -f a.ts", publish: "echo published abc1234 '→ github/main'", restart: "true" }, jobId())) as WorktreeInfo;
    writeFileSync(join(wt.dir, "a.ts"), "changed\n");
    git(wt.dir, "commit", "-q", "-am", "change");
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const r = await land(wt, { port: server.port });
      expect(r.ok).toBe(true);
      expect(r.sha).toBe(git(main, "rev-parse", "--short", "HEAD"));
      expect(git(origin, "rev-parse", "main")).toBe(git(main, "rev-parse", "HEAD"));
      expect(readFileSync(join(main, "a.ts"), "utf8")).toBe("changed\n");
      expect(r.mirror).toBe("abc1234");
      expect(r.restarted).toBe(true);
      expect(r.pid).toBe(String(process.pid));
      expect(existsSync(wt.dir)).toBe(false);
      expect(summarize(r)).toContain(`PID ${process.pid}`);
    } finally {
      server.stop(true);
    }
  }, SLOW);

  // 10-21: the server's own checkout asks the server, which holds the restart while a sweep runs.
  test("the server takes the restart: queued behind a sweep, no command run here", async () => {
    const { main } = setup();
    const wt = (await createWorktree({ dir: main, restart: "exit 1" }, jobId())) as WorktreeInfo;
    writeFileSync(join(wt.dir, "a.ts"), "q\n");
    git(wt.dir, "commit", "-q", "-am", "q");
    let asked: any;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        asked = await req.json();
        return Response.json({ status: "queued", waitingFor: ["Read the calendar"], pid: 1 });
      },
    });
    try {
      const r = await land(wt, { port: server.port });
      expect(r.ok).toBe(true);
      expect(asked).toEqual({ repo: main, reason: wt.jobId });
      expect(r.queuedBehind).toEqual(["Read the calendar"]);
      expect(summarize(r)).toContain("restart queued behind Read the calendar");
    } finally {
      server.stop(true);
    }
  }, SLOW);

  test("the server restarts now: waits for a new PID, no command run here", async () => {
    const { main } = setup();
    const wt = (await createWorktree({ dir: main, restart: "exit 1" }, jobId())) as WorktreeInfo;
    writeFileSync(join(wt.dir, "a.ts"), "n\n");
    git(wt.dir, "commit", "-q", "-am", "n");
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: "now", waitingFor: [], pid: 999999 }) });
    try {
      const r = await land(wt, { port: server.port });
      expect(r.ok).toBe(true);
      expect(r.restarted).toBe(true);
      expect(r.pid).toBe(String(process.pid));
    } finally {
      server.stop(true);
    }
  }, SLOW);

  // land.ts restarts after publish itself; worktree.sh mustn't ask the server first.
  test("passes --no-restart to worktree.sh", async () => {
    const { main } = setup();
    const wt = (await createWorktree({ dir: main }, jobId())) as WorktreeInfo;
    const calls: string[][] = [];
    await land(wt, { run: (cmd) => (calls.push(cmd), { ok: false, out: "", err: "stop" }) });
    const landCall = calls.find((c) => c.includes("land"));
    expect(landCall).toContain("--no-restart");
    expect(landCall).toContain("--keep");
  }, SLOW);

  // 11-04: a kickstart killed a job mid-land. A server that is up but slow holds jobs; never run the command over it.
  test("server up but answering 500: no restart command, says how to ask again", async () => {
    const { main } = setup();
    const marker = join(main, "..", "kicked");
    const wt = (await createWorktree({ dir: main, restart: `touch ${marker}` }, jobId())) as WorktreeInfo;
    writeFileSync(join(wt.dir, "a.ts"), "s\n");
    git(wt.dir, "commit", "-q", "-am", "s");
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    try {
      const r = await land(wt, { port: server.port });
      expect(r.ok).toBe(true);
      expect(r.restarted).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(summarize(r)).toContain("server NOT restarted (don't kickstart it): answered 500; ask again: curl -X POST");
    } finally {
      server.stop(true);
    }
  }, SLOW);

  test("server up but silent past 3 s: no restart command", async () => {
    const { main } = setup();
    const marker = join(main, "..", "kicked");
    const wt = (await createWorktree({ dir: main, restart: `touch ${marker}` }, jobId())) as WorktreeInfo;
    writeFileSync(join(wt.dir, "a.ts"), "t\n");
    git(wt.dir, "commit", "-q", "-am", "t");
    const server = Bun.serve({ port: 0, fetch: async () => (await Bun.sleep(5_000), new Response("late")) });
    try {
      const r = await land(wt, { port: server.port });
      expect(r.ok).toBe(true);
      expect(r.restartUnanswered).toStartWith("no answer in 3 s");
      expect(existsSync(marker)).toBe(false);
    } finally {
      server.stop(true);
    }
  }, SLOW);

  test("docs-only change: no restart", async () => {
    const { main } = setup();
    const wt = (await createWorktree({ dir: main, restart: "exit 1" }, jobId())) as WorktreeInfo;
    writeFileSync(join(wt.dir, "README.md"), "docs\n");
    git(wt.dir, "add", "README.md");
    git(wt.dir, "commit", "-q", "-m", "docs");
    const r = await land(wt);
    expect(r.ok).toBe(true);
    expect(r.restarted).toBe(false);
  }, SLOW);

  test("a failed check lands nothing and leaves the worktree for a fix", async () => {
    const { main } = setup();
    const before = git(main, "rev-parse", "HEAD");
    const wt = (await createWorktree({ dir: main, check: "false" }, jobId())) as WorktreeInfo;
    writeFileSync(join(wt.dir, "a.ts"), "x\n");
    git(wt.dir, "commit", "-q", "-am", "x");
    const r = await land(wt);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("check failed");
    expect(git(main, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(wt.dir)).toBe(true);
  }, SLOW);

  test("a failed publish keeps the worktree so a reworded commit can land again", async () => {
    const { main } = setup();
    const wt = (await createWorktree({ dir: main, publish: "echo 'denylist matches' >&2; exit 1" }, jobId())) as WorktreeInfo;
    writeFileSync(join(wt.dir, "a.ts"), "y\n");
    git(wt.dir, "commit", "-q", "-am", "y");
    const r = await land(wt);
    expect(r.ok).toBe(false);
    expect(r.sha).toBeTruthy();
    expect(r.error).toContain("publish failed: denylist matches");
    expect(existsSync(wt.dir)).toBe(true);
  }, SLOW);

  test("a retry after a failed publish still restarts for code the first attempt pushed", async () => {
    const { main } = setup();
    const marker = join(main, "..", "restarted");
    const wt = (await createWorktree({ dir: main, publish: "test -f fixed.md || exit 1", restart: `touch ${marker}` }, jobId())) as WorktreeInfo;
    writeFileSync(join(wt.dir, "a.ts"), "code\n");
    git(wt.dir, "commit", "-q", "-am", "code");
    expect((await land(wt)).ok).toBe(false);
    writeFileSync(join(wt.dir, "fixed.md"), "reworded\n"); // docs-only fix: merge-base with main would see just this
    git(wt.dir, "add", "fixed.md");
    git(wt.dir, "commit", "-q", "-m", "reword");
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const r = await land(readWorktree(wt.jobId)!, { port: server.port });
      expect(r.ok).toBe(true);
      expect(r.restarted).toBe(true);
      expect(existsSync(marker)).toBe(true);
    } finally {
      server.stop(true);
    }
  }, SLOW);
});

describe("pre-commit hook", () => {
  const HOOK = join(import.meta.dir, "..", "scripts", "hooks", "pre-commit");
  const hook = (cwd: string) => {
    const r = Bun.spawnSync(["bash", HOOK], { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  test("warns in the main checkout while another worktree is live, never blocks; quiet in a worktree", async () => {
    const { main } = setup();
    expect(hook(main)).toEqual({ code: 0, err: "" });
    const wt = (await createWorktree({ dir: main }, jobId())) as WorktreeInfo;
    const r = hook(main);
    expect(r.code).toBe(0);
    expect(r.err).toContain("other worktrees are live");
    expect(r.err).toContain(wt.dir);
    expect(hook(wt.dir)).toEqual({ code: 0, err: "" });
  }, SLOW);
});
