// bin/work-hq usage [--since ISO|YYYY-MM-DD] [--until ISO|YYYY-MM-DD] [--db path]
//
// How the owner actually used Work HQ in a window, as markdown for a nightly reflection to read.
// Read-only. Its focus is friction: questions that came back, notes typed twice, cards that
// expired unanswered, agents that failed, things typed into the command bar that read like asks.
// The reflection turns that into fixes (code or config). This only gathers the evidence.

import { Database } from "bun:sqlite";
import type { Item, Job, JournalEntry, Question } from "../shared/types.ts";
import { config } from "../server/config.ts";
import { AFFIRMATIVE } from "../shared/dead-button.ts";
import { type LoadSample, summarise } from "../server/load.ts";

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
// Over a day, a bare HH:MM makes 10-13 and 10-15 read like one batch: add the date.
const multiDay = Date.parse(until) - Date.parse(since) > 86400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const hm = (iso?: string) => {
  if (!iso) return multiDay ? "--:-- --:--" : "--:--";
  const d = new Date(iso);
  const t = d.toTimeString().slice(0, 5);
  return multiDay ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}` : t;
};
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const cut = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const out: string[] = [];
const p = (s = "") => out.push(s);

p(`# Work HQ usage ${since.slice(0, 16)} → ${until.slice(0, 16)}`);
p();

// ── volume ─────────────────────────────────────────────────────────────────
// A card put back by "keep" (Open draft) or snooze is the same ask, not a new one. Keep copies the original
// createdAt, so counting it gave a 4,910-minute "wait" (10-22). New copies carry reopenedFrom; older ones
// share key and createdAt with the card they copy, and the original is the one answered first. (Legacy snooze
// copies got a fresh createdAt and no stamp, so they still count: nothing ties them to the card they copy.)
const reopened = new Set(allQuestions.filter((q) => q.reopenedFrom).map((q) => q.id));
const byAsk = new Map<string, Question[]>();
for (const q of allQuestions) if (!q.reopenedFrom) byAsk.set(`${q.key}|${q.createdAt}`, [...(byAsk.get(`${q.key}|${q.createdAt}`) ?? []), q]);
for (const qs of byAsk.values())
  if (qs.length > 1) qs.sort((a, b) => { const x = a.answeredAt ?? "~", y = b.answeredAt ?? "~"; return x < y ? -1 : x > y ? 1 : 0; }).slice(1).forEach((q) => reopened.add(q.id));
const created = asked.filter((q) => inWin(q.createdAt) && !reopened.has(q.id));
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
const qById = new Map(allQuestions.map((q) => [q.id, q]));
// The note reader replied "sending an agent" but nothing ran (hub.applyNote journals this). The card then sits
// parked or expires, which read as harmless (10-27 11:46, 11-02 11:04). Unwindowed: the claim can fall after `until`.
const isClaim = (x: JournalEntry) => x.who === "hq" && x.text.startsWith("Note reply claimed a dispatch but none started");
const claims = docs<JournalEntry>("SELECT doc FROM journal WHERE doc LIKE '%Note reply claimed a dispatch but none started%'").filter((x) => isClaim(x));
const youNotes = docs<JournalEntry>("SELECT doc FROM journal WHERE doc LIKE '%\"who\":\"you\"%'").filter((x) => x.who === "you" && x.questionId);
// Claims since 11-04 carry the note's id. Older ones: same card, after the note, no later note on that card between
// (the reader is async, so two quick notes on one card can still swap claims there).
const claimFor = (j: JournalEntry) =>
  claims.find((c) =>
    c.noteId
      ? c.noteId === j.id
      : Boolean(j.questionId) && c.questionId === j.questionId && c.at >= j.at && !youNotes.some((n) => n.questionId === j.questionId && n.at > j.at && n.at <= c.at),
  );
const after = (j: JournalEntry) =>
  journal.find((x) => x.itemId === j.itemId && x.at > j.at && Date.parse(x.at) - Date.parse(j.at) < 5 * 60_000 && !/^Note on /.test(x.text) && !isClaim(x));
// Notes under a second apart (any notes, not just identical ones) are a replay: a script or a
// double-fired request, not the owner typing. Show them, but don't count them as typed again.
const ms = notes.map((j) => Date.parse(j.at));
const replayed = new Set(notes.filter((_, i) => (i > 0 && ms[i]! - ms[i - 1]! < 1000) || (i < notes.length - 1 && ms[i + 1]! - ms[i]! < 1000)));
const noteKey = (j: JournalEntry) => `${j.itemId ?? j.questionId ?? ""}|${j.text.toLowerCase()}`;
const typedCount = new Map<string, number>();
for (const j of notes) if (!replayed.has(j)) typedCount.set(noteKey(j), (typedCount.get(noteKey(j)) ?? 0) + 1);
for (const j of notes) {
  const again = replayed.has(j) ? " (replayed)" : (typedCount.get(noteKey(j)) ?? 0) > 1 ? " **(typed more than once)**" : "";
  p(`- ${hm(j.at)} ${md(cut(j.text, 140))} → ${noteFate(j)}${again}`);
}
p();

