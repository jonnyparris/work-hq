// it_mw8gt7h0v7ldf: a report that closes its item and asks a question in the same call. The card went on the done
// item (the question's itemId falls back to the job's) and the next tick's expireMoot closed it as moot, so the
// agent's question never reached the owner. The card now carries `askedClosed` and stays until it's answered.
import { beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { JiraStates } from "../src/server/jira-state.ts";
import { MrStates } from "../src/server/mr-state.ts";
import { PrStates } from "../src/server/pr-state.ts";
import { Prompter } from "../src/server/prompter.ts";

let hub: Hub;
let p: Prompter;

beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  p = new Prompter(hub, new MrStates(async () => ({ state: "unknown" })), new JiraStates(async () => ({ state: "unknown" }), new Set()), new PrStates(async () => ({ state: "unknown" })));
});

const job = (itemId: string) =>
  hub.store.putJob({ id: "job_x", kind: "action", name: "work", title: "Work · x", surface: "cmux", status: "running", itemId, tail: [], createdAt: new Date().toISOString() });
const card = (prompt: string) => hub.store.questions("open").find((q) => q.prompt === prompt);

test("done + a question in one report: the card survives the next tick, still on the item", () => {
  const it = hub.createItem({ title: "Fix the thing", status: "doing" });
  job(it.id);
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: it.id, status: "done" }], questions: [{ prompt: "Also fix the other thing?", options: [{ label: "Yes", action: "work" }, { label: "No", status: "dropped" }] }] });
  expect(hub.store.item(it.id)!.status).toBe("done");
  const q = card("Also fix the other thing?")!;
  expect(q.itemId).toBe(it.id);
  expect(q.askedClosed).toBe(true);
  p.tick(new Date());
  expect(hub.store.question(q.id)!.status).toBe("open");
});

test("dropped works the same, and an explicit itemId on a closed item too", () => {
  const a = hub.createItem({ title: "A", status: "doing" });
  const b = hub.createItem({ title: "B", status: "done" });
  job(a.id);
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: a.id, status: "dropped" }], questions: [{ prompt: "Drop A's twin?" }, { prompt: "Reopen B?", itemId: b.id }] });
  p.tick(new Date());
  expect(card("Drop A's twin?")?.itemId).toBe(a.id);
  expect(card("Reopen B?")?.itemId).toBe(b.id);
});

test("a card asked while its item was open still goes moot when the item closes", () => {
  const it = hub.createItem({ title: "Open one", status: "doing" });
  job(it.id);
  hub.ingestReport({ jobId: "job_x", status: "progress", questions: [{ prompt: "Which way?" }] });
  const q = card("Which way?")!;
  expect(q.askedClosed).toBeUndefined();
  hub.updateItem(it.id, { status: "done" });
  p.tick(new Date());
  expect(hub.store.question(q.id)!.status).toBe("expired");
  expect(hub.store.question(q.id)!.answer).toBe("moot");
});

test("the owner moving the closed item closes the card", () => {
  const a = hub.createItem({ title: "A", status: "doing" });
  job(a.id);
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: a.id, status: "done" }], questions: [{ prompt: "Follow up?" }] });
  const q = card("Follow up?")!;
  hub.setStatus(a.id, "dropped");
  expect(hub.store.question(q.id)!.status).toBe("expired");
});

test("a repeat done keeps the card; a reopen and a later close by another path make it moot", () => {
  const it = hub.createItem({ title: "A", status: "doing" });
  job(it.id);
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: it.id, status: "done" }], questions: [{ prompt: "Follow up?" }] });
  const q = card("Follow up?")!;
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: it.id, status: "done", note: "still done" }] });
  p.tick(new Date());
  expect(hub.store.question(q.id)!.status).toBe("open");
  hub.updateItem(it.id, { status: "today" });
  expect(hub.store.question(q.id)!.askedClosed).toBeUndefined();
  p.tick(new Date());
  expect(hub.store.question(q.id)!.status).toBe("open");
  hub.updateItem(it.id, { status: "dropped" });
  p.tick(new Date());
  expect(hub.store.question(q.id)!.answer).toBe("moot");
});

test("a later report that moves the closed item (done → dropped) closes the card", () => {
  const it = hub.createItem({ title: "A", status: "doing" });
  job(it.id);
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: it.id, status: "done" }], questions: [{ prompt: "Follow up?" }] });
  const q = card("Follow up?")!;
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: it.id, status: "dropped" }] });
  expect(hub.store.question(q.id)!.answer).toBe("item dropped");
});

test("itemKey on a closed item tags the card too, and its status button reopens the item", async () => {
  const it = hub.createItem({ title: "Keyed", status: "done", source: { type: "agent", key: "k:1" } });
  job(it.id);
  hub.ingestReport({ jobId: "job_x", status: "done", questions: [{ prompt: "Reopen it?", itemKey: "k:1", options: [{ label: "Reopen", status: "today" }] }] });
  p.tick(new Date());
  const q = card("Reopen it?")!;
  expect(q.itemId).toBe(it.id);
  expect(q.askedClosed).toBe(true);
  await hub.answer(q.id, "o0");
  expect(hub.store.item(it.id)!.status).toBe("today");
});

