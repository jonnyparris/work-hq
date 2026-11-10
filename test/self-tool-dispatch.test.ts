import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { config } from "../src/server/config.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { triagePrompt } from "../src/server/prompts.ts";
import { parksDispatch } from "../src/shared/dead-button.ts";
import type { Job } from "../src/shared/types.ts";

// 11-06: three asks about the owner's own tools (and a fourth, the on-call wiki move) went to Proposed with
// "Not dispatched; say the word…". Triage set status "proposed", so no inbox card with "Send an agent" ever showed;
// one was hunted for at 22:23. The words (first link's host swapped), replies and statuses below are the real ones from the jobs/items tables.
const ASKS = [
  {
    said: "https://git.example.com/ci/ai/-/blob/main/packages/cli/README.md let's starting using this as part of MR authoring workflows",
    reply: "Added a task to adopt the ci/ai CLI in MR authoring workflows. Nothing dispatched; say the word if you want an agent to wire it in.",
    title: "Start using the ci/ai CLI (packages/cli) in MR authoring workflows",
  },
  {
    said: "we need to migrate GLM5.3 flash usage to Deepseek 4.1 flash in all relevant projects using workers ai",
    reply: "Logged a task to migrate GLM 5.3 flash to DeepSeek 4.1 flash across Workers AI projects, and linked the GLM reviewer item. Not dispatched; say the word to send an agent to find and migrate the call sites.",
    title: "Migrate GLM 5.3 flash usage to DeepSeek 4.1 flash in all Workers AI projects",
  },
  {
    said: "… all of that should be part of the kind of overall nightly reflection",
    reply: "Logged a task to widen the nightly reflection into a team pulse: MRs, releases, Google Chat highlights, and agent-memory reflection follow-through. Nothing dispatched.",
    title: "Nightly reflection: add a team pulse (MRs, releases, Chat highlights, memory-reflection status)",
  },
];

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };

function setup(model: object) {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  hub.dispatcher = agents;
  const a = agents as any;
  const dispatched: unknown[][] = [];
  a.runHeadless = async () => ({ ok: true, text: JSON.stringify(model) });
  a.launchAction = async () => {};
  const realDispatch = agents.dispatch.bind(agents);
  agents.dispatch = async (...args: Parameters<Agents["dispatch"]>) => (dispatched.push(args), realDispatch(...args));
  return { hub, agents, dispatched };
}

const parkedCards = (hub: Hub) => hub.store.questions("open").filter((q) => q.key.startsWith("parked:"));

test("triage prompt (chat): own-tools asks in 'let's / we need to / should' words are requests to act", () => {
  const p = triagePrompt(ASKS[1].said, { now: new Date(), items: [], events: [] }, "chat");
  for (const w of [`"let's…"`, `"we need to…"`, `"X should also…"`, `"fix it"`, `dispatch "work"`, `"say the\nword"`]) expect(p).toContain(w);
  expect(p).toContain("which includes the own-tools rule above");
  const review = triagePrompt("notes", { now: new Date(), items: [], events: [] }, "review");
  expect(review).not.toContain("own-tools");
});

for (const ask of ASKS) {
  test(`triage parks "${ask.title.slice(0, 40)}…" → one-tap Send an agent card; tapping it dispatches work`, async () => {
    const { hub, agents, dispatched } = setup({ reply: ask.reply, items: [{ title: ask.title, kind: "task", status: "proposed" }] });
    const r = await agents.triage(ask.said);
    const item = hub.store.items().find((i) => i.title === ask.title)!;
    const cards = parkedCards(hub);
    expect(cards.map((q) => [q.itemId, q.kind])).toEqual([[item.id, "dispatch"]]);
    expect(cards[0].options[0]).toMatchObject({ id: "go", label: "Send an agent", effect: { type: "dispatch", action: "work" } });
    // "Nothing dispatched" is not a dispatch claim, so no "(No agent started." suffix.
    expect(r.reply).toBe(`${ask.reply} (Send an agent? is on a card.)`);
    expect(dispatched).toHaveLength(0);
    await hub.answer(cards[0].id, "go");
    expect(dispatched.map((d) => d.slice(0, 2))).toEqual([[item.id, "work"]]);
  });
}

