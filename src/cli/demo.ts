// `bin/work-hq demo` — a throwaway Work HQ full of made-up work, for trying the UI
// (and for the README screenshots). No config file, no memory, no sweeps, no real calendar.
// Dispatching an action will still launch pi for real, so pick "Skip" if you're only looking.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const db = resolve(tmpdir(), "work-hq-demo.db");
for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });

Object.assign(process.env, {
  WORK_HQ_CONFIG: process.env.WORK_HQ_DEMO_CONFIG ?? "none",
  WORK_HQ_DB: db,
  WORK_HQ_PORT: process.env.WORK_HQ_PORT ?? "7718",
  WORK_HQ_SWEEPS: "off",
  WORK_HQ_MEMORY_WRITE: "off",
  WORK_HQ_OWNER: process.env.WORK_HQ_OWNER ?? "Alex",
  WORK_HQ_STATE: resolve(tmpdir(), "work-hq-demo-state"),
});
delete process.env.WORK_HQ_MEMORY_TOKEN;
delete process.env.WORK_HQ_MEMORY_URL;

const { Store, nowIso, newId } = await import("../server/db.ts");
const { Hub } = await import("../server/hub.ts");

const hub = new Hub(new Store(db));
const now = Date.now();
const at = (min: number) => new Date(now + min * 60_000).toISOString();
const day = (d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10);

hub.setEvents([
  { id: "e1", title: "Team standup", start: at(-300), end: at(-285), attendees: ["Sam", "Priya", "Tom", "Alex"] },
  { id: "e2", title: "Payments roadmap review", start: at(-70), end: at(-25), attendees: ["Priya", "Jordan", "Mei", "Alex"] },
  { id: "e3", title: "1-1 Sam", start: at(15), end: at(45), attendees: ["Sam", "Alex"], oneOnOne: true },
  { id: "e4", title: "Focus: hiring loop write-up", start: at(60), end: at(120), attendees: ["Alex"] },
  { id: "e5", title: "Incident review: checkout latency", start: at(150), end: at(195), attendees: ["Tom", "Mei", "Ravi", "Alex", "Jordan"] },
]);

const item = (i: Parameters<typeof hub.createItem>[0]) => hub.createItem(i);

item({
  title: "Send Jordan the capacity numbers for Q4", kind: "email", status: "inbox", project: "PAY", people: ["Jordan"],
  signals: { pineapple: true }, confidence: 0.9,
  source: { type: "pineapple", label: "Payments roadmap review", quote: "I'll get you the capacity numbers by Thursday — pineapple." },
});
item({
  title: "Decide who owns the retry-queue migration", kind: "decision", status: "inbox", project: "PAY", people: ["Priya", "Tom"],
  source: { type: "transcript", label: "Payments roadmap review", quote: "Alex, can you make a call on who drives the migration?" },
  confidence: 0.8,
});
item({
  title: "PAY-2231 · flaky settlement test still open", kind: "ticket", status: "proposed", project: "PAY",
  detail: "Marked Needs Triage two weeks ago. State unknown.", signals: { stateUnknown: true },
  links: ["https://tracker.example.com/browse/PAY-2231"], source: { type: "memory", label: "active-todos · Ticket hygiene", key: "demo:pay-2231" },
});
item({
  title: "Load-test stakeholder sign-off", kind: "decision", status: "proposed", project: "PERF",
  detail: `Demo done, nobody has signed off. Kill ${day(1)} if no decision is recorded.`, signals: { killDate: day(1) },
  source: { type: "memory", label: "active-todos · Immediate", key: "demo:loadtest" },
});
item({
  title: "Give the on-call runbook a single owner", kind: "idea", status: "proposed",
  detail: "**Problem**: three people edit it, nobody owns it.\n**Solution**: name an owner, add a quarterly review reminder.\n**Effort**: Low.",
  source: { type: "memory", label: "Proposals · High Priority", key: "memory:proposals:runbook-owner" },
});
item({
  title: "How we cut review wait time in half", kind: "post", status: "proposed",
  post: { venue: "both", why: "team win + reusable pattern", gap: "No wiki post on review SLAs in the last year" },
  detail: "Two-reviewer rule → one reviewer + bot pre-check. Median wait 26h → 11h.",
  source: { type: "agent", label: "Writing scout", key: "post:review-wait" },
});
item({
  title: "Reply to Mei about the incident timeline", kind: "message", status: "scheduled", people: ["Mei"],
  scheduledFor: at(-5), when: "after standup", source: { type: "voice", quote: "remind me to reply to Mei after standup" },
});
item({ title: "Review Tom's design doc: idempotency keys", kind: "review", status: "today", people: ["Tom"], confirmedAt: nowIso(), source: { type: "manual" } });
item({ title: "Book offsite venue", kind: "task", status: "today", confirmedAt: nowIso(), source: { type: "manual" } });
item({ title: "Chase vendor on SOC 2 report", kind: "followup", status: "waiting", people: ["Ravi"], source: { type: "manual" } });
const filed = item({
  title: "File ticket: checkout p99 alert is too noisy", kind: "ticket", status: "waiting", project: "PAY",
  links: ["https://tracker.example.com/browse/PAY-2240"], source: { type: "pineapple", quote: "that alert pages us every night, pineapple" },
});
item({ title: "Share hiring rubric with Priya", kind: "task", status: "done", source: { type: "manual" } });

hub.putJob({
  id: newId("job"), kind: "action", name: "ticket", title: "Ticket · checkout p99 alert is too noisy", surface: "headless",
  status: "done", itemId: filed.id, createdAt: at(-40), startedAt: at(-40), finishedAt: at(-36),
  tail: ["▸ $ tracker search 'p99 alert'", "▸ $ tracker create --body-file brief.md", "✓ Filed PAY-2240, linked PAY-1987"],
  summary: "Filed PAY-2240, linked PAY-1987", reported: true,
});
hub.putJob({
  id: newId("job"), kind: "action", name: "prep", title: "Prep · 1-1 Sam", surface: "cmux", status: "running",
  createdAt: at(-3), startedAt: at(-3), tail: ["▸ mcp chat search_messages", "▸ read notes/people.md", "▸ write scratch/1-1-prep-sam.md"],
});
hub.putJob({
  id: newId("job"), kind: "sweep", name: "transcripts", title: "Scan meeting transcripts", surface: "headless", status: "done",
  createdAt: at(-20), startedAt: at(-20), finishedAt: at(-18), tail: ["▸ mcp drive search", "▸ mcp docs get", "✓ 2 meetings scanned, 2 items"],
  summary: "2 meetings scanned, 2 items",
});

for (const [text, who] of [
  ["PAY-2198 is closed", "you"],
  ["Done: PAY-2198 · refund webhook retries", "hq"],
  ["Filed PAY-2240 for the noisy p99 alert", "agent"],
  ["Not mine — Priya owns the vendor renewal", "you"],
  ["Dropped: vendor renewal follow-up (Priya owns it)", "hq"],
] as const) hub.journal(text, { who });

for (const [name, ago] of [["memory", -10], ["transcripts", -18], ["calendar", -45], ["journal", -2]] as const) {
  hub.putSync({ name, lastRunAt: at(ago), lastOkAt: at(ago), cursor: "demo" });
}

console.log(`\n  demo db: ${db}`);
await import("../server/index.ts");
