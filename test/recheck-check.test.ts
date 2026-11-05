// 10-27 11:46: "check them all yourself" typed on the Recheck card. The card has no single item, so applyNote
// parked it until the morning, and it sat open for a week. The card now has "Check for me": one verify agent
// across its items, and a typed "do it / check them" goes through it.
import { beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { type Dispatcher, Hub, queuedNote } from "../src/server/hub.ts";
import { JiraStates } from "../src/server/jira-state.ts";
import { MrStates } from "../src/server/mr-state.ts";
import { type PrInfo, PrStates } from "../src/server/pr-state.ts";
import { Prompter, RECHECK_VERIFY_NOTE } from "../src/server/prompter.ts";
import type { NoteDecision } from "../src/shared/types.ts";

const PR = (n: number) => `https://github.com/acme/dodo/pull/${n}`;
const merged = (): PrInfo => ({ state: "merged", mergedAt: new Date(Date.now() - 3_600_000).toISOString() });
let hub: Hub;
let p: Prompter;
let decision: NoteDecision;
const dispatched: Array<{ itemId: string; action: string; note?: string; decision?: string }> = [];
const toasts: string[] = [];

beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  const prs = new PrStates(async (r) => (/\/pull\/\d+$/.test(r.url) ? merged() : { state: "unknown" }));
  p = new Prompter(hub, new MrStates(async () => ({ state: "unknown" })), new JiraStates(async () => ({ state: "unknown" }), new Set()), prs);
  dispatched.length = 0;
  toasts.length = 0;
  decision = { dispatch: { action: "verify", note: "check each one" }, reply: "Sending an agent to check them." };
  const d: Dispatcher = {
    dispatch: async (itemId, action, note, dec) => (dispatched.push({ itemId, action, note, decision: dec }), undefined),
    scheduleFromWords: async () => {},
    readNote: async () => decision,
  };
  hub.dispatcher = d;
  hub.subscribe((e) => void (e.type === "toast" && toasts.push(e.data.text)));
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const card = () => hub.store.openQuestionByKey("recheck");
async function three() {
  const a = hub.createItem({ title: "Alpha", status: "waiting", links: [PR(1)] });
  const b = hub.createItem({ title: "Bravo deploy", status: "doing", links: [PR(2)] });
  const c = hub.createItem({ title: "Charlie", status: "inbox", links: [PR(3)] });
  await p.recheck();
  return { a, b, c, q: card()! };
}

test("the recheck card offers Check for me: a verify dispatch", async () => {
  const { q } = await three();
  const o = q.options.find((x) => x.id === "check")!;
  expect(o.label).toBe("Check for me");
  expect(o.effect).toMatchObject({ type: "dispatch", action: "verify" });
  expect(q.options.map((x) => x.id)).toEqual(["done", "all", "check", "keep"]);
});

test("'check them all yourself' on 3 picks: one verify job, not parked, no 'no agent' line", async () => {
  const { a, b, c, q } = await three();
  await hub.note(q.id, "check them all yourself");
  await flush();
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]!.action).toBe("verify");
  for (const it of [a, b, c]) expect(dispatched[0]!.note).toContain(`${it.id} · ${it.title}`);
  expect(dispatched[0]!.note).toContain("They added: check them all yourself");
  expect(dispatched[0]!.note).toContain(RECHECK_VERIFY_NOTE);
  expect(dispatched[0]!.note).toContain(`links: ${PR(1)}`);
  expect(dispatched[0]!.note).not.toContain("check each one"); // the reader's paraphrase doesn't steer the picks
  const after = hub.store.question(q.id)!;
  expect(after.status).toBe("answered");
  // Not parked until the morning: only note()'s 15-minute reading hold, on a card that's answered anyway.
  expect(Date.parse(after.notBefore ?? "0")).toBeLessThan(Date.now() + 20 * 60_000);
  const lines = hub.store.journal(50).map((j) => j.text);
  expect(lines.some((t) => /parked|none started|No agent started/i.test(t))).toBe(false);
  expect(lines.some((t) => t.startsWith("Dispatched verify across 3 items"))).toBe(true);
  expect(toasts).toContain("Noted → Check for me");
  // The note job's summary says what was queued, not the model's reply.
  expect(queuedNote(q, decision)).toBe("Noted → Check for me");
  // verify doesn't change what the items are.
  expect(hub.store.item(b.id)!.status).toBe("doing");
});

test("a 'do it' quick note picks Check for me too", async () => {
  const { q } = await three();
  await hub.note(q.id, "do it");
  await flush();
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]!.action).toBe("verify");
});