test("triage that dispatched: no parked card", async () => {
  const { hub, agents, dispatched } = setup({
    reply: "Logged it and sent an agent to wire the ci/ai CLI in.",
    items: [{ title: ASKS[0].title, kind: "task", status: "proposed" }],
    dispatch: [{ id: "new:0", action: "work", note: "goal: …" }],
  });
  await agents.triage(ASKS[0].said);
  expect(dispatched).toHaveLength(1);
  expect(parkedCards(hub)).toHaveLength(0);
});

test("triage that asked a question, or didn't park: no parked card", async () => {
  const asked = setup({ reply: "Not dispatched yet.", items: [{ title: "x", kind: "task" }], question: { prompt: "Send an agent?", options: ["Yes", "No"] } });
  await asked.agents.triage("let's do x");
  expect(parkedCards(asked.hub)).toHaveLength(0);
  const plain = setup({ reply: "Logged it for Thursday.", items: [{ title: "y", kind: "task", status: "proposed" }] });
  const r = await plain.agents.triage("remind me about y");
  expect(parkedCards(plain.hub)).toHaveLength(0);
  expect(r.reply).toBe("Logged it for Thursday.");
});

test("parksDispatch: parked or offered agents hit; started ones and plain logs don't", () => {
  for (const r of [...ASKS.map((a) => a.reply), "Captured as a task. Not dispatched.", "Want me to send an agent?", "No agent started."])
    expect([r, parksDispatch(r)]).toEqual([r, true]);
  for (const r of ["Sent an agent to ask Maryna.", "Logged it for Thursday.", "Marked done.", "", undefined])
    expect([r, parksDispatch(r)]).toEqual([r, false]);
});

test("parked card options: Send an agent, Mine today/later, Scheduled for…, Drop", async () => {
  const { hub, agents } = setup({ reply: ASKS[2].reply, items: [{ title: ASKS[2].title, kind: "task", status: "proposed" }] });
  await agents.triage(ASKS[2].said);
  expect(parkedCards(hub)[0].options.map((o) => o.id)).toEqual(["go", "today", "later", "when", "drop"]);
});

test("parked ask matched to an existing item (updates[] only): the card goes on that item, once", async () => {
  const { hub, agents } = setup({});
  const it = hub.createItem({ title: "Nightly reflection team pulse", kind: "task", status: "proposed" });
  (agents as any).runHeadless = async () => ({ ok: true, text: JSON.stringify({ reply: "Added that to the team-pulse task. Not dispatched; say the word.", updates: [{ id: it.id, detail: "also chat highlights" }] }) });
  const r1 = await agents.triage("the pulse should also cover chat highlights");
  const r2 = await agents.triage("the pulse should also cover chat highlights");
  expect(parkedCards(hub).map((q) => q.itemId)).toEqual([it.id]);
  for (const r of [r1, r2]) expect(r.reply).toEndWith("(Send an agent? is on a card.)");
});

test("parked: done items skipped, then at most 3 cards; nothing in review mode", async () => {
  const items = [
    { title: "a", kind: "task", status: "done" },
    { title: "b", kind: "idea", status: "proposed" },
    { title: "c", kind: "task", status: "proposed" },
    { title: "d", kind: "task", status: "proposed" },
  ];
  const chat = setup({ reply: "Logged four. Not dispatched.", items });
  await chat.agents.triage("let's do a, b, c and d");
  expect(parkedCards(chat.hub).map((q) => q.prompt).sort()).toEqual(["b", "c", "d"]);
  const review = setup({ reply: "Logged four. Not dispatched.", items });
  const r = await review.agents.triage("notes from the sync", "review");
  expect(parkedCards(review.hub)).toHaveLength(0);
  expect(r.reply).toBe("Logged four. Not dispatched.");
});

