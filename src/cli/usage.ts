// bin/work-hq usage [--since ISO|YYYY-MM-DD] [--until ISO|YYYY-MM-DD] [--db path]
//
// How the owner actually used Work HQ in a window, as markdown for a nightly reflection to read.
// Read-only. Its focus is friction: questions that came back, notes typed twice, cards that
// expired unanswered, agents that failed, things typed into the command bar that read like asks.
// The reflection turns that into fixes (code or config). This only gathers the evidence.

import { Database } from "bun:sqlite";
import type { Item, Job, JournalEntry, Question } from "../shared/types.ts";
import { config } from "../server/config.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const toIso = (s: string | undefined, fallback: Date) => {
  if (!s) return fallback.toISOString();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`bad date: ${s}`);
  return d.toISOString();
};
const until = toIso(arg("until"), new Date());
const since = toIso(arg("since"), new Date(Date.parse(until) - 86400_000));
const db = new Database(arg("db") ?? config.dbPath, { readonly: true });

const docs = <T>(sql: string, ...p: any[]): T[] => db.query(sql).all(...p).map((r: any) => JSON.parse(r.doc) as T);
const inWin = (iso?: string) => Boolean(iso && iso >= since && iso < until);

const items = new Map(docs<Item>("SELECT doc FROM items").map((i) => [i.id, i]));
const allQuestions = docs<Question>("SELECT doc FROM questions");
const asked = allQuestions.filter((q) => inWin(q.createdAt) || inWin(q.answeredAt));
const journal = docs<JournalEntry>("SELECT doc FROM journal WHERE updated >= ? AND updated < ? ORDER BY updated", since, until);
const jobs = docs<Job>("SELECT doc FROM jobs").filter((j) => inWin(j.createdAt));
const title = (id?: string) => (id ? items.get(id)?.title ?? id : "—");
const hm = (iso?: string) => (iso ? new Date(iso).toTimeString().slice(0, 5) : "--:--");
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const cut = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const out: string[] = [];
const p = (s = "") => out.push(s);

p(`# Work HQ usage ${since.slice(0, 16)} → ${until.slice(0, 16)}`);
p();

