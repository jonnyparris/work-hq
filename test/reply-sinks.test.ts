// Lint for the "claims before it runs" class (ff3d07e "Booked", 97880fc "Asking Maryna in chat").
// A headless model's `reply` is prose written before anything runs. Shown as a toast, a job summary or the chat
// reply line, it reads as done. Every place that shows one must be on this list, with a `reply-safe:` comment at
// the site saying why it's true the moment it's shown. A new site fails here until someone writes that reason.
//
// Not caught: a reply copied into another variable first (`const msg = out.reply; toast(msg)`). A triage reply that
// claims "Dispatched an agent" with dispatch[] empty is a runtime check instead (claimsDispatch, claim-before-run.test.ts).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../src");
const DIRS = ["server", "web"];

/** Where a string reaches the owner's eyes. */
const SINK = /\btoast\(|\bsummary:|\bsetReply\((?!undefined)/;
/** A model reply on the same line: `.reply`, `summary: reply`, `{reply}`, `${reply}`. Not the English word. */
const REPLY = /\.reply\b|[:({$]\s*reply\b|\breply\s*[,})?]/;
/** Blank plain string literals first ("waiting for a reply" is words, not data). */
const code = (line: string) => line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

/** file, a regex unique to the line, and why. One entry per site. */
const ALLOW: { file: string; line: RegExp; why: string }[] = [
  { file: "server/hub.ts", line: /queuedNote\(q, d, item\?\.title\) \?\? d\.reply \?\? `Noted/, why: "queuedNote takes over when the pick queues work" },
  { file: "server/hub.ts", line: /toast\(d\.reply \?\? `\$\{label\(d\.status\)\}/, why: "setStatus already ran" },
  { file: "server/hub.ts", line: /toast\(reply \? `\$\{reply\} Back/, why: "context only: nothing runs, the reply is an answer; a dispatch claim gets a suffix" },
  { file: "server/hub.ts", line: /toast\(reply \? `\$\{reply\} Kept as context/, why: "drawer note read as context: nothing runs, the reply is an answer; a dispatch claim gets a suffix" },
  { file: "server/agents.ts", line: /summary: reply \}\);/, why: "triage: applyTriage ran; missed or unbacked dispatches get a suffix; prompt words dispatches as handed off" },
  { file: "server/agents.ts", line: /summary: queuedNote\(q, out, item\?\.title\) \?\? out\.reply/, why: "queuedNote takes over when the note queues work" },
  { file: "server/agents.ts", line: /toast\(out\?\.reply \?\? "Couldn't tell when/, why: "failure path: the reply asks when" },
  { file: "server/agents.ts", line: /summary: out\.reply \?\? `Scheduled \$\{label\}`/, why: "schedule() ran; calendar create takes fixed words above" },
  { file: "server/agents.ts", line: /toast\(`\$\{out\.reply \?\? `Scheduled/, why: "same as the summary line above" },
  { file: "web/main.tsx", line: /setReply\(r\.reply \?\? "Done\."\)/, why: "the triage reply from agents.triage, same as its summary" },
];

interface Site { file: string; n: number; text: string; lines: string[] }

function sites(): Site[] {
  const out: Site[] = [];
  for (const dir of DIRS) {
    for (const f of readdirSync(join(ROOT, dir)).filter((f) => /\.tsx?$/.test(f))) {
      const lines = readFileSync(join(ROOT, dir, f), "utf8").split("\n");
      lines.forEach((text, i) => {
        if (/^\s*(\/\/|\*)/.test(text)) return;
        if (SINK.test(code(text)) && REPLY.test(code(text))) out.push({ file: `${dir}/${f}`, n: i, text: text.trim(), lines });
      });
    }
  }
  return out;
}

test("every model reply shown as a toast, summary or chat reply is on the allowlist", () => {
  const found = sites();
  // Not vacuous: hub + agents + web show replies in 9 places today.
  expect(found.length).toBeGreaterThanOrEqual(ALLOW.length);
  const unlisted = found.filter((s) => !ALLOW.some((a) => a.file === s.file && a.line.test(s.text))).map((s) => `${s.file}:${s.n + 1}: ${s.text}`);
  // Fix: use fixed words that are true now (see queuedNote), or add an ALLOW entry + a `reply-safe:` comment.
  expect(unlisted).toEqual([]);
});

test("every allowlist entry matches exactly one site (no stale or ambiguous entries)", () => {
  const found = sites();
  const bad = ALLOW.map((a) => ({ a, n: found.filter((s) => s.file === a.file && a.line.test(s.text)).length }))
    .filter(({ n }) => n !== 1)
    .map(({ a, n }) => `${a.file} ${a.line} matched ${n}`);
  expect(bad).toEqual([]);
});

test("every allowlisted site carries a `reply-safe:` comment on the line or up to 3 lines above", () => {
  const missing = sites()
    .filter((s) => !s.lines.slice(Math.max(0, s.n - 3), s.n + 1).some((l) => /reply-safe:/.test(l)))
    .map((s) => `${s.file}:${s.n + 1}`);
  expect(missing).toEqual([]);
});
