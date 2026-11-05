import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { claimsDispatch } from "../src/shared/dead-button.ts";
import { Store } from "../src/server/db.ts";
import { Hub, queuedNote } from "../src/server/hub.ts";
import type { Question } from "../src/shared/types.ts";

// 10-16 20:44:45Z: a note job's summary said "Asking Maryna in chat to confirm she owns the crawl-completion
// webhook." The reply agent that sent the DM started 5 s later. Same class as "Booked" (ff3d07e, schedule-reply.test.ts):
// the model words the outcome before the job that owns it has run. Wherever a reply sits next to queued work,
// the summary / toast is fixed words that are true the moment it's shown.

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };
const CLAIM = "Asking Maryna in chat to confirm she owns the crawl-completion webhook.";
const TITLE = "Confirm Maryna owns the crawl-completion webhook RM";

function setup(model: object) {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  hub.dispatcher = agents;
  const a = agents as any;
  const toasts: string[] = [];
  const dispatched: unknown[][] = [];
  const scheduled: unknown[][] = [];
  a.runHeadless = async () => ({ ok: true, text: JSON.stringify(model) });
  const realDispatch = agents.dispatch.bind(agents);
  // Record and create the job, but never launch anything.
  a.launchAction = async () => {};
  agents.dispatch = async (...args: Parameters<Agents["dispatch"]>) => (dispatched.push(args), realDispatch(...args));
  agents.scheduleFromWords = async (...args: unknown[]) => void scheduled.push(args);
  const toast = hub.toast.bind(hub);
  hub.toast = (text, tone) => (toasts.push(text), toast(text, tone));
  const item = hub.createItem({ title: TITLE, kind: "task", status: "inbox" });
  const q = hub.ask({
    kind: "open", itemId: item.id, key: `t:${item.id}`, priority: 80, prompt: "Does Maryna own it?",
    options: [
      { id: "chase", label: "Ask her", effect: { type: "dispatch", action: "reply" } },
      { id: "done", label: "She does", effect: { type: "status", status: "done" } },
    ],
  }) as Question;
  return { hub, agents, toasts, dispatched, scheduled, item, q };
}

const noteJob = (hub: Hub) => hub.store.jobs().find((j) => j.name === "note")!;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

test("note → dispatch: job summary and toast say an agent was sent, not that Maryna was asked", async () => {
  const { hub, toasts, dispatched, item, q } = setup({ dispatch: { action: "reply", note: "ask Maryna in DM" }, reply: CLAIM });
  await hub.note(q.id, "ask Maryna in chat if she owns it");
  await settle();
  expect(dispatched.map((d) => d.slice(0, 2))).toEqual([[item.id, "reply"]]);
  expect(noteJob(hub).summary).toBe(`Sent an agent to send the message: ${TITLE}`);
  expect(toasts).toContain(`Sent an agent to send the message: ${TITLE}`);
  expect(toasts.join("\n")).not.toContain("Asking Maryna");
});

test("note → pick an option that dispatches: 'Noted → Ask her', not the model's claim", async () => {
  const { hub, toasts, dispatched, q } = setup({ pick: "chase", reply: CLAIM });
  await hub.note(q.id, "yes, chase her");
  await settle();
  expect(dispatched).toHaveLength(1);
  expect(noteJob(hub).summary).toBe("Noted → Ask her");
  expect(toasts).toContain("Noted → Ask her");
  expect(toasts.join("\n")).not.toContain("Asking Maryna");
});

test("note → when: the scheduler owns the outcome; summary says it's working it out", async () => {
  const { hub, toasts, scheduled, item, q } = setup({ when: "Thursday", reply: "Scheduled for Thursday 09:30." });
  await hub.note(q.id, "chase on Thursday");
  await settle();
  expect(scheduled).toEqual([[item.id, "Thursday"]]);
  expect(noteJob(hub).summary).toBe("Working out when from “Thursday”");
  expect(toasts.join("\n")).not.toContain("Scheduled for Thursday");
});

test("note → status: the change has already happened, so the model's reply stays", async () => {
  const { hub, toasts, item, q } = setup({ status: "done", reply: "Marked done: she owns it." });
  await hub.note(q.id, "she confirmed in standup");
  await settle();
  expect(hub.store.item(item.id)!.status).toBe("done");
  expect(noteJob(hub).summary).toBe("Marked done: she owns it.");
  expect(toasts).toContain("Marked done: she owns it.");
});

test("triage → dispatch to an id that doesn't exist: the reply admits no agent started", async () => {
  const { hub, agents, dispatched } = setup({ reply: "Sent an agent to ask Maryna.", dispatch: [{ id: "it_nope", action: "reply", note: "ask" }] });
  const r = await agents.triage("ask Maryna if she owns the webhook");
  expect(dispatched).toHaveLength(1);
  expect(r.reply).toBe("Sent an agent to ask Maryna. (No agent started for 1 of those: item not found.)");
  expect(hub.store.jobs().find((j) => j.kind === "triage" && j.name === "chat")!.summary).toBe(r.reply);
});