function noteFate(j: JournalEntry): string {
  // Nothing ran on that path either way; only a stranded claim is sure the reply promised an agent (the other is a regex on its wording).
  const claim = claimFor(j);
  if (claim) return claim.text.startsWith("Note reply claimed a dispatch but none started (card has no single item)") ? "**nothing happened** (reply claimed an agent; none started)" : "**nothing happened** (no agent started; reply may have promised one)";
  const next = j.itemId ? after(j) : undefined;
  if (next) return md(cut(next.text, 80));
  const q = j.questionId ? qById.get(j.questionId) : undefined;
  if (q) {
    // The card it was typed on says what happened.
    // Only an answer within 5 minutes is the note's doing. 10-22: a 07:58 note read "card closed" for a tap at 13:58.
    const gap = q.answeredAt ? Date.parse(q.answeredAt) - Date.parse(j.at) : -1;
    if (q.status !== "open" && gap >= 0 && gap < 5 * 60_000) return `card closed: ${md(cut(q.answer ?? q.status, 60))}`;
    if (q.status === "open" && q.notBefore && q.notBefore > j.at) return "parked till morning (read as background)";
    if (gap >= 0) return `not acted on; card ${q.status === "expired" ? "expired" : "answered separately"} at ${hm(q.answeredAt)}`;
    return "**nothing happened**";
  }
  // Older entries have no questionId. Without an item there's nothing to match on.
  if (!j.itemId) return "can't trace (no item, written before notes recorded their question)";
  const parked = asked.some((q) => q.itemId === j.itemId && q.status === "open" && q.notBefore && q.notBefore > j.at);
  // A drawer note that reads as background, or one added by an agent, with no card on screen, is context by design.
  // Drawer instructions ("do it") go through the note reader on a card since 10-21, so they carry a questionId.
  const onCard = allQuestions.some((q) => q.itemId === j.itemId && q.createdAt <= j.at && (!q.answeredAt || q.answeredAt >= j.at));
  return parked ? "parked till morning (read as background)" : onCard ? "**nothing happened**" : "kept as context (no card open)";
}

