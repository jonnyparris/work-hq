import { beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { type Dispatcher, Hub } from "../src/server/hub.ts";

// 10-26 proposals: an agent's note or drop via PATCH /api/items/:id journalled as `you`, so the usage digest
// counted it as the owner's typed note and the nightly reflection read it as the owner's call.
// hub.patchItem (the PATCH handler) takes `who: "agent"`: journal lines and notes read agent and a note stays
// context. Attribution only: confirmedAt is still stamped so a quiet re-import can't revive a dropped item.
// No `who` (the drawer) behaves as before.

let hub: Hub;
const reads: string[] = [];
const dispatched: string[] = [];

beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  reads.length = 0;
  dispatched.length = 0;
  const d: Dispatcher = {
    dispatch: async (itemId) => { dispatched.push(itemId); return undefined; },
    scheduleFromWords: async () => {},
    readNote: async (_q, text) => { reads.push(text); return {}; },
  };
  hub.dispatcher = d;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const mk = () => hub.createItem({ title: "Blog post on the quota work", kind: "idea", status: "proposed" });
const lines = (id: string) => hub.store.journal().filter((e) => e.itemId === id);

test("an agent drop journals as agent; a quiet re-import can't revive it", async () => {
  const it = mk();
  const out = await hub.patchItem(it.id, { status: "dropped", note: "kill date passed", who: "agent" });
  expect(out.status).toBe("dropped");
  expect(lines(it.id).map((e) => [e.who, e.text])).toEqual([["agent", `Dropped: ${it.title} — kill date passed`]]);
  expect(hub.store.item(it.id)!.notes?.map((n) => [n.who, n.text])).toEqual([["agent", "kill date passed"]]);
  hub.updateItem(it.id, { status: "proposed" }, { quiet: true });
  expect(hub.store.item(it.id)!.status).toBe("dropped");
});

test("no who (the drawer) still journals as you and confirms", async () => {
  const it = mk();
  const out = await hub.patchItem(it.id, { status: "done" });
  expect(out.confirmedAt).toBeDefined();
  expect(lines(it.id).map((e) => e.who)).toEqual(["you"]);
});

test("who null reads as absent (the owner)", async () => {
  const it = mk();
  await hub.patchItem(it.id, { status: "done", who: null });
  expect(lines(it.id).map((e) => e.who)).toEqual(["you"]);
});

test("an agent's correction journals as agent", async () => {
  const it = mk();
  const out = await hub.patchItem(it.id, { title: "Blog post: quota work", who: "agent" });
  expect(out.title).toBe("Blog post: quota work");
  expect(lines(it.id).map((e) => [e.who, e.text])).toEqual([["agent", "Corrected: Blog post: quota work"]]);
});

test("an agent's instruction-shaped note stays context: no reader, no card, no dispatch", async () => {
  const it = mk();
  await hub.patchItem(it.id, { note: "do it", who: "agent" });
  await flush();
  expect(reads).toHaveLength(0);
  expect(dispatched).toHaveLength(0);
  expect(hub.store.questions("open")).toHaveLength(0);
  expect(lines(it.id).map((e) => [e.who, e.text])).toEqual([["agent", `Note on ${it.title}: do it`]]);
  expect(hub.store.item(it.id)!.notes?.map((n) => [n.who, n.text])).toEqual([["agent", "do it"]]);
});

test("the owner's 'do it' in the drawer still sends an agent", async () => {
  const it = hub.createItem({ title: "Reply to Bernardo", kind: "task", status: "today" });
  await hub.patchItem(it.id, { note: "do it" });
  await flush();
  expect(dispatched).toEqual([it.id]);
});

test("who must be you or agent: hq can't be claimed over the API", async () => {
  const it = mk();
  await expect(hub.patchItem(it.id, { status: "dropped", who: "hq" })).rejects.toThrow(/who must be/);
  expect(hub.store.item(it.id)!.status).toBe("proposed");
});
