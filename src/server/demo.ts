// Demo mode (WORK_HQ_DEMO=on, set by `bin/work-hq demo`). Safe to show on a screen share:
//   - the data is made up (seedDemo) and lives in a throwaway database;
//   - no memory, no config file, no background sweeps;
//   - anything that would reach the outside world is replaced by a script that *looks* like the
//     real thing: dispatched agents, sweeps, calendar writes. Only tool-less triage still calls pi,
//     and it only ever sees the made-up items below.

import type { ActionKind, AgentReport, Item } from "../shared/types.ts";
import { newId, nowIso } from "./db.ts";
import type { Hub } from "./hub.ts";
import { coachKey, coachQuestion } from "./prompter.ts";

export const DEMO_OWNER = "Alex";

/** Wipe every table and fill it with a fresh, time-relative day of made-up work. */
export function resetDemo(hub: Hub) {
  for (const t of ["items", "questions", "jobs", "events", "journal", "sync", "kv"]) hub.store.db.exec(`DELETE FROM ${t}`);
  seedDemo(hub);
  hub.emit({ type: "snapshot", data: hub.snapshot() });
}

export function seedDemo(hub: Hub) {
  const now = Date.now();
  const FIVE = 5 * 60_000;
  /** Relative to now, on a 5-minute grid, so the calendar reads like a real one. */
  const at = (min: number) => new Date(Math.round((now + min * 60_000) / FIVE) * FIVE).toISOString();
  const day = (d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10);

  hub.setEvents([
    { id: "e1", title: "Team standup", start: at(-120), end: at(-105), attendees: ["Sam", "Priya", "Tom", DEMO_OWNER] },
    { id: "e2", title: "Payments roadmap review", start: at(-70), end: at(-25), attendees: ["Priya", "Jordan", "Mei", DEMO_OWNER] },
    { id: "e3", title: "1-1 Sam", start: at(15), end: at(45), attendees: ["Sam", DEMO_OWNER], oneOnOne: true },
    { id: "e4", title: "Focus: hiring loop write-up", start: at(60), end: at(120), attendees: [DEMO_OWNER] },
    { id: "e5", title: "Incident review: checkout latency", start: at(150), end: at(195), attendees: ["Tom", "Mei", "Ravi", DEMO_OWNER, "Jordan"] },
  ]);

  const item = (i: Parameters<typeof hub.createItem>[0]) => hub.createItem(i);

  item({
    title: "Send Jordan the capacity numbers for Q4", kind: "email", status: "inbox", project: "PAY", people: ["Jordan"],
    signals: { pineapple: true }, confidence: 0.9,
    source: { type: "transcript", label: "Payments roadmap review", quote: "I'll get you the capacity numbers by Thursday — pineapple." },
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
    links: ["https://tracker.example.com/browse/PAY-2240"], source: { type: "transcript", label: "Checkout standup", quote: "that alert pages us every night, pineapple" },
  });
  item({ title: "Share hiring rubric with Priya", kind: "task", status: "done", source: { type: "manual" } });

  hub.putJob({
    id: newId("job"), kind: "action", name: "ticket", title: "Ticket · checkout p99 alert is too noisy", surface: "headless",
    status: "done", itemId: filed.id, createdAt: at(-40), startedAt: at(-40), finishedAt: at(-36),
    tail: ["▸ $ tracker search 'p99 alert'", "▸ $ tracker create --body-file brief.md", "✓ Filed PAY-2240, linked PAY-1987"],
    summary: "Filed PAY-2240, linked PAY-1987", reported: true,
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
  ] as const) {
    const e = hub.journal(text, { who });
    hub.store.putJournal({ ...e, synced: true }); // pretend it was saved already: no "unsaved" dots
  }

  hub.setCoaching({
    date: day(-1),
    signal: "Mixed",
    when: "today, before the 1-1 with Sam",
    move: "- Spend ten minutes on the two things only you can do:\n  1. Answer Priya's staffing question in the thread.\n  2. Hand the vendor escalations to Tom, with a boundary: no new feature work.",
    wins: ["You cleared the queue with decisions, not snoozes", "Tom owns the incident review without you as the relay"],
    gaps: ["Three people have waited more than a week on a two-line reply", "Your review comments are all agent-written"],
  });

  // Earlier moves' cards, answered, so the panel shows the track record.
  for (const [d, label] of [[-6, "Done"], [-5, "Not today — ran out of time"], [-4, undefined], [-3, "Hand to an agent"], [-2, "Done"]] as const) {
    const q = coachQuestion({ date: day(d), when: "tomorrow", move: "- An earlier move" });
    hub.store.putQuestion({
      ...q, id: newId("q"), key: coachKey({ date: day(d) }), createdAt: at(d * 1440), answeredAt: at(d * 1440 + 60),
      status: label ? "answered" : "expired", answer: label ?? "new reflection",
    });
  }

  for (const [name, ago] of [["memory", -10], ["transcripts", -18], ["calendar", -45], ["journal", -2]] as const) {
    hub.putSync({ name, lastRunAt: at(ago), lastOkAt: at(ago), cursor: "demo" });
  }
}