test("asked in a progress report, asked again by the report that closes the item: the same card stays, once or not", () => {
  const it = hub.createItem({ title: "A", status: "doing" });
  job(it.id);
  hub.ingestReport({ jobId: "job_x", status: "progress", questions: [{ prompt: "Ship it?", key: "agent:ship", once: true }] });
  const q = card("Ship it?")!;
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: it.id, status: "done" }], questions: [{ prompt: "Ship it?", key: "agent:ship", once: true }] });
  expect(hub.store.question(q.id)!.status).toBe("open");
  expect(hub.store.question(q.id)!.askedClosed).toBe(true);
  p.tick(new Date());
  expect(hub.store.question(q.id)!.status).toBe("open");
});

test("a work button on the closed item's card sends the agent, which puts the item back on doing", async () => {
  const sent: string[] = [];
  hub.dispatcher = { dispatch: async (itemId: string) => (sent.push(itemId), hub.updateItem(itemId, { status: "doing" })) } as unknown as Hub["dispatcher"];
  const it = hub.createItem({ title: "A", status: "doing" });
  job(it.id);
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: it.id, status: "done" }], questions: [{ prompt: "Also do B?", options: [{ label: "Yes", action: "work", note: "do B" }] }] });
  await hub.answer(card("Also do B?")!.id, "o0");
  expect(sent).toEqual([it.id]);
  expect(hub.store.item(it.id)!.status).toBe("doing");
});

test("the same key asked about another item doesn't keep the closed item's card", () => {
  const a = hub.createItem({ title: "A", status: "doing" });
  const b = hub.createItem({ title: "B", status: "today" });
  job(a.id);
  hub.ingestReport({ jobId: "job_x", status: "progress", questions: [{ prompt: "Ship?", key: "agent:ship" }] });
  const q = card("Ship?")!;
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: a.id, status: "done" }], questions: [{ prompt: "Ship?", key: "agent:ship", itemId: b.id }] });
  expect(hub.store.question(q.id)!.answer).toBe("item done");
  expect(card("Ship?")?.itemId).toBe(b.id);
});

test("a kept card with a state-like key stays; a later report asking its key about another item gets its own card", () => {
  const a = hub.createItem({ title: "A", status: "doing" });
  const b = hub.createItem({ title: "B", status: "today" });
  job(a.id);
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: a.id, status: "done" }], questions: [{ prompt: "Go?", key: "doing:x" }] });
  const q = card("Go?")!;
  p.tick(new Date());
  expect(hub.store.question(q.id)!.status).toBe("open");
  hub.ingestReport({ jobId: "job_x", status: "done", questions: [{ prompt: "Go?", key: "doing:x", itemId: b.id }] });
  expect(hub.store.question(q.id)!.answer).toBe("asked about another item");
  expect(card("Go?")?.itemId).toBe(b.id);
});

test("a once ask about another item replaces the kept card; a report with no job keeps the old moot rule", () => {
  const a = hub.createItem({ title: "A", status: "doing" });
  const b = hub.createItem({ title: "B", status: "today" });
  job(a.id);
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: a.id, status: "done" }], questions: [{ prompt: "Go?", key: "agent:go", once: true }] });
  hub.ingestReport({ jobId: "job_x", status: "done", questions: [{ prompt: "Go?", key: "agent:go", once: true, itemId: b.id }] });
  expect(card("Go?")?.itemId).toBe(b.id);

  const c = hub.createItem({ title: "C", status: "done" });
  hub.ingestReport({ questions: [{ prompt: "Check C?", itemId: c.id }] });
  const q = card("Check C?")!;
  expect(q.askedClosed).toBeUndefined();
  p.tick(new Date());
  expect(hub.store.question(q.id)!.answer).toBe("moot");
});

test("an item-less ask on the same key leaves the kept card; a job report never tags the owner's own card", () => {
  const a = hub.createItem({ title: "A", status: "doing" });
  job(a.id);
  hub.ingestReport({ jobId: "job_x", status: "done", updates: [{ id: a.id, status: "done" }], questions: [{ prompt: "Ship A?", key: "agent:ship" }] });
  const q = card("Ship A?")!;
  hub.ingestReport({ questions: [{ prompt: "Ship general?", key: "agent:ship" }] });
  expect(hub.store.question(q.id)!.status).toBe("open");

  const c = hub.createItem({ title: "C", status: "doing" });
  const own = hub.ask({ kind: "state", itemId: c.id, key: `waiting:${c.id}`, priority: 60, prompt: "Still waiting?", options: [{ id: "a", label: "Yes", effect: { type: "noop" } }] })!;
  hub.updateItem(c.id, { status: "done" });
  job(c.id);
  hub.ingestReport({ jobId: "job_x", status: "done", questions: [{ prompt: "Still waiting?", key: `waiting:${c.id}` }] });
  expect(hub.store.question(own.id)!.askedClosed).toBeUndefined();
});
