import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/worktree.sh against throwaway repos: a bare "origin" and a main checkout cloned from it.
// 10-20: two sessions shared ~/dev/work-hq and one commit swept the other's staged hunks.
const SCRIPT = join(import.meta.dir, "..", "scripts", "worktree.sh");
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", WORKTREE_LOCK_WAIT: "2" };

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
  });

  test("land leaves the main checkout's staged edits out of the landed commit", () => {
    const { main, origin } = setup();
    const dir = wt(main, "new", "mine").out;
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
  });

  test("two worktrees land one after the other: the second rebases onto the first", () => {
    const { main } = setup();
    const one = wt(main, "new", "one").out;
    const two = wt(main, "new", "two").out;
    writeFileSync(join(one, "a.txt"), "a one\n");
    git(one, "commit", "-q", "-am", "one");
    writeFileSync(join(two, "b.txt"), "b two\n");
    git(two, "commit", "-q", "-am", "two");
    expect(wt(one, "land").ok).toBe(true);
    expect(wt(two, "land").ok).toBe(true);
    expect(git(main, "log", "--format=%s", "-3").split("\n")).toEqual(["two", "one", "init"]);
  });

  test("land refuses a dirty worktree, a failing check, and the main checkout", () => {
    const { main } = setup();
    const dir = wt(main, "new", "guard").out;
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
  });

  test("land stops on a rebase conflict and lands nothing", () => {
    const { main } = setup();
    const one = wt(main, "new", "c1").out;
    const two = wt(main, "new", "c2").out;
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
  });

  test("land waits for, then refuses, a lock held by another lander", () => {
    const { main } = setup();
    const dir = wt(main, "new", "locked").out;
    writeFileSync(join(dir, "a.txt"), "x\n");
    git(dir, "commit", "-q", "-am", "x");
    mkdirSync(join(main, ".git", "worktree-land.lock"));
    writeFileSync(join(main, ".git", "worktree-land.lock", "owner"), "wt/other pid 1\n");
    const r = wt(dir, "land");
    expect(r.ok).toBe(false);
    expect(r.err).toContain("wt/other");
  });
});
