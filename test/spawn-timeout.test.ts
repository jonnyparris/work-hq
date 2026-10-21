import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A test that spawns git or bash needs its own timeout. Git-heavy tests take 1.3-3.5 s idle and pass bun's 5 s
// default once other suites run in parallel (10-21: worktree.test.ts failed a land check at 5017 ms; bb78e82, 2d8320f).
// A global `timeout` in bunfig.toml would make every hung test take that long to fail, so this flags each test instead.

const SPAWN = /\b(?:Bun\.spawnSync|Bun\.spawn|spawnSync|spawn|execSync|execFileSync|exec|execFile)\s*\(/;
const SHELL = /["'`](?:git|bash|sh)\b/;
const BUN_SHELL = /\$`\s*(?:git|bash|sh)\b/;

// Index just past the string, template, comment or regex starting at i, or i when there isn't one there.
function skip(src: string, i: number): number {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") return (src.indexOf("\n", i) + 1 || src.length + 1) - 1;
  if (c === "/" && src[i + 1] === "*") return src.indexOf("*/", i + 2) + 2;
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (c === "`") {
    let j = i + 1;
    while (j < src.length && src[j] !== "`") {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "$" && src[j + 1] === "{") j = close(src, j + 1) + 1;
      else j++;
    }
    return j + 1;
  }
  if (c === "/" && /[(,=:[!&|?{};]\s*$|^\s*$|\breturn\s*$/.test(src.slice(Math.max(0, i - 20), i))) {
    let j = i + 1;
    let cls = false;
    while (j < src.length && (cls || src[j] !== "/") && src[j] !== "\n") {
      if (src[j] === "\\") j++;
      else if (src[j] === "[") cls = true;
      else if (src[j] === "]") cls = false;
      j++;
    }
    return j + 1;
  }
  return i;
}

// Index of the bracket that closes the one at `open`.
function close(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < src.length; ) {
    const j = skip(src, i);
    if (j !== i) {
      i = j;
      continue;
    }
    const c = src[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      stack.pop();
      if (!stack.length) return i;
    }
    i++;
  }
  return src.length;
}

// Top-level comma-separated pieces of the argument list between parens at open/end.
function args(src: string, open: number, end: number): string[] {
  const out: string[] = [];
  let start = open + 1;
  for (let i = start; i < end; ) {
    const j = skip(src, i);
    if (j !== i) {
      i = j;
      continue;
    }
    if ("([{".includes(src[i])) {
      i = close(src, i) + 1;
      continue;
    }
    if (src[i] === ",") {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  out.push(src.slice(start, end).trim());
  return out.filter(Boolean);
}

// Named helpers in the file with their bodies: `function f(...) {...}` and `const f = (...) => ...`.
function helpers(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
    const params = close(src, m.index! + m[0].length - 1);
    const open = src.indexOf("{", params);
    out.set(m[1], src.slice(open, close(src, open) + 1));
  }
  for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*(?:async\s*)?(\(|\w+\s*=>)/g)) {
    let i = m.index! + m[0].length - 1;
    if (m[2] === "(") i = close(src, i) + 1;
    const arrow = src.slice(i).match(/^\s*(?::[^=]*?)?=>\s*/);
    if (!arrow) continue;
    i += arrow[0].length;
    if (src[i] === "{") out.set(m[1], src.slice(i, close(src, i) + 1));
    else {
      let j = i;
      while (j < src.length && src[j] !== ";" && src[j] !== "\n") j = skip(src, j) !== j ? skip(src, j) : "([{".includes(src[j]) ? close(src, j) + 1 : j + 1;
      out.set(m[1], src.slice(i, j));
    }
  }
  return out;
}

const calls = (body: string, name: string) => new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(body);
// Calls a spawn wrapper with "git"/"bash" as an argument: git = (...) => sh(cwd, "git", ...args).
const callsWithShell = (body: string, name: string) =>
  [...body.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g"))].some((m) => {
    const open = m.index! + m[0].length - 1;
    return SHELL.test(body.slice(open, close(body, open) + 1));
  });