// ── scripted agents ──────────────────────────────────────────────────────
// One step = one line in the terminal (and the dashboard's Agents feed), after a pause.

export interface DemoStep {
  /** "tool" lines look like pi tool calls; "out" is dim tool output; "say" is the agent talking. */
  t: "tool" | "out" | "say";
  text: string;
  ms: number;
}

export interface DemoScript {
  steps: DemoStep[];
  report: AgentReport;
}

const first = (xs: string[] | undefined, fallback: string) => xs?.[0] ?? fallback;
const ticketNo = () => `${2240 + Math.floor(Math.random() * 60)}`;

/** A believable run for each action kind. Ends with a report that moves the item along. */
export function demoActionScript(item: Item, action: ActionKind, note?: string): DemoScript {
  const who = first(item.people, "the team");
  const proj = item.project ?? "PAY";
  const short = item.title.replace(/^(File ticket|Reply to|Send|Draft):?\s*/i, "").slice(0, 60);
  const steps: DemoStep[] = [];
  const tool = (text: string, ms = 900) => steps.push({ t: "tool", text, ms });
  const out = (text: string, ms = 350) => steps.push({ t: "out", text, ms });
  const say = (text: string, ms = 700) => steps.push({ t: "say", text, ms });

  say(`On it: ${item.title}${note ? ` (${note})` : ""}`, 500);
  tool(`read memory/people.md`);
  out(`${who}: staff engineer, payments platform · prefers async, short messages`);

  let report: AgentReport;
  switch (action) {
    case "ticket": {
      const key = `${proj}-${ticketNo()}`;
      tool(`$ tracker search --project ${proj} "${short.split(" ").slice(0, 3).join(" ")}"`);
      out(`1 related: ${proj}-1987 "p99 alert thresholds" (Done, 4 months ago)`);
      tool(`write /tmp/brief.md`, 1200);
      out(`Problem · Impact · Proposed fix · Links (${proj}-1987)`);
      tool(`$ tracker create --project ${proj} --type Task --body-file /tmp/brief.md`, 1400);
      out(`Created ${key}`);
      tool(`$ tracker link ${key} relates-to ${proj}-1987`);
      say(`Filed ${key} and linked ${proj}-1987. Nobody assigned yet; it's in Needs Triage.`);
      report = {
        summary: `Filed ${key}, linked ${proj}-1987`,
        updates: [{ id: item.id, status: "waiting", links: [`https://tracker.example.com/browse/${key}`], note: `filed ${key}` }],
      };
      break;
    }
    case "reply":
    case "email": {
      const via = action === "email" ? "mcp gmail" : "mcp chat";
      const topic = short.replace(/^(the|my)\s+/i, "").replace(/\s+(to|for|with)\s+\w+$/i, "");
      tool(`${via} search "${who}" newer_than:14d`);
      out(`3 threads · last from ${who} 2h ago: "any news on ${topic.toLowerCase()}?"`);
      tool(`read notes/${proj.toLowerCase()}/planning.md`);
      out(`found the numbers + one open caveat`);
      say(`Draft:\n  "Hi ${who}, ${topic.toLowerCase()} below. One caveat flagged inline. Happy to walk through it."`, 1400);
      tool(`${via} send → ${who}`, 1200);
      out(`sent ✓`);
      say(`Sent. I'll flag it if ${who} replies with questions.`);
      report = { summary: `Sent to ${who}`, updates: [{ id: item.id, status: "waiting", note: `sent to ${who}, waiting for a reply` }] };
      break;
    }
    case "prep": {
      tool(`mcp calendar get_event "${item.title}"`);
      out(`30 min · ${who} · recurring, every 2 weeks`);
      tool(`mcp chat search_messages from:${who} after:-14d`);
      out(`12 messages · themes: on-call load, promo packet, retry-queue migration`);
      tool(`read scratch/1-1-prep-${who.toLowerCase()}-last.md`);
      out(`open from last time: "ask about the conference talk"`);
      tool(`write scratch/1-1-prep-${who.toLowerCase()}.md`, 1300);
      say(`Brief ready: 3 topics, 1 open loop from last time, 1 ask (owner for the retry-queue migration).`);
      report = { summary: `1-1 brief ready: 3 topics + 1 open loop`, updates: [{ id: item.id, status: "today", note: "brief written" }] };
      break;
    }
    case "verify": {
      const key = /[A-Z]+-\d+/.exec(`${item.title} ${(item.links ?? []).join(" ")}`)?.[0] ?? `${proj}-2231`;
      tool(`$ tracker view ${key}`);
      out(`Status: Done · resolved 3 days ago by Tom · "quarantined flaky test, fix in ${proj}-2236"`);
      say(`It's closed. Tom quarantined the test and opened ${proj}-2236 for the real fix.`);
      report = { summary: `Closed 3 days ago; follow-up ${proj}-2236`, updates: [{ id: item.id, status: "done", note: `closed, follow-up ${proj}-2236` }] };
      break;
    }
    case "draft":
    case "publish": {
      tool(`mcp wiki search "review wait time"`);
      out(`0 posts in the last 12 months`);
      tool(`read notes/metrics/review-latency.csv`);
      out(`median wait 26h → 11h over 6 weeks`);
      tool(`write scratch/blog-drafts/review-wait.md`, 1500);
      say(`Draft written: 600 words, one chart, two places marked [CHECK] for you.`);
      report = { summary: `Draft ready for review`, updates: [{ id: item.id, status: "today", note: "draft written, needs your edit pass" }] };
      break;
    }
    default: {
      tool(`$ git log --oneline -5`);
      out(`a1b2c3d Retry queue: back off on 429s`);
      tool(`read docs/runbooks/on-call.md`);
      out(`3 editors in the last month · no owner field`);
      tool(`edit docs/runbooks/on-call.md`, 1200);
      out(`+ owner: ${who} · review: quarterly`);
      say(`Done. Added an owner line and a quarterly review reminder.`);
      report = { summary: `Done: ${short}`, updates: [{ id: item.id, status: "done", note: "agent finished" }] };
    }
  }
  return { steps, report };
}