test("own-tools rule names config.repos projects, deduped; none set → no repo clause", () => {
  const ctx = { now: new Date(), items: [], events: [] };
  const saved = config.repos.splice(0);
  try {
    expect(triagePrompt("x", ctx, "chat")).toContain("MR\nworkflows. Worded as");
    config.repos.push({ project: "work-hq", dir: "/a" }, { project: "work-hq", dir: "/b" }, { match: "^x", dir: "/c" }, { project: "dodo", dir: "/d" });
    expect(triagePrompt("x", ctx, "chat")).toContain("MR\nworkflows, and the repos work-hq, dodo. Worded as");
  } finally {
    config.repos.splice(0, config.repos.length, ...saved);
  }
});

test("parked: created items first; none open → the updated item; a live agent → no card", async () => {
  const { hub, agents } = setup({});
  const old = hub.createItem({ title: "team pulse", kind: "task", status: "proposed" });
  const busy = hub.createItem({ title: "busy one", kind: "task", status: "doing" });
  const a = agents as any;
  const reply = (model: object) => (a.runHeadless = async () => ({ ok: true, text: JSON.stringify(model) }));
  reply({ reply: "Logged y. Not dispatched.", items: [{ title: "y", kind: "task" }], updates: [{ id: old.id, detail: "d" }] });
  await agents.triage("let's do y");
  expect(parkedCards(hub).map((q) => q.prompt)).toEqual(["y"]);
  reply({ reply: "X is done; added to the pulse. Not dispatched.", items: [{ title: "x", kind: "task", status: "done" }], updates: [{ id: old.id, detail: "d" }, { id: old.id, detail: "e" }] });
  await agents.triage("x is done, and the pulse should cover chat");
  expect(parkedCards(hub).map((q) => q.prompt).sort()).toEqual(["team pulse", "y"]);
  const job: Job = { id: "", kind: "action", name: "work", title: "w", surface: "headless", status: "running", tail: [], createdAt: new Date().toISOString() };
  hub.putJob({ ...job, id: "job_note", kind: "triage", name: "note", itemId: old.id }); // a note reader isn't an agent on it
  hub.putJob({ ...job, id: "job_live", itemId: busy.id });
  reply({ reply: "Noted on it. Not dispatched.", updates: [{ id: busy.id, detail: "f" }] });
  const r = await agents.triage("busy one should also do f");
  expect(parkedCards(hub).some((q) => q.itemId === busy.id)).toBe(false);
  expect(r.reply).toBe("Noted on it. Not dispatched.");
  // Created item done, updated item open: the card goes on the updated one.
  const fresh = setup({});
  const keep = fresh.hub.createItem({ title: "unrelated", kind: "task", status: "proposed" });
  (fresh.agents as any).runHeadless = async () => ({ ok: true, text: JSON.stringify({ reply: "Logged z. Not dispatched.", items: [{ title: "z", kind: "task", status: "done" }], updates: [{ id: keep.id, detail: "g" }] }) });
  await fresh.agents.triage("z is done; note g on unrelated");
  expect(parkedCards(fresh.hub).map((q) => q.prompt)).toEqual(["unrelated"]);
  // A note-reader job on the updated item doesn't block its card (only action jobs do).
  reply({ reply: "Added to the pulse. Not dispatched.", updates: [{ id: old.id, detail: "h" }] });
  hub.expireQuestion(parkedCards(hub).find((q) => q.itemId === old.id)!.id, "test");
  await agents.triage("the pulse should cover h");
  expect(parkedCards(hub).some((q) => q.itemId === old.id)).toBe(true);
});

test("parked: 4 eligible items → exactly 3 cards", async () => {
  const { hub, agents } = setup({ reply: "Logged four. Not dispatched.", items: ["b", "c", "d", "e"].map((title) => ({ title, kind: "task", status: "proposed" })) });
  await agents.triage("let's do b, c, d and e");
  expect(parkedCards(hub).map((q) => q.prompt).sort()).toEqual(["b", "c", "d"]);
});
