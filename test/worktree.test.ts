import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/worktree.sh against throwaway repos: a bare "origin" and a main checkout cloned from it.
// 10-20: two sessions shared ~/dev/work-hq and one commit swept the other's staged hunks.
const SCRIPT = join(import.meta.dir, "..", "scripts", "worktree.sh");
// No WORK_HQ_URL / WORK_HQ_JOB from a Work HQ agent running these tests: they'd point land at the live server.
const { WORK_HQ_URL: _url, WORK_HQ_JOB: _job, ...parentEnv } = process.env;
const env = { ...parentEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", WORKTREE_LOCK_WAIT: "2",
  // land asks Work HQ to restart after code lands; port 1 never answers, so no test pokes the live server on 7717.
  WORK_HQ_PORT: "1" };

function sh(cwd: string, ...cmd: string[]) {
  const r = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
function git(cwd: string, ...args: string[]) {
  const r = sh(cwd, "git", ...args);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
}
const wt = (cwd: string, ...args: string[]) => sh(cwd, "bash", SCRIPT, ...args);
// Each test spawns 10-30 git processes: 1.3-3.5 s idle, past bun's 5 s default when other suites run
// in parallel (10-21: the conflict and lock tests failed a land check at 5017 ms / 5016 ms).
const SLOW = 30_000;
// `wt(main, "new", x).out` is "" on failure, and join("", "a.txt") then writes into the repo running the tests.
function newWt(main: string, slug: string) {
  const r = wt(main, "new", slug);
  if (!r.ok || !r.out) throw new Error(`worktree.sh new ${slug}: ${r.err}`);
  return r.out;
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-test-")));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const main = join(root, "repo");
  git(root, "clone", "-q", origin, main);
  git(main, "checkout", "-q", "-b", "main");
  writeFileSync(join(main, "a.txt"), "a\n");
  writeFileSync(join(main, "b.txt"), "b\n");
  writeFileSync(join(main, ".gitignore"), "node_modules\n");
  mkdirSync(join(main, "node_modules"));
  git(main, "add", "a.txt", "b.txt", ".gitignore");
  git(main, "commit", "-q", "-m", "init");
  git(main, "push", "-q", "-u", "origin", "main");
  return { root, origin, main };
}

describe("worktree.sh", () => {
  test("new makes a sibling worktree on wt/<slug> with node_modules linked and a clean tree", () => {
    const { root, main } = setup();
    const r = wt(main, "new", "fix-x");
    expect(r.ok).toBe(true);
    expect(r.out).toBe(join(root, "repo-fix-x"));
    expect(git(r.out, "symbolic-ref", "--short", "HEAD")).toBe("wt/fix-x");
    expect(existsSync(join(r.out, "node_modules"))).toBe(true);
    expect(git(r.out, "status", "--porcelain")).toBe("");
    expect(wt(main, "new", "fix-x").ok).toBe(false); // slug taken: never reuse another session's dir
    expect(wt(main, "new", "Bad Slug").ok).toBe(false);
  }, SLOW);

  test("land leaves the main checkout's staged edits out of the landed commit", () => {
    const { main, origin } = setup();
    const dir = newWt(main, "mine");
    writeFileSync(join(dir, "a.txt"), "a mine\n");
    git(dir, "commit", "-q", "-am", "mine");
    // Another session, working in the main checkout, has a staged hunk in a different file.
    writeFileSync(join(main, "b.txt"), "b theirs\n");
    git(main, "add", "b.txt");

    const r = wt(dir, "land");
    expect(r.err + r.out).toContain("landed");
    expect(r.ok).toBe(true);
    expect(git(main, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt");
    expect(git(main, "diff", "--cached", "--name-only")).toBe("b.txt"); // still staged, still theirs
    expect(readFileSync(join(main, "a.txt"), "utf8")).toBe("a mine\n");
    expect(git(origin, "rev-parse", "main")).toBe(git(main, "rev-parse", "HEAD"));
    expect(existsSync(dir)).toBe(false);
    expect(sh(main, "git", "show-ref", "--verify", "refs/heads/wt/mine").ok).toBe(false);
  }, SLOW);

  test("two worktrees land one after the other: the second rebases onto the first", () => {
    const { main } = setup();
    const one = newWt(main, "one");
    const two = newWt(main, "two");
    writeFileSync(join(one, "a.txt"), "a one\n");
    git(one, "commit", "-q", "-am", "one");
    writeFileSync(join(two, "b.txt"), "b two\n");
    git(two, "commit", "-q", "-am", "two");
    expect(wt(one, "land").ok).toBe(true);
    expect(wt(two, "land").ok).toBe(true);
    expect(git(main, "log", "--format=%s", "-3").split("\n")).toEqual(["two", "one", "init"]);
  }, SLOW);

  test("land refuses a dirty worktree, a failing check, and the main checkout", () => {
    const { main } = setup();
    const dir = newWt(main, "guard");
    writeFileSync(join(dir, "a.txt"), "dirty\n");
    expect(wt(dir, "land").err).toContain("dirty");
    git(dir, "commit", "-q", "-am", "guard");
    const before = git(main, "rev-parse", "HEAD");
    const r = wt(dir, "land", "--check", "exit 1");
    expect(r.ok).toBe(false);
    expect(r.err).toContain("check failed");
    expect(git(main, "rev-parse", "HEAD")).toBe(before); // nothing landed
    expect(existsSync(dir)).toBe(true);
    expect(wt(main, "land").err).toContain("inside your worktree");
  }, SLOW);

  test("land stops on a rebase conflict and lands nothing", () => {
    const { main } = setup();
    const one = newWt(main, "c1");
    const two = newWt(main, "c2");
    writeFileSync(join(one, "a.txt"), "one\n");
    git(one, "commit", "-q", "-am", "one");
    writeFileSync(join(two, "a.txt"), "two\n");
    git(two, "commit", "-q", "-am", "two");
    expect(wt(one, "land").ok).toBe(true);
    const head = git(main, "rev-parse", "HEAD");
    const r = wt(two, "land");
    expect(r.ok).toBe(false);
    expect(r.err).toContain("conflicts");
    expect(git(main, "rev-parse", "HEAD")).toBe(head);
    expect(git(two, "status", "--porcelain")).toBe(""); // rebase aborted, worktree intact
  }, SLOW);

  test("a land with --check releases the land lock", () => {
    // 10-22: the check step reused $lock for the test-lock wrapper, so the EXIT trap removed the wrong
    // path and every `land --check` left .git/worktree-land.lock behind for the next lander.
    const { main } = setup();
    const dir = newWt(main, "checked");
    writeFileSync(join(dir, "a.txt"), "c\n");
    git(dir, "commit", "-q", "-am", "c");
    const r = wt(dir, "land", "--keep", "--check", "true");
    expect(r.ok).toBe(true);
    expect(existsSync(join(main, ".git", "worktree-land.lock"))).toBe(false);
  }, SLOW);

  test("land waits for, then refuses, a lock held by another lander", () => {
    const { main } = setup();
    const dir = newWt(main, "locked");
    writeFileSync(join(dir, "a.txt"), "x\n");
    git(dir, "commit", "-q", "-am", "x");
    mkdirSync(join(main, ".git", "worktree-land.lock"));
    writeFileSync(join(main, ".git", "worktree-land.lock", "owner"), `wt/other pid ${process.pid}\n`); // alive: this test runner
    const r = wt(dir, "land");
    expect(r.ok).toBe(false);
    expect(r.err).toContain("wt/other");
  }, SLOW);

  test("land takes over a lock whose owner process is gone", () => {
    // 10-22: wt/test-lock-gate (pid 17677) died holding the lock; every later land waited 120 s and died.
    const { main, origin } = setup();
    const dir = newWt(main, "stale");
    writeFileSync(join(dir, "a.txt"), "s\n");
    git(dir, "commit", "-q", "-am", "s");
    const dead = Bun.spawnSync(["true"]).pid; // exited and reaped, so nothing runs under this pid
    mkdirSync(join(main, ".git", "worktree-land.lock"));
    writeFileSync(join(main, ".git", "worktree-land.lock", "owner"), `wt/gone pid ${dead}\n`);
    const r = wt(dir, "land", "--keep");
    expect(r.ok).toBe(true);
    expect(r.err).toContain("took over a stale land lock (wt/gone");
    expect(git(origin, "rev-parse", "main")).toBe(git(main, "rev-parse", "HEAD"));
    expect(existsSync(join(main, ".git", "worktree-land.lock"))).toBe(false);
  }, SLOW);

  // 11-04: an agent kickstarted the server after a land and killed another job mid-land. land now asks the server
  // (POST /api/restart, src/server/restart.ts), which holds the restart while headless jobs run.
  describe("restart after land", () => {
    // Async spawn: the fake server answers from this process, which spawnSync would block.
    async function landAsync(cwd: string, port: number, ...args: string[]) {
      const p = Bun.spawn(["bash", SCRIPT, "land", ...args], { cwd, env: { ...env, WORK_HQ_PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { ok: (await p.exited) === 0, out: out.trim(), err: err.trim() };
    }
    function fake(answer: (b: any) => Response) {
      const asked: any[] = [];
      const server = Bun.serve({ port: 0, fetch: async (req) => {
        const b = await req.json();
        asked.push({ path: new URL(req.url).pathname, method: req.method, ...b });
        return answer(b);
      } });
      return { asked, server };
    }
    // land asks only for a Work HQ checkout (src/server/restart.ts present).
    function workHq() {
      const t = setup();
      mkdirSync(join(t.main, "src", "server"), { recursive: true });
      writeFileSync(join(t.main, "src", "server", "restart.ts"), "// gate\n");
      git(t.main, "add", "src");
      git(t.main, "commit", "-q", "-m", "work hq");
      git(t.main, "push", "-q", "origin", "main");
      return t;
    }
    function change(main: string, slug: string, file = "a.ts") {
      const dir = newWt(main, slug);
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), `${slug}\n`);
      git(dir, "add", file);
      git(dir, "commit", "-q", "-m", slug);
      return dir;
    }

    test("code landed while a headless job runs: queued at the server, no restart here", async () => {
      const { main } = workHq();
      const dir = change(main, "q");
      const { asked, server } = fake(() => Response.json({ status: "queued", waitingFor: ["Read the calendar", "Triage"], pid: 1 }));
      try {
        const r = await landAsync(dir, server.port!);
        expect(r.ok).toBe(true);
        expect(r.out).toContain("landed");
        expect(asked).toEqual([{ path: "/api/restart", method: "POST", repo: main, reason: "wt/q" }]);
        expect(r.out).toContain("server restart: queued behind Read the calendar, Triage");
      } finally {
        server.stop(true);
      }
    }, SLOW);

    test("no headless job: the server restarts now", async () => {
      const { main } = workHq();
      const dir = change(main, "n");
      const { asked, server } = fake(() => Response.json({ status: "now", waitingFor: [], pid: 1 }));
      try {
        const r = await landAsync(dir, server.port!, "--keep");
        expect(r.ok).toBe(true);
        expect(asked).toHaveLength(1);
        expect(r.out).toContain("server restart: now");
      } finally {
        server.stop(true);
      }
    }, SLOW);

    test("409 (not the server's checkout): lands, no restart", async () => {
      const { main } = workHq();
      const dir = change(main, "other");
      const { asked, server } = fake(() => Response.json({ error: "not this server's checkout" }, { status: 409 }));
      try {
        const r = await landAsync(dir, server.port!);
        expect(r.ok).toBe(true);
        expect(asked).toHaveLength(1);
        expect(r.err).toContain("server restart: none");
      } finally {
        server.stop(true);
      }
    }, SLOW);

    test("docs/test-only changes and --no-restart never ask", async () => {
      const { main } = workHq();
      const { asked, server } = fake(() => Response.json({ status: "now", waitingFor: [], pid: 1 }));
      try {
        expect((await landAsync(change(main, "docs", "docs/x.md"), server.port!)).ok).toBe(true);
        expect((await landAsync(change(main, "tests", "test/x.test.ts"), server.port!)).ok).toBe(true);
        expect((await landAsync(change(main, "skip"), server.port!, "--no-restart")).ok).toBe(true);
        expect(asked).toEqual([]);
      } finally {
        server.stop(true);
      }
    }, SLOW);

    test("a Work HQ job sends its id, so the gate knows which blocker is the job asking", async () => {
      const { main } = workHq();
      const dir = change(main, "job");
      const { asked, server } = fake(() => Response.json({ status: "now", waitingFor: [], pid: 1 }));
      try {
        const p = Bun.spawn(["bash", SCRIPT, "land"], { cwd: dir, env: { ...env, WORK_HQ_PORT: String(server.port), WORK_HQ_JOB: "job_abc" }, stdout: "pipe", stderr: "pipe" });
        expect(await p.exited).toBe(0);
        expect(asked.map((a) => a.reason)).toEqual(["job_abc"]);
      } finally {
        server.stop(true);
      }
    }, SLOW);

    test("not a Work HQ checkout: never asks", async () => {
      const { main } = setup();
      const { asked, server } = fake(() => Response.json({ status: "now", waitingFor: [], pid: 1 }));
      try {
        const r = await landAsync(change(main, "plain"), server.port!);
        expect(r.ok).toBe(true);
        expect(asked).toEqual([]);
        expect(r.err + r.out).not.toContain("server restart");
      } finally {
        server.stop(true);
      }
    }, SLOW);

    test("server answers 500: landed, says how to ask again", async () => {
      const { main } = workHq();
      const { asked, server } = fake(() => new Response("boom", { status: 500 }));
      try {
        const r = await landAsync(change(main, "err"), server.port!);
        expect(r.ok).toBe(true);
        expect(asked).toHaveLength(1);
        expect(r.err).toContain("didn't take it (500)");
        expect(r.err).toContain("/api/restart");
      } finally {
        server.stop(true);
      }
    }, SLOW);

    test("code from origin that the catch-up brings in counts, even under a docs-only branch", async () => {
      const { root, main, origin } = workHq();
      const other = join(root, "other");
      git(root, "clone", "-q", origin, other);
      writeFileSync(join(other, "server.ts"), "new code\n");
      git(other, "add", "server.ts");
      git(other, "commit", "-q", "-m", "elsewhere");
      git(other, "push", "-q", "origin", "main");
      const dir = change(main, "docsonly", "README.md");
      const { asked, server } = fake(() => Response.json({ status: "now", waitingFor: [], pid: 1 }));
      try {
        expect((await landAsync(dir, server.port!)).ok).toBe(true);
        expect(asked).toHaveLength(1);
      } finally {
        server.stop(true);
      }
    }, SLOW);

    test("server not answering: still landed, exit 0, says so", async () => {
      const { main, origin } = workHq();
      const r = await landAsync(change(main, "down"), 1);
      expect(r.ok).toBe(true);
      expect(r.err).toContain("Work HQ at http://127.0.0.1:1 didn't take it (000)");
      expect(r.err).toContain("don't kickstart");
      expect(git(origin, "rev-parse", "main")).toBe(git(main, "rev-parse", "HEAD"));
    }, SLOW);
  });
});