test("triage → dispatch that starts: reply untouched (prompt asks for intent wording)", async () => {
  const { agents, item, dispatched } = setup({});
  (agents as any).runHeadless = async () => ({ ok: true, text: JSON.stringify({ reply: "Sent an agent to ask Maryna.", dispatch: [{ id: item.id, action: "reply" }] }) });
  const r = await agents.triage("ask Maryna if she owns the webhook");
  expect(dispatched).toHaveLength(1);
  expect(r.reply).toBe("Sent an agent to ask Maryna.");
});

test("triage → reply claims an agent but dispatch[] is empty: suffix + journal line", async () => {
  const { hub, agents, dispatched } = setup({ reply: "Dispatched an agent to ask Maryna.", items: [{ title: "Ask Maryna", kind: "message" }] });
  const r = await agents.triage("ask Maryna if she owns the webhook");
  expect(dispatched).toHaveLength(0);
  expect(r.reply).toBe("Dispatched an agent to ask Maryna. (No agent started.)");
  expect(hub.store.jobs().find((j) => j.kind === "triage" && j.name === "chat")!.summary).toBe(r.reply);
  expect(hub.store.journal().some((e) => e.text.includes("claimed a dispatch but dispatch[] was empty"))).toBe(true);
});

test("triage → no claim, no dispatch: reply untouched, no journal line", async () => {
  const { hub, agents } = setup({ reply: "Captured as a task. Not dispatched." });
  const r = await agents.triage("note: prune idle cmux sessions");
  expect(r.reply).toBe("Captured as a task. Not dispatched.");
  expect(hub.store.journal().some((e) => e.text.includes("claimed a dispatch"))).toBe(false);
});

// Real triage replies from the jobs table (10-20).
test("claimsDispatch: past-tense claims hit; offers, negations and questions don't", () => {
  for (const r of [
    "Dispatched an agent to tighten the spec and add SVGs; fixed Riri → Rui.",
    "Sent an agent to check the policy.",
    "Sending an agent to smoke-test the RTK ear in TechVibeSync.",
    "Asking Beatriz to figure it out; marked waiting on her.",
    "Queued: archive the old wiki page. Agent dispatched.",
    "Added a task and dispatched it to work.",
  ]) expect([r, claimsDispatch(r)]).toEqual([r, true]);
  for (const r of [
    "Captured as a task to auto-prune idle cmux sessions. Not dispatched.",
    "Captured the bridge idea. Not dispatching anything yet.",
    "I can't open PROJ-1696 from here. Want me to dispatch a prep task to read the ticket?",
    "Can't generate images from here. Logged it as a task so you can dispatch it to an agent or do it yourself.",
    "There's no reopen-from-journal yet. For now, tell me the item and I'll set it back to doing or re-dispatch it.",
    "Added a blog post idea about Work HQ.",
    "",
    undefined,
  ]) expect([r, claimsDispatch(r)]).toEqual([r, false]);
});

test("queuedNote: open-and-keep and status picks fall through to the model's reply", () => {
  const q = { options: [
    { id: "o", label: "Open", effect: { type: "open" as const, url: "https://x", keep: true } },
    { id: "s", label: "Done", effect: { type: "status" as const, status: "done" as const } },
    { id: "m", label: "Both", effect: { type: "multi" as const, effects: [{ type: "noop" as const }, { type: "dispatch" as const, action: "work" as const }] } },
  ] };
  expect(queuedNote(q, { pick: "s" }, "t")).toBeUndefined();
  expect(queuedNote(q, { pick: "m" }, "t")).toBe("Noted → Both");
  expect(queuedNote(q, { pick: "o", dispatch: { action: "verify" } }, "t")).toBe("Sent an agent to check: t");
  expect(queuedNote(q, { dispatch: { action: "verify" } })).toBeUndefined(); // no item and no item picks → applyNote can't dispatch
  // …unless the card makes its own item through its dispatch option (the coaching move).
  const coach = { key: "coach:2026-10-19", options: [...q.options, { id: "go", label: "Hand to an agent", effect: { type: "dispatch" as const, action: "work" as const } }] };
  expect(queuedNote(coach, { dispatch: { action: "verify" } })).toBe("Noted → Hand to an agent");
  expect(queuedNote({ ...coach, key: "recheck:x" }, { dispatch: { action: "work" } })).toBeUndefined();
  expect(queuedNote({ ...coach, key: "review:e1" }, { dispatch: { action: "work" } })).toBeUndefined();
  expect(queuedNote({ ...coach, itemId: "it1" }, { dispatch: { action: "work" } })).toBeUndefined();
});
