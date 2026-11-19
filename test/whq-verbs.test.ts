// `bin/whq` verbs vs the shell scripts that call them. A removed verb exits 2, and launchd scripts call whq behind
// `>/dev/null || true`, so a card they post vanishes with no error (11-06: `whq pineapple` went, three callers
// kept calling it). An unknown verb says so on stderr, and the caller scan fails when a verb goes while a shell
// script in a listed caller dir still calls it as a literal `bin/whq <verb>`. The list is personal, so it lives in
// config: $WORK_HQ_CALLERS_FILE or ~/.config/work-hq/whq-callers.txt, one dir per line (`~/`, absolute, or relative
// to the file; `#` comments). No default file: the scan shows as skipped. A named file that's missing, an empty
// list, a listed dir that's gone or has no whq calls: fails. Not covered: $WHQ-style variables, plists, TS callers.
import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const WHQ = join(import.meta.dir, "..", "bin", "whq");

/** The verbs bin/whq's top-level `case` handles: labels indented exactly two spaces, `a|b|c` alternatives split,
 *  flags (`-h`, `--help`) dropped. Nested cases indent further and aren't verbs. */
function verbs(src = readFileSync(WHQ, "utf8")): Set<string> {
  return new Set(
    [...src.matchAll(/^ {2}([-a-z|]+)\)/gm)].flatMap(([, label]) =>
      (label ?? "").split("|").filter((v) => /^[a-z][a-z-]*$/.test(v)),
    ),
  );
}

/** Every literal `bin/whq <verb>` call in shell source, with the 1-based line it starts on. `\` continuations are
 *  joined; `#` comments (whole-line or trailing) are dropped. */