test("ticked items only; a note naming one checks that one; a note leaving one out checks all and passes it on", async () => {
  const { a, b, c } = await three();
  await hub.answer(card()!.id, "check", undefined, { picks: [a.id, c.id] });
  expect(dispatched[0]!.itemId).toBe(a.id);
  expect(dispatched[0]!.note).toContain(c.id);
  expect(dispatched[0]!.note).not.toContain(b.id);

  await p.recheck();
  await hub.answer(card()!.id, "check", "just charlie please");
  // "just" might leave something out: take every item and let the agent read the words.
  expect(dispatched[1]!.note).toContain(a.id);
  expect(dispatched[1]!.note).toContain("They added: just charlie please");

  await p.recheck();
  await hub.answer(card()!.id, "check", "charlie");
  expect(dispatched[2]!.itemId).toBe(c.id);
  expect(dispatched[2]!.note).not.toContain(a.id);
});

test("items closed since the card was drawn are left off the job", async () => {
  const { a, b, q } = await three();
  hub.store.putItem({ ...hub.store.item(a.id)!, status: "done" });
  await hub.answer(q.id, "check");
  expect(dispatched[0]!.itemId).toBe(b.id);
  expect(dispatched[0]!.note).not.toContain(a.id);
});

test("a note asking for some other agent (a reply) isn't turned into a check: still stranded", async () => {
  const { q } = await three();
  decision = { dispatch: { action: "reply", note: "chase the reviewer on bravo" } };
  await hub.note(q.id, "chase the reviewer on bravo");
  await flush();
  expect(dispatched).toHaveLength(0);
  expect(queuedNote(q, decision)).toBeUndefined();
  expect(toasts.some((t) => t.startsWith("That card covers several items"))).toBe(true);
});

test("items an agent is already on are left off; all of them busy → nothing queued, and no 'Noted' toast", async () => {
  const { a, b, c, q } = await three();
  const job = (id: string, itemId: string) => hub.store.putJob({ id, kind: "action", name: "work", title: "w", surface: "cmux", status: "running", itemId, tail: [], createdAt: new Date().toISOString() });
  job("job_a", a.id);
  await hub.answer(q.id, "check");
  expect(dispatched[0]!.itemId).toBe(b.id);
  expect(dispatched[0]!.note).not.toContain(a.id);

  await p.recheck(); // busy a stays off the new card
  job("job_b", b.id);
  job("job_c", c.id);
  toasts.length = 0;
  await hub.note(card()!.id, "check them all yourself");
  await flush();
  expect(dispatched).toHaveLength(1);
  expect(toasts).not.toContain("Noted → Check for me");
});

test("tapping Check for me with every item busy puts the card back", async () => {
  const { a, b, c, q } = await three();
  for (const it of [a, b, c]) hub.store.putJob({ id: `job_${it.id}`, kind: "action", name: "work", title: "w", surface: "cmux", status: "running", itemId: it.id, tail: [], createdAt: new Date().toISOString() });
  await hub.answer(q.id, "check");
  expect(dispatched).toHaveLength(0);
  expect(card()).toBeDefined();
});

test("'check these yourself' doesn't narrow to an item whose title says 'check'", async () => {
  hub.createItem({ title: "Check the staging deploy", status: "waiting", links: [PR(1)] });
  hub.createItem({ title: "Bravo", status: "waiting", links: [PR(2)] });
  await p.recheck();
  await hub.answer(card()!.id, "check", "check these yourself");
  expect(dispatched[0]!.note).toContain("Check the staging deploy");
  expect(dispatched[0]!.note).toContain("Bravo");
  // An item name that only starts like a check word still names it.
  hub.createItem({ title: "Checkout flow", status: "waiting", links: [PR(3)] });
  await p.recheck();
  await hub.answer(card()!.id, "check", "checking checkout");
  expect(dispatched[1]!.note).toContain("Checkout flow");
  expect(dispatched[1]!.note).not.toContain("Bravo");
});

test("a note naming only a closed item doesn't claim a check", async () => {
  const { a, q } = await three();
  hub.store.putItem({ ...hub.store.item(a.id)!, status: "done" });
  await hub.note(q.id, "check alpha");
  await flush();
  expect(dispatched).toHaveLength(0);
  expect(toasts).not.toContain("Noted → Check for me");
});

test("items listed in another live picks job count as having an agent", async () => {
  const { a, b, c, q } = await three();
  hub.store.putJob({ id: "job_v", kind: "action", name: "verify", title: "v", surface: "cmux", status: "running", itemId: a.id, note: `This one job covers 2 items.\n- ${a.id} · Alpha\n- ${b.id} · Bravo deploy`, tail: [], createdAt: new Date().toISOString() });
  await hub.answer(q.id, "check");
  expect(dispatched[0]!.itemId).toBe(c.id);
  expect(dispatched[0]!.note).not.toContain(b.id);
});

test("a note reader that picked the option itself goes the same way", async () => {
  const { q } = await three();
  decision = { pick: "check", reply: "Checking them." };
  await hub.note(q.id, "can you look into these");
  await flush();
  expect(dispatched).toHaveLength(1);
  expect(hub.store.question(q.id)!.status).toBe("answered");
  expect(Date.parse(hub.store.question(q.id)!.notBefore ?? "0")).toBeLessThan(Date.now() + 20 * 60_000);
});