// ── meeting cards ──────────────────────────────────────────────────────────
const reviews = created.filter((q) => q.kind === "review");
// A wrap-up typed in the command bar while the card was up is journalled as "<prompt>\n<what they typed>",
// and the card is then usually cleared as "Nothing new". It still counts as typed.
const wrapUp = (j: JournalEntry) => j.who === "you" && /^.+ just ended\. Anything you committed to\?\n\s*\S/.test(j.text);
const wrapUps = journal.filter(wrapUp);
const typedOnCard = (q: Question) => /— /.test(q.answer ?? "") || /^Note/.test(q.answer ?? "") || wrapUps.some((j) => j.text.startsWith(`${q.prompt}\n`));
if (reviews.length) {
  const count = (pred: (q: Question) => boolean) => reviews.filter(pred).length;
  p("## Meeting-ended cards");
  p(`${reviews.length} asked · "Nothing new" ${count((q) => /^Nothing new/.test(q.answer ?? "") && !typedOnCard(q))} · scan requested ${count((q) => /^Scan/.test(q.answer ?? ""))} · typed something ${count(typedOnCard)} · closed by transcript scan ${count((q) => q.answer === "transcript scanned")} · expired otherwise ${count((q) => q.status === "expired" && q.answer !== "transcript scanned")}`);
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
// In-place "carry on" nudges after a turn failed (rate limit, network blip), and how those jobs ended.
for (const [key, label] of [["transient", "network-error retries"], ["rateLimit", "rate-limit retries"]] as const) {
  const nudged = jobs.filter((j) => (j.nudges?.[key] ?? 0) > 0);
  if (!nudged.length) continue;
  const sent = nudged.reduce((n, j) => n + (j.nudges?.[key] ?? 0), 0);
  p(`\n${label}: ${sent} on ${nudged.length} job(s) \u00b7 then done ${nudged.filter((j) => j.status === "done").length} \u00b7 failed ${nudged.filter((j) => j.status === "failed").length} \u00b7 still open ${nudged.filter((j) => j.status !== "done" && j.status !== "failed").length}`);
}
if (errors.size) {
  p("\nFailures:");
  for (const [e, n] of [...errors].sort((a, b) => b[1] - a[1])) p(`- ×${n} ${md(e)}`);
}
p();

// ── idea items ─────────────────────────────────────────────────────────────
// Agents filed an idea item for nearly every follow-up thought (81 on 10-21). The report contract and a
// per-job cap now hold them back; this shows, per day, whether it worked.
p("## Idea items filed");
const ideaDays = new Map<string, { agent: number; other: number; folded: number }>();
const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const ideaDay = (iso: string) => ideaDays.get(day(iso)) ?? ideaDays.set(day(iso), { agent: 0, other: 0, folded: 0 }).get(day(iso))!;
for (const i of items.values()) if (i.kind === "idea" && inWin(i.createdAt)) ideaDay(i.createdAt)[i.source.type === "agent" ? "agent" : "other"]++;
for (const j of jobs) if (j.ideasFolded?.length) ideaDay(j.createdAt).folded += j.ideasFolded.length;
if (!ideaDays.size) p("None.");
else {
  p("| day | by agents | other sources | folded by the per-job cap |");
  p("|---|---|---|---|");
  for (const [d, n] of [...ideaDays].sort()) p(`| ${d} | ${n.agent} | ${n.other} | ${n.folded} |`);
  const top = jobs.filter((j) => (j.ideasFiled ?? 0) + (j.ideasFolded?.length ?? 0) > 1).sort((a, b) => (b.ideasFolded?.length ?? 0) - (a.ideasFolded?.length ?? 0));
  if (top.length) {
    p("\nJobs that offered more than one idea:");
    for (const j of top.slice(0, 8)) p(`- ${md(cut(j.title, 80))}: ${j.ideasFiled ?? 0} filed, ${j.ideasFolded?.length ?? 0} folded`);
  }
}
p();

// ── machine load ───────────────────────────────────────────────────────────
// Sampled once a minute by the scheduler (src/server/load.ts). The question it answers: does load
// still follow how many agents are running, and is pi.maxRunningJobs / pi.maxLoad set right?
p("## Machine load");
const hasLoad = Boolean(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'load'").get());
const loadRows = hasLoad
  ? (db.query("SELECT t, l1, l5, l15, jobs FROM load WHERE t >= ? AND t < ? ORDER BY t").values(Date.parse(since), Date.parse(until)) as LoadSample[])
  : [];
if (!loadRows.length) p("No samples.");
else {
  const ls = summarise(loadRows);
  p(`${ls.samples} samples, ${ls.cores} cores. Mean 1-min load ${ls.meanL1}; peak ${ls.peak!.l1} at ${hm(ls.peak!.at)} with ${ls.peak!.jobs} agents running; above ${ls.cores} for ${ls.overCores} min.`);
  p(ls.r === undefined ? "Correlation with running agents: not enough spread to say." : `Correlation (Pearson r) between running agents and 1-min load: ${ls.r}.`);
  p("\n| agents running | minutes | mean 1-min load |");
  p("|---|---|---|");
  for (const b of ls.byJobs) p(`| ${b.jobs} | ${b.n} | ${b.meanL1} |`);
}
p();

// ── taps that should have started something ────────────────────────────
// A command-bar follow-up ("Want an agent to…?") answered yes with no agent or triage run after it:
// the button looked like it worked and did nothing. "Any job within 15 min" is too loose: taps come
// in batches, and on 10-14 forty other jobs started in the 15 min after a dead tap. What counts:
// a triage run started within 2 min (the tap's own effect), or a note run on this card within 15.
p("## Yes taps that started nothing");
const yes = AFFIRMATIVE;
const allJobs = docs<Job>("SELECT doc FROM jobs").filter((j) => j.kind === "triage");
const followed = (q: Question) => {
  const t = Date.parse(q.answeredAt!);
  return allJobs.some((j) => {
    const dt = Date.parse(j.createdAt) - t;
    if (dt < -1000) return false;
    if (j.name === "note") return dt <= 15 * 60_000 && j.title.startsWith(`Note: ${q.prompt}`.slice(0, 40));
    return ["chat", "pineapple", "review"].includes(j.name) && dt <= 2 * 60_000;
  });
};
const dead = asked.filter((q) => {
  if (!q.key.startsWith("triage:") || q.status !== "answered" || !inWin(q.answeredAt)) return false;
  return yes.test((q.answer ?? "").split(" — ")[0]!) && !followed(q);
});
if (!dead.length) p("None.");
for (const q of dead.sort((a, b) => a.answeredAt!.localeCompare(b.answeredAt!)))
  p(`- ${hm(q.answeredAt)} **${md(cut(q.prompt, 120))}** → ${md(cut(q.answer ?? "", 60))}: **no triage run after it**`);
p();

// ── what the owner typed that wasn't an answer ─────────────────────────────
const structured = /^(Note on |Re "|Done:|Dropped:|Waiting:|Scheduled |Will do |Already booked |Proposed:|Committed today:|Started:|Captured:|Dispatched |Corrected:|Added:|Batch |Tried to schedule)/;
const said = journal.filter((j) => j.who === "you" && !structured.test(j.text) && !/ → /.test(j.text));
p("## Typed into the command bar");
if (!said.length) p("None.");
for (const j of said) {
  // Narrow on purpose: "card", "question" and "notification" turn up in ordinary asks too.
  const tag = wrapUp(j) ? " [meeting wrap-up]" : /work[ -]?hq|\bthe (app|dashboard)\b/i.test(j.text) ? " **[about Work HQ itself]**" : "";
  p(`- ${hm(j.at)} ${md(cut(j.text, 200))}${tag}`);
}
p();
p(`_Source: ${arg("db") ?? config.dbPath} (read-only)._`);
console.log(out.join("\n"));