// Helpers that end up running git or bash, directly or through another helper.
function spawners(fns: Map<string, string>): Set<string> {
  const wrappers = [...fns].filter(([, b]) => SPAWN.test(b)).map(([n]) => n);
  const out = new Set<string>();
  for (const [n, b] of fns) if ((SPAWN.test(b) && SHELL.test(b)) || BUN_SHELL.test(b) || wrappers.some((w) => w !== n && callsWithShell(b, w))) out.add(n);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [n, b] of fns) if (!out.has(n) && [...out].some((s) => calls(b, s))) out.add(n), (grew = true);
  }
  return out;
}

const hasTimeout = (a: string[]) => a.length >= 3 || a.some((x) => /^\{[^]*\btimeout\b/.test(x));

/** Names of tests that run git/bash without their own timeout. */
export function untimed(src: string): string[] {
  if (!SPAWN.test(src) && !BUN_SHELL.test(src)) return [];
  if (/\bsetDefaultTimeout\s*\(/.test(src)) return [];
  const fns = helpers(src);
  const sp = spawners(fns);
  const wrappers = [...fns].filter(([, b]) => SPAWN.test(b)).map(([n]) => n);
  const out: string[] = [];
  for (const m of src.matchAll(/(?<![\w.])(?:test|it)(?:\.(?:only|serial|concurrent))?\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const end = close(src, open);
    const a = args(src, open, end);
    const body = a.slice(1).join(",");
    const spawns = (SPAWN.test(body) && SHELL.test(body)) || BUN_SHELL.test(body) || [...sp].some((s) => calls(body, s)) || wrappers.some((w) => callsWithShell(body, w));
    if (spawns && !hasTimeout(a)) out.push(a[0] ?? "?");
  }
  return out;
}

describe("untimed", () => {
  const helper = `function git(cwd, ...a) { return Bun.spawnSync(["git", ...a], { cwd }); }\nconst setup = () => { git("/", "init"); };\n`;
  test("flags a test that runs git through a helper with no timeout", () => {
    expect(untimed(`${helper}test("a", () => { setup(); });`)).toEqual([`"a"`]);
  });
  test("a timeout argument or options object passes", () => {
    expect(untimed(`${helper}const SLOW = 30_000;\ntest("a", () => { setup(); }, SLOW);\ntest("b", async () => { git("/", "log"); }, { timeout: 9000 });`)).toEqual([]);
  });
  test("follows a generic wrapper called with bash, and inline spawns", () => {
    const src = `function sh(cwd, ...cmd) { return Bun.spawnSync(cmd, { cwd }); }\nconst wt = (cwd, ...a) => sh(cwd, "bash", "x.sh", ...a);\n`;
    expect(untimed(`${src}test("w", () => { wt("/"); });\ntest("i", () => { Bun.spawnSync(["bash", "-c", "true"]); });`)).toEqual([`"w"`, `"i"`]);
  });
  test("tests that don't spawn git/bash, or spawn something else, are left alone", () => {
    expect(untimed(`${helper}test("pure", () => { expect(1).toBe(1); });\ntest("bun", () => { Bun.spawn(["bun", "x.ts"]); });`)).toEqual([]);
  });
  test("template literals with \${} and regexes with quotes don't throw the parser off", () => {
    const src = `${helper}test(\`"\${x}" → y\`, () => { expect(/["')]/.test("a")).toBe(false); setup(); });\ntest("ok", () => setup(), 5);`;
    expect(untimed(src)).toEqual(["`\"${x}\" → y`"]);
  });
});

test("every test that runs git or bash sets its own timeout (e.g. `}, SLOW);` with SLOW = 30_000)", () => {
  const dir = import.meta.dir;
  const bad = readdirSync(dir)
    .filter((f) => /\.test\.tsx?$/.test(f) && f !== "spawn-timeout.test.ts")
    .flatMap((f) => untimed(readFileSync(join(dir, f), "utf8")).map((t) => `${f}: ${t}`));
  expect(bad).toEqual([]);
});
