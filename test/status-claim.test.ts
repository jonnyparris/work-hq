import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { claimsStatus } from "../src/shared/dead-button.ts";

// 10-23 18:26: "I have completed the reference checks for Joao Duarte". Triage replied "Marked the Joao Duarte
// reference calls done." Nothing was marked (the update's id didn't resolve, or updates[] was empty) until
// the owner did it by hand at 19:48. Skipped updates now hit the journal, and a status claim with nothing
// applied gets "(Nothing was marked.)". Sibling of the dispatch check in claim-before-run.test.ts.

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };
const CLAIM = "Marked the Joao Duarte reference calls done.";

function setup(model: (itemId: string) => object) {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  hub.dispatcher = agents;
  const item = hub.createItem({ title: "Joao Duarte reference calls", kind: "task", status: "today" });
  (agents as any).runHeadless = async () => ({ ok: true, text: JSON.stringify(model(item.id)) });
  (agents as any).launchAction = async () => {};
  const job = () => hub.store.jobs().find((j) => j.kind === "triage" && j.name === "chat")!;
  const journal = () => hub.store.journal().map((e) => e.text);
  return { hub, agents, item, job, journal };
}

test("reply claims a status, updates[] empty: suffix + journal line, job summary matches", async () => {
  const { agents, item, hub, job, journal } = setup(() => ({ reply: CLAIM, updates: [] }));
  const r = await agents.triage("I have completed the reference checks for Joao Duarte");
  expect(r.reply).toBe(`${CLAIM} (Nothing was marked.)`);
  expect(job().summary).toBe(r.reply);
  expect(hub.store.item(item.id)!.status).toBe("today");
  expect(journal().some((t) => t.includes("claimed a status change but none was applied"))).toBe(true);
});

test("update with an unknown id: journaled as skipped, and the reply admits nothing was marked", async () => {
  const { agents, journal } = setup(() => ({ reply: CLAIM, updates: [{ id: "it_nope", status: "done" }] }));
  const r = await agents.triage("I have completed the reference checks for Joao Duarte");
  expect(r.reply).toBe(`${CLAIM} (Nothing was marked.)`);
  expect(journal()).toContain("Triage update skipped: unknown item it_nope");
});

test("update applied: reply untouched, no claim journal line", async () => {
  const { agents, item, hub, journal } = setup((id) => ({ reply: CLAIM, updates: [{ id, status: "done" }] }));
  const r = await agents.triage("I have completed the reference checks for Joao Duarte");
  expect(r.reply).toBe(CLAIM);
  expect(hub.store.item(item.id)!.status).toBe("done");
  expect(journal().some((t) => t.includes("claimed a status change") || t.includes("update skipped"))).toBe(false);
});

test("one good update, one unknown: skip is journaled, reply untouched (something was marked)", async () => {
  const { agents, journal } = setup((id) => ({ reply: CLAIM, updates: [{ id, status: "done" }, { id: "it_gone", status: "done" }] }));
  const r = await agents.triage("done with Joao's references");
  expect(r.reply).toBe(CLAIM);
  expect(journal()).toContain("Triage update skipped: unknown item it_gone");
});

test("update on a known id with no status (detail only): still 'Nothing was marked.'", async () => {
  const { agents } = setup((id) => ({ reply: CLAIM, updates: [{ id, detail: "refs fine" }] }));
  const r = await agents.triage("I have completed the reference checks for Joao Duarte");
  expect(r.reply).toBe(`${CLAIM} (Nothing was marked.)`);
});

