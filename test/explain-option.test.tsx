import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AGENT_NOW_LABEL, agentNowAction, explainAgentNow, explainOption, showAgentNow } from "../src/shared/explain-option.ts";
import { pileAge, pileItems, pileSource } from "../src/shared/pile.ts";
import type { Item, Job, Question } from "../src/shared/types.ts";
import { AgentsPanel, BriefMe, Focus, Queue } from "../src/web/parts.tsx";

// 11-18: "when I click Still mine today, does that dispatch an agent? Or dismiss the card, temporarily or for good?"

const q = (extra: Partial<Question> = {}): Question => ({
  id: "q1", kind: "state", itemId: "i1", key: "doing:i1", prompt: "Still on it? Fix the test", priority: 50, status: "open", createdAt: "2026-11-18T09:00:00Z",
  options: [
    { id: "done", label: "Done", effect: { type: "status", status: "done" } },
    { id: "today", label: "Still mine today", effect: { type: "status", status: "today" } },
  ],
  ...extra,
});
const item = (extra: Partial<Item> = {}): Item =>
  ({ id: "i1", kind: "task", status: "doing", title: "Fix the test", source: { type: "memory" }, createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-18T09:00:00Z", ...extra }) as Item;

describe("explainOption", () => {
  test("Still mine today: Committed, no agent, the card closes, the wrap-up asks", () => {
    const t = explainOption({ label: "Still mine today", effect: { type: "status", status: "today" } }, q());
    expect(t).toContain("Committed list for today");
    expect(t).toContain("no agent is sent");
    expect(t).toContain("wrap-up");
    expect(t).toEndWith("This card closes.");
  });

  test("a dispatch says an agent goes, where, and how it reports back", () => {
    const t = explainOption({ label: "Send an agent", effect: { type: "dispatch", action: "work" } }, q());
    expect(t).toContain("Sends an agent now");
    expect(t).toContain("Agents panel");
    expect(t).toContain('moves to "doing"');
    expect(t).toContain("reports back with a card");
  });

  test("a verify says it changes nothing and doesn't claim the item moves to doing (Agents.dispatch leaves it)", () => {
    const t = explainOption({ label: "Check for me", effect: { type: "dispatch", action: "verify" } }, q());
    expect(t).toContain("It changes nothing");
    expect(t).toContain("stays where it is");
    expect(t).not.toContain("doing");
  });

  test("a stopped-agents fold says unsent rows come back, not that the card is gone", () => {
    const t = explainOption({ label: "Check ticked", effect: { type: "stoppedPicks", act: "check", jobs: {} } }, q({ itemId: undefined }));
    expect(t).toContain("come back on a new card");
    expect(t).not.toContain("This card closes");
  });

  test("snooze and noop say the card comes back / only closes, and don't claim it closes for good", () => {
    const s = explainOption({ label: "Later", effect: { type: "snooze", minutes: 120 } }, q());
    expect(s).toContain("Hides this card for 2 hours");
    expect(s).toContain("the same card comes back");
    expect(s).not.toContain("This card closes");
    expect(explainOption({ label: "Keep them", effect: { type: "noop" } }, q())).toBe("Closes this card. Nothing else changes.");
  });

  test("a batch card's mark-all is one line with the count", () => {
    const t = explainOption({ label: "Mark all 3 done", effect: { type: "multi", effects: ["a", "b", "c"].map((id) => ({ type: "status" as const, status: "done" as const, itemId: id })) } }, q({ itemId: undefined }));
    expect(t).toStartWith("Closes all 3 as done.");
  });

  test("the card's own hint leads, and a typed note says where it goes", () => {
    const t = explainOption({ label: "Push", hint: "Your standup is at 10.", effect: { type: "schedule", at: "", label: "tomorrow 09:30" } }, q(), { typed: true });
    expect(t).toStartWith("Your standup is at 10. Schedules it for tomorrow 09:30.");
    expect(t).toEndWith("Your note is kept with the answer.");
    expect(explainOption({ label: "Go", effect: { type: "dispatch", action: "work" } }, q(), { typed: true })).toEndWith("Your note goes to the agent.");
  });
});

describe("the Agent: deal with it now button", () => {
  test("on item cards without their own work agent; a brief on meeting cards; never on tick-box or closed-item cards", () => {
    expect(showAgentNow(q(), item())).toBe(true);
    expect(agentNowAction(q(), item())).toBe("work");
    expect(showAgentNow(q({ options: [{ id: "go", label: "Send an agent", effect: { type: "dispatch", action: "work" } }] }), item())).toBe(false);
    expect(agentNowAction(q({ itemId: undefined, eventId: "e1" }))).toBe("prep");
    expect(showAgentNow(q({ itemId: undefined }))).toBe(false);
    expect(showAgentNow(q({ picks: [{ id: "x", label: "x" }] }), item())).toBe(false);
    expect(showAgentNow(q(), item({ status: "done" }))).toBe(false);
    // An agent already on it, a just-ended meeting card: no button.
    expect(showAgentNow(q(), item(), true)).toBe(false);
    expect(agentNowAction(q({ itemId: undefined, eventId: "e1", kind: "review" }))).toBeUndefined();
    expect(agentNowAction(q(), item({ kind: "post" }))).toBe("draft");
    expect(explainAgentNow("work")).toContain("this card closes");
    expect(explainOption({ label: "Check all", effect: { type: "stoppedPicks", act: "check", all: true, jobs: {} } }, q({ itemId: undefined }))).toContain("Rows that can't be sent come back");
  });

  test("a meeting card whose brief is being written shows no Agent button", () => {
    const meetingCard = q({ itemId: undefined, eventId: "e9", kind: "prep", options: [{ id: "no", label: "No", effect: { type: "noop" } }] });
    const prep = item({ id: "p9", kind: "meeting", source: { type: "calendar", key: "cal:prep:e9" } });
    const live = { id: "j9", kind: "action", name: "prep", itemId: "p9", status: "queued", title: "Prep", surface: "headless", tail: [], createdAt: "2026-11-18T09:00:00Z" } as Job;
    expect(renderToStaticMarkup(<Focus q={meetingCard} total={1} items={[prep]} jobs={[]} onSkip={() => {}} onOpenItem={() => {}} />)).toContain("Agent: brief me now");
    expect(renderToStaticMarkup(<Focus q={meetingCard} total={1} items={[prep]} jobs={[live]} onSkip={() => {}} onOpenItem={() => {}} />)).not.toContain("Agent: brief me now");
  });

  test("the focus card shows the button and the what-happens line", () => {
    const html = renderToStaticMarkup(<Focus q={q()} total={1} items={[item()]} onSkip={() => {}} onOpenItem={() => {}} />);
    expect(html).toContain(AGENT_NOW_LABEL);
    expect(html).toContain("Point at a button to see exactly what it does.");
    // Every option carries its explanation as a tooltip too.
    expect(html).toContain("Committed list for today");
  });
});

describe("the queue opens to every waiting card", () => {
  const cards = Array.from({ length: 12 }, (_, i) => q({ id: `q${i}`, prompt: `Card ${i}` }));
  test("+N more is a button, not a dead label", () => {
    const html = renderToStaticMarkup(<Queue queue={cards} items={[]} now={new Date("2026-11-18T10:00:00Z")} onPick={() => {}} />);
    expect(html).toMatch(/<button[^>]*class="qchip more"[^>]*>\+4 more/);
  });
});

describe("Agents panel shows your agents, not sweep plumbing", () => {
  const job = (id: string, kind: Job["kind"], status: Job["status"], title: string, minsAgo = 10): Job =>
    ({ id, kind, name: kind === "sweep" ? "transcripts" : "work", title, surface: "headless", status, tail: [], createdAt: new Date(Date.now() - minsAgo * 60_000).toISOString(), finishedAt: status === "done" || status === "failed" ? new Date(Date.now() - minsAgo * 60_000).toISOString() : undefined }) as Job;
  test("sweeps fold into a background count; a failed sweep still shows; old finished agents drop off", () => {
    const html = renderToStaticMarkup(<AgentsPanel cmux jobs={[
      job("a", "action", "running", "Work · live one"),
      job("b", "action", "done", "Work · finished one"),
      job("c", "action", "done", "Work · yesterday's", 60 * 20),
      job("s1", "sweep", "done", "Scan meeting transcripts"),
      job("s2", "sweep", "failed", "Read the calendar"),
    ]} />);
    expect(html).toContain("Work · live one");
    expect(html).toContain("Work · finished one");
    expect(html).not.toContain("yesterday&#x27;s");
    expect(html).toContain("Read the calendar");
    expect(html).not.toContain("Scan meeting transcripts");
    expect(html).toContain("2 background runs");
  });
});

describe("Brief me on a schedule row", () => {
  const ev = { id: "e1", title: "Roadmap", start: "2026-11-18T15:00:00Z", end: "2026-11-18T15:30:00Z", attendees: ["Priya"] };
  const prep = item({ id: "p1", kind: "meeting", status: "doing", source: { type: "calendar", key: "cal:prep:e1" } });
  const pjob = (status: Job["status"]) => ({ id: "j", kind: "action", name: "prep", itemId: "p1", status, title: "Prep", surface: "headless", tail: [], createdAt: "2026-11-18T14:00:00Z" }) as Job;
  const html = (items: Item[], jobs: Job[]) => renderToStaticMarkup(<BriefMe e={ev} items={items} jobs={jobs} />);
  test("no brief yet: Brief me; writing: Briefing…; done (item closed or its last run done): Brief ready", () => {
    expect(html([], [])).toContain(">Brief me<");
    expect(html([prep], [pjob("running")])).toContain("Briefing…");
    expect(html([prep], [pjob("done")])).toContain("Brief ready");
    expect(html([{ ...prep, status: "done" }], [])).toContain("Brief ready");
    expect(html([prep], [pjob("failed")])).toContain(">Brief me<");
  });
});

describe("pile helpers", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  test("sources: to-dos, reflection and learn proposals, writing, meetings, you", () => {
    expect(pileSource({ kind: "task", source: { type: "memory", label: "active-todos · Immediate" } })).toBe("todos");
    expect(pileSource({ kind: "task", source: { type: "memory", label: "Proposals 2026-11-17 · High Priority" } })).toBe("reflection");
    expect(pileSource({ kind: "task", source: { type: "memory", label: "Proposals 2026-11-17 · Learn (session 01a1)" } })).toBe("learn");
    expect(pileSource({ kind: "post", source: { type: "agent", label: "Writing scout" } })).toBe("writing");
    expect(pileSource({ kind: "task", source: { type: "transcript" } })).toBe("meetings");
    expect(pileSource({ kind: "task", source: { type: "voice" } })).toBe("you");
  });
  test("ages from createdAt; only proposed; oldest first", () => {
    expect(pileAge({ createdAt: "2026-11-15T12:00:00Z" }, now)).toBe("week");
    expect(pileAge({ createdAt: "2026-10-01T12:00:00Z" }, now)).toBe("older");
    const list = pileItems([item({ id: "new", status: "proposed", createdAt: "2026-11-17T00:00:00Z" }), item({ id: "old", status: "proposed", createdAt: "2026-10-01T00:00:00Z" }), item({ id: "x", status: "today" })], now);
    expect(list.map((i) => i.id)).toEqual(["old", "new"]);
  });
});