function whqCalls(src: string): { line: number; verb: string }[] {
  const out: { line: number; verb: string }[] = [];
  // Comments go first, per physical line: bash doesn't continue a comment that ends in `\`.
  const lines = src.split("\n").map((l) => l.replace(/(^|\s)#.*$/, ""));
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let text = lines[i] ?? "";
    while (text.endsWith("\\") && i + 1 < lines.length) text = text.slice(0, -1) + " " + (lines[++i] ?? "");
    for (const [, verb] of text.matchAll(/bin\/whq["']?\s+([a-z][a-z-]*)/g)) if (verb) out.push({ line: start + 1, verb });
  }
  return out;
}

/** The calls in `files` to a verb not in `known`, as `path:line: whq verb`. */
function unknownCalls(files: { path: string; src: string }[], known: Set<string>): string[] {
  return files.flatMap(({ path, src }) =>
    whqCalls(src).filter(({ verb }) => !known.has(verb)).map(({ line, verb }) => `${path}:${line}: whq ${verb}`),
  );
}

test("bin/whq's verbs, help alias included", () => {
  expect([...verbs()].sort()).toEqual(["access-login", "access-ok", "help", "journal", "land", "recheck", "report", "say", "sync"]);
  expect(verbs("  -h|--help|help) usage ;;\n      -x|--y) z ;;\n  go) ;;\n")).toEqual(new Set(["help", "go"]));
});

test("whqCalls: double/single quoted or bare paths; comments skipped", () => {
  const src = [
    `"$HOME/dev/work-hq/bin/whq" say --from x "hi" >/dev/null || true`,
    `  # see bin/whq for usage`,
    `'$HOME/dev/work-hq/bin/whq' access-ok "$APP"`,
    `perl -e 'alarm 300; exec @ARGV' ~/dev/work-hq/bin/whq pineapple "$1"`,
    `x || true  # bin/whq pineapple was removed`,
    `[ "$N" = 1 ] || "$HOME/dev/work-hq/bin/whq" \\`,
    `  pineapple "wrapped" \\`,
    `  >/dev/null`,
    `# old note \\`,
    `"$HOME/dev/work-hq/bin/whq" pineapple "after a comment"`,
  ].join("\n");
  expect(whqCalls(src)).toEqual([
    { line: 1, verb: "say" },
    { line: 3, verb: "access-ok" },
    { line: 4, verb: "pineapple" },
    { line: 6, verb: "pineapple" },
    { line: 10, verb: "pineapple" },
  ]);
  // A removed verb is reported; live ones aren't.
  expect(unknownCalls([{ path: "run.sh", src }], verbs())).toEqual(["run.sh:4: whq pineapple", "run.sh:6: whq pineapple", "run.sh:10: whq pineapple"]);
});

test("an unknown verb exits 2 with the reason and usage on stderr, nothing on stdout", () => {
  const r = Bun.spawnSync([WHQ, "pineapple", "hello"], { env: { ...process.env, WORK_HQ_URL: "http://127.0.0.1:9" } });
  expect(r.exitCode).toBe(2);
  expect(r.stdout.toString()).toBe("");
  const err = r.stderr.toString();
  expect(err).toContain("whq: unknown verb 'pineapple'");
  expect(err).toContain("whq report <jobId>");
  expect(err).not.toContain("set -euo");
});

test("--help / -h / help: usage on stdout, exit 0", () => {
  for (const flag of ["--help", "-h", "help"]) {
    const r = Bun.spawnSync([WHQ, flag]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe("");
    const out = r.stdout.toString();
    expect(out).toContain("whq report <jobId>");
    for (const v of verbs()) if (v !== "help") expect(out).toContain(`whq ${v}`);
    expect(out).not.toContain("set -euo");
  }
});

test("no verb: usage on stderr, exit 2", () => {
  const r = Bun.spawnSync([WHQ]);
  expect(r.exitCode).toBe(2);
  expect(r.stdout.toString()).toBe("");
  expect(r.stderr.toString()).not.toContain("unknown verb");
  expect(r.stderr.toString()).toContain("whq say");
});

/** whq-callers.txt → absolute dirs: one per line; `~/` is home, relative is next to the file; blank lines and
 *  `#` comments (line start or after whitespace, so a path may hold a `#`) dropped. */
function callerDirs(text: string, base: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean)
    .map((d) => (d === "~" || d.startsWith("~/") ? resolve(join(homedir(), d.slice(2))) : resolve(base, d))); // resolve normalises `/x/`, `/x/./y`
}

/** null: no list, skip. `error`: a list was asked for but can't be used, fail. A named file (`explicit`) or one
 *  that's there but unreadable (dangling link, a dir) is an error; only an absent default file means no list. */
function loadCallers(file: string, explicit: boolean): { dirs: string[] } | { error: string } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    let there = true; // a stat that throws (ENOTDIR, EACCES) means something's in the way: report it
    try {
      there = Boolean(lstatSync(file, { throwIfNoEntry: false }));
    } catch {}
    return explicit || there ? { error: `${file}: ${e instanceof Error ? e.message : String(e)}` } : null;
  }
  let real = file; // the list is often a dotfiles symlink: relative entries sit next to the real file
  try {
    real = realpathSync(file);
  } catch {}
  const dirs = callerDirs(text, dirname(real));
  return dirs.length ? { dirs } : { error: `${file} lists no dirs` };
}

/** Listed dirs that are gone, not dirs, or whose `*.sh` hold no whq call (each is listed because its scripts call
 *  whq, so one with none means the list or the scan is broken). */
function brokenDirs(dirs: string[], files: { path: string; src: string }[]): string[] {
  return dirs.flatMap((d) => {
    if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) return [`${d}: not a dir`];
    return files.some((f) => f.path.startsWith(d + sep) && whqCalls(f.src).length > 0) ? [] : [`${d}: no whq calls in *.sh`];
  });
}

const NAMED = process.env.WORK_HQ_CALLERS_FILE;
const CALLERS = loadCallers(NAMED ?? join(homedir(), ".config", "work-hq", "whq-callers.txt"), NAMED !== undefined);
const SKIP = new Set(["node_modules", ".venv", ".git", "out"]);

function shellFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) shellFiles(p, out);
    else if (name.endsWith(".sh") && !name.endsWith(".test.sh")) out.push(p);
  }
  return out;
}