test("bulk done counts as applied; bulk dispatch that ran doesn't", async () => {
  const { agents, hub, item } = setup(() => ({}));
  const other = hub.createItem({ title: "Check the policy", kind: "task", status: "today" });
  const dq = hub.ask({ kind: "open", itemId: other.id, key: "d", priority: 80, prompt: "Check it?", options: [
    { id: "go", label: "Check", effect: { type: "dispatch", action: "verify" } },
  ] })!;
  hub.ask({ kind: "open", itemId: item.id, key: "k", priority: 80, prompt: "Done?", options: [
    { id: "done", label: "Done", effect: { type: "status", status: "done" } },
  ] });
  const a = agents as any;
  const bulkCounts: number[] = [];
  const bulk = hub.bulk.bind(hub);
  hub.bulk = async (b) => { const r = await bulk(b); bulkCounts.push(r.count); return r; };
  a.runHeadless = async () => ({ ok: true, text: JSON.stringify({ reply: "Marked everything done.", bulk: [{ op: "dispatch", ids: [dq.id] }] }) });
  expect((await agents.triage("dispatch them")).reply).toBe("Marked everything done. (Nothing was marked.)");
  expect(bulkCounts).toEqual([1]); // the dispatch did touch a card
  hub.ask({ kind: "open", itemId: other.id, key: "d2", priority: 80, prompt: "Check again?", options: [
    { id: "go", label: "Check", effect: { type: "dispatch", action: "verify" } },
  ] });
  const dq2 = hub.store.questions("open").find((x) => x.key === "d2")!;
  a.runHeadless = async () => ({ ok: true, text: JSON.stringify({ reply: "Dispatched the check.", bulk: [{ op: "dispatch", ids: [dq2.id] }] }) });
  expect((await agents.triage("check it")).reply).toBe("Dispatched the check."); // bulk dispatch backs the claim
  const q = hub.store.questions("open").find((x) => x.itemId === item.id)!;
  a.runHeadless = async () => ({ ok: true, text: JSON.stringify({ reply: "Marked everything done.", bulk: [{ op: "done", ids: [q.id] }] }) });
  expect((await agents.triage("all done")).reply).toBe("Marked everything done.");
  expect(hub.store.item(item.id)!.status).toBe("done");
});

test("no status claim, nothing applied: reply untouched", async () => {
  const { agents, journal } = setup(() => ({ reply: "Added a task to book the room.", items: [{ title: "Book the room", kind: "task" }] }));
  const r = await agents.triage("book the room");
  expect(r.reply).toBe("Added a task to book the room.");
  expect(journal().some((t) => t.includes("claimed a status change"))).toBe(false);
});

// Real triage replies from the jobs table (10-24, 233 replies).
test("claimsStatus: past-tense status claims hit; offers, negations, questions, meetings and reminders don't", () => {
  for (const r of [
    "Marked the Joao Duarte reference calls done.",
    "Marked waiting on Rui, chase scheduled for Thursday.",
    "Marked done — default-gateway fallback covers it.",
    "Dropped — won't ask Kunwar Pratap.",
    "Dropped it; no always-on listening.",
    "Dropped — you've already pinged.",
    "Assumed OpenAI for now and parked it to chase later.",
    "Asking Beatriz to figure it out; marked waiting on her.",
    "Parked as later; too early for CI.",
    "Marked as yours for today.",
    "Today's three: onsite activities. Marked the onsite as today and answered the morning question.",
    "Set it to done.",
    "Set the task to done.",
    "Set the to-do item to done.",
    "Set the to do list item to done.",
    "Not the Sofia ones, but I marked the Joao calls done.",
    "Sofia's task closed.",
    "Not those ones\n- I marked the Joao calls done.",
    "Not the Sofia ones - I marked the Joao calls done.",
    "Wasn't ready so I dropped it.",
    "That's fine, dropped Sofia's task.",
    "It's closed, marked the Joao calls done.",
    "I'd marked the calls done already.",
    "Set the on-call rota to done.",
    "Sofia's 1-1 is closed for today and I marked the Joao calls done.",
  ]) expect([r, claimsStatus(r)]).toEqual([r, true]);
  for (const r of [
    "There's no reopen-from-journal yet. Logged it as a Work HQ idea; for now, tell me the item and I'll set it back to doing or re-dispatch it.",
    "No commitments. Sofia 1-1 moved to tomorrow, noted.",
    "Set a reminder for Monday 09:30 to review the updated public draft together.",
    "Scheduled for Thursday: you'll chase Rui then.",
    "I'll remind you about the Joao Duarte reference calls tomorrow (Fri) at 09:30.",
    "Nothing was marked done.",
    "Not marked: I couldn't find the item.",
    "Should it be marked done?",
    "Added a task to set PagerDuty service IDs on the three repos.",
    "Sent an agent to collapse the commitments section and the status tabs strip (capture/proposed/scheduled/waiting/closed) by default.",
    "Tabs for inbox/waiting/closed are next.",
    "Sofia's 1-1 is closed for today.",
    "That thread was archived last week, so I left it.",
    "That one is already closed.",
    "That's closed.",
    "That’s closed.",
    "The closed Joao calls are fine.",
    "I’ll set it to done.",
    "I'd set the Joao calls to done if you like.",
    "I'm going to set it to done.",
    "The Joao calls were closed and archived.",
    "It's closed and archived.",
    "I marked no items done.",
    "I am going to set it to done.",
    "I'm not so sure I marked it done.",
    "I marked nothing.",
    "Set up the calendar block to today so you see it.",
    "Set aside time for it to today.",
    "",
    undefined,
  ]) expect([r, claimsStatus(r)]).toEqual([r, false]);
});