/** A sweep that "finds" a couple of new things, so the transcripts / calendar chips do something on stage. */
export function demoSweepScript(name: "transcripts" | "calendar" | "posts"): DemoScript {
  if (name === "calendar") {
    return {
      steps: [
        { t: "tool", text: "mcp calendar list_events today", ms: 900 },
        { t: "out", text: "5 events · 1 one-on-one · 1 incident review", ms: 400 },
      ],
      report: { summary: "5 events today" },
    };
  }
  if (name === "posts") {
    return {
      steps: [
        { t: "tool", text: "mcp wiki search author:me after:-30d", ms: 1200 },
        { t: "out", text: "4 pages · 2 MRs merged with big numbers", ms: 400 },
      ],
      report: {
        summary: "1 idea",
        items: [{
          title: "Retry storms: what our checkout incident taught us", kind: "post", status: "proposed",
          post: { venue: "wiki", why: "incident learnings other teams can reuse", gap: "No wiki post on retry budgets" },
          source: { type: "agent", label: "Writing scout", key: `post:retry-storms-${Date.now()}` },
        }],
      },
    };
  }
  return {
    steps: [
      { t: "tool", text: "mcp drive search 'Notes by Gemini' modified:today", ms: 1100 },
      { t: "out", text: "1 new doc: Payments roadmap review", ms: 400 },
      { t: "tool", text: "mcp docs get … § Transcript", ms: 1300 },
      { t: "out", text: "42 min · 4 speakers", ms: 400 },
      { t: "say", text: "2 asks aimed at Alex", ms: 700 },
    ],
    report: {
      summary: "1 meeting scanned, 2 items",
      items: [
        {
          title: "Share the retry-budget proposal with Mei before Friday", kind: "task", status: "inbox", project: "PAY", people: ["Mei"], confidence: 0.85,
          source: { type: "transcript", label: "Payments roadmap review", quote: "Alex, could you send me the retry-budget thing before Friday?", key: `demo:sweep:retry-${Date.now()}` },
        },
        {
          title: "Ask Ravi for the vendor's pen-test date", kind: "followup", status: "inbox", people: ["Ravi"], confidence: 0.7,
          source: { type: "transcript", label: "Payments roadmap review", quote: "I'll chase Ravi on the pen-test date.", key: `demo:sweep:pentest-${Date.now()}` },
        },
      ],
    },
  };
}

/** A tool step as the dashboard's Agents feed shows it. */
export const feedLine = (s: DemoStep) => (s.t === "tool" ? `▸ ${s.text}` : s.t === "say" ? `◆ ${s.text.split("\n")[0]}` : `  ${s.text}`);