test("callerDirs / loadCallers: paths, comments, missing and empty lists", () => {
  const dir = mkdtempSync(join(tmpdir(), "whq-callers-"));
  expect(callerDirs("# scripts that call whq\n~/a/scripts/\n\n/abs/b/  # trailing\nrel/c\n/x/#1\n/y/./z\n~\n~//h\n~foo/x\n", "/base")).toEqual([
    join(homedir(), "a/scripts"),
    "/abs/b",
    "/base/rel/c",
    "/x/#1",
    "/y/z",
    homedir(),
    join(homedir(), "h"),
    "/base/~foo/x",
  ]);
  const missing = join(dir, "nope.txt");
  expect(loadCallers(missing, false)).toBeNull();
  expect(loadCallers(missing, true)).toMatchObject({ error: expect.stringContaining(missing) });
  writeFileSync(join(dir, "empty.txt"), "# nothing yet\n\n");
  expect(loadCallers(join(dir, "empty.txt"), false)).toEqual({ error: `${join(dir, "empty.txt")} lists no dirs` });
  writeFileSync(join(dir, "list.txt"), "scripts\n");
  expect(loadCallers(join(dir, "list.txt"), false)).toEqual({ dirs: [join(realpathSync(dir), "scripts")] }); // macOS: /var → /private/var
  expect(loadCallers(dir, false)).toMatchObject({ error: expect.stringContaining(dir) }); // a dir, not a file
  symlinkSync(join(dir, "gone"), join(dir, "dangling.txt"));
  expect(loadCallers(join(dir, "dangling.txt"), false)).toMatchObject({ error: expect.any(String) });
  expect(loadCallers(join(dir, "list.txt", "x.txt"), true)).toMatchObject({ error: expect.any(String) }); // ENOTDIR
  mkdirSync(join(dir, "real"));
  writeFileSync(join(dir, "real", "list.txt"), "scripts\n");
  symlinkSync(join(dir, "real", "list.txt"), join(dir, "linked.txt"));
  expect(loadCallers(join(dir, "linked.txt"), false)).toEqual({ dirs: [join(realpathSync(dir), "real", "scripts")] });

  // brokenDirs: a dir with a call passes (trailing slash normalised); one without, a file, a missing path fail.
  mkdirSync(join(dir, "calls"));
  mkdirSync(join(dir, "quiet"));
  const files = [
    { path: join(dir, "calls", "run.sh"), src: `"$HOME/dev/work-hq/bin/whq" say "hi"` },
    { path: join(dir, "quiet", "run.sh"), src: "echo hi" },
  ];
  const listed = callerDirs(`calls/\nquiet\nlist.txt\nmissing\n`, dir);
  expect(brokenDirs(listed, files)).toEqual([
    `${join(dir, "quiet")}: no whq calls in *.sh`,
    `${join(dir, "list.txt")}: not a dir`,
    `${join(dir, "missing")}: not a dir`,
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(CALLERS === null)("every literal `bin/whq <verb>` in the listed caller dirs' **/*.sh is a verb bin/whq still has", () => {
  if (!CALLERS || "error" in CALLERS) throw new Error(CALLERS?.error ?? "no caller list");
  const dirs = CALLERS.dirs.filter((d) => statSync(d, { throwIfNoEntry: false })?.isDirectory());
  const files = dirs.flatMap((d) => shellFiles(d)).map((path) => ({ path, src: readFileSync(path, "utf8") }));
  // A stale list (gone, not a dir, no calls): fix whq-callers.txt rather than scan less.
  expect(brokenDirs(CALLERS.dirs, files)).toEqual([]);
  expect(unknownCalls(files, verbs())).toEqual([]);
});