// ── volume ─────────────────────────────────────────────────────────────────
const created = asked.filter((q) => inWin(q.createdAt));
const byKind = new Map<string, Question[]>();
for (const q of created) byKind.set(q.kind, [...(byKind.get(q.kind) ?? []), q]);
p("## Questions by kind");
p("| kind | asked | answered | expired | still open | median wait | top answers |");
p("|---|---|---|---|---|---|---|");
for (const [kind, qs] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
  const answered = qs.filter((q) => q.status === "answered");
  const waits = answered.map((q) => (Date.parse(q.answeredAt!) - Date.parse(q.createdAt)) / 60_000).sort((a, b) => a - b);
  const median = waits.length ? `${Math.round(waits[Math.floor(waits.length / 2)]!)} min` : "—";
  const tops = new Map<string, number>();
  for (const q of answered) {
    const a = (q.answer ?? "").split(" — ")[0]!.replace(/^Note: .*/, "typed note");
    tops.set(a, (tops.get(a) ?? 0) + 1);
  }
  const top = [...tops].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${md(cut(a, 30))} ×${n}`).join(", ");
  p(`| ${kind} | ${qs.length} | ${answered.length} | ${qs.filter((q) => q.status === "expired").length} | ${qs.filter((q) => q.status === "open").length} | ${median} | ${top || "—"} |`);
}
const expiredWhy = new Map<string, number>();
for (const q of created.filter((q) => q.status === "expired")) expiredWhy.set(q.answer ?? "?", (expiredWhy.get(q.answer ?? "?") ?? 0) + 1);
if (expiredWhy.size) p(`\nExpired because: ${[...expiredWhy].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ×${n}`).join(", ")}`);
p();

// ── repeats ────────────────────────────────────────────────────────────────
p("## Asked more than once (same item)");
const perItem = new Map<string, Question[]>();
for (const q of created) if (q.itemId) perItem.set(q.itemId, [...(perItem.get(q.itemId) ?? []), q]);
const repeats = [...perItem].filter(([, qs]) => qs.length > 1).sort((a, b) => b[1].length - a[1].length);
if (!repeats.length) p("None.");
for (const [id, qs] of repeats.slice(0, 15)) {
  const trail = qs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((q) => `${hm(q.createdAt)} ${q.kind}→${md(cut(q.answer ?? q.status, 40))}`).join(" · ");
  p(`- **${md(cut(title(id), 80))}** (${qs.length}×): ${trail}`);
}
const samePrompt = new Map<string, Question[]>();
for (const q of created.filter((q) => !q.itemId && !["review", "prep", "plan", "wrap"].includes(q.kind))) samePrompt.set(q.prompt, [...(samePrompt.get(q.prompt) ?? []), q]);
for (const [prompt, qs] of samePrompt) if (qs.length > 1) p(`- (no item) **${md(cut(prompt, 80))}** asked ${qs.length}×`);
p();

// ── notes ──────────────────────────────────────────────────────────────────
p("## Typed notes and what they did");
const notes = journal.filter((j) => j.who === "you" && /^Note on |^Re "/.test(j.text));
if (!notes.length) p("None.");
const after = (j: JournalEntry) =>
  journal.find((x) => x.itemId === j.itemId && x.at > j.at && Date.parse(x.at) - Date.parse(j.at) < 5 * 60_000 && !/^Note on /.test(x.text));
const seenNote = new Map<string, number>();
for (const j of notes) {
  const key = `${j.itemId}|${j.text.toLowerCase()}`;
  seenNote.set(key, (seenNote.get(key) ?? 0) + 1);
}
for (const j of notes) {
  const next = j.itemId ? after(j) : undefined;
  const again = (seenNote.get(`${j.itemId}|${j.text.toLowerCase()}`) ?? 0) > 1 ? " **(typed more than once)**" : "";
  const parked = asked.some((q) => q.itemId === j.itemId && q.status === "open" && q.notBefore && q.notBefore > j.at);
  // A note added from the item drawer or by an agent, with no card on screen, is context by design.
  const onCard = allQuestions.some((q) => q.itemId === j.itemId && q.createdAt <= j.at && (!q.answeredAt || q.answeredAt >= j.at));
  const fate = next ? md(cut(next.text, 80)) : parked ? "parked till morning (read as background)" : onCard ? "**nothing happened**" : "kept as context (no card open)";
  p(`- ${hm(j.at)} ${md(cut(j.text, 140))} → ${fate}${again}`);
}
p();

// ── meeting cards ──────────────────────────────────────────────────────────
const reviews = created.filter((q) => q.kind === "review");
if (reviews.length) {
  const count = (pred: (q: Question) => boolean) => reviews.filter(pred).length;
  p("## Meeting-ended cards");
  p(`${reviews.length} asked · "Nothing new" ${count((q) => /^Nothing new/.test(q.answer ?? ""))} · scan requested ${count((q) => /^Scan/.test(q.answer ?? ""))} · typed something ${count((q) => /— /.test(q.answer ?? "") || /^Note/.test(q.answer ?? ""))} · closed by transcript scan ${count((q) => q.answer === "transcript scanned")} · expired otherwise ${count((q) => q.status === "expired" && q.answer !== "transcript scanned")}`);
  p();
}

// ── dedupe ─────────────────────────────────────────────────────────────────
const merged = journal.filter((j) => j.who === "hq" && /^(Merged duplicate|Not re-adding)/.test(j.text));
if (merged.length) {
  p("## Duplicates merged");
  for (const j of merged) p(`- ${md(cut(j.text, 160))}`);
  p();
}

// ── agents ─────────────────────────────────────────────────────────────────
p("## Agent runs");
const runs = new Map<string, { n: number; ok: number; failed: number }>();
for (const j of jobs) {
  const k = `${j.kind}/${j.name}`;
  const r = runs.get(k) ?? { n: 0, ok: 0, failed: 0 };
  r.n++;
  if (j.status === "done") r.ok++;
  if (j.status === "failed") r.failed++;
  runs.set(k, r);
}
p("| run | total | done | failed |");
p("|---|---|---|---|");
for (const [k, r] of [...runs].sort((a, b) => b[1].n - a[1].n)) p(`| ${k} | ${r.n} | ${r.ok} | ${r.failed} |`);
const errors = new Map<string, number>();
for (const j of jobs.filter((j) => j.status === "failed")) {
  const e = (j.error ?? "?").replace(/\s+/g, " ").slice(0, 90);
  errors.set(e, (errors.get(e) ?? 0) + 1);
}
if (errors.size) {
  p("\nFailures:");
  for (const [e, n] of [...errors].sort((a, b) => b[1] - a[1])) p(`- ×${n} ${md(e)}`);
}
p();

// ── what the owner typed that wasn't an answer ─────────────────────────────
const structured = /^(Note on |Re "|Done:|Dropped:|Waiting:|Scheduled |Will do |Already booked |Proposed:|Committed today:|Started:|Captured:|Dispatched |Corrected:|Added:|Batch |Tried to schedule)/;
const said = journal.filter((j) => j.who === "you" && !structured.test(j.text) && !/ → /.test(j.text));
p("## Typed into the command bar");
if (!said.length) p("None.");
for (const j of said) {
  const aboutHq = /work ?hq|\bhq\b|dashboard|card|question|notif/i.test(j.text) ? " **[about Work HQ itself]**" : "";
  p(`- ${hm(j.at)} ${md(cut(j.text, 200))}${aboutHq}`);
}
p();
p(`_Source: ${arg("db") ?? config.dbPath} (read-only)._`);
console.log(out.join("\n"));
