import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { type Dispatcher, Hub, isInstruction } from "../src/server/hub.ts";
import type { NoteDecision } from "../src/shared/types.ts";

// 10-15 14:58: "do it" typed in the item drawer on it_mv7a0vsjsewtj was saved as context, and the item
// sat in today for six days. PATCH /api/items/:id with a note and no status now calls hub.itemNote:
// instructions go through the note reader like a card note, background stays background.

let hub: Hub;
let decision: NoteDecision | undefined;
const reads: Array<{ questionId: string; text: string }> = [];
const dispatched: Array<{ itemId: string; action: string; note?: string }> = [];

beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  decision = undefined;
  reads.length = 0;
  dispatched.length = 0;
  const d: Dispatcher = {
    dispatch: async (itemId, action, note) => { dispatched.push({ itemId, action, note }); return undefined; },
    scheduleFromWords: async () => {},
    readNote: async (questionId, text) => { reads.push({ questionId, text }); return decision ?? {}; },
  };
  hub.dispatcher = d;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const today = () => hub.createItem({ title: "Reply to Bernardo about the quota bump", status: "today", kind: "task" });

describe("drawer notes", () => {
  test("'do it' on a today item sends an agent (quickNote: no reader round trip needed)", async () => {
    const it = today();
    const r = await hub.itemNote(it.id, "do it");
    await flush();
    expect(r.routed).toBe(true);
    expect(reads).toHaveLength(0);
    expect(dispatched.map((d) => [d.itemId, d.action])).toEqual([[it.id, "work"]]);
    expect(hub.store.item(it.id)!.notes?.map((n) => n.text)).toEqual(["do it"]);
    // One journal line for the note, not two.
    expect(hub.store.journal().filter((j) => j.text === `Note on ${it.title}: do it`)).toHaveLength(1);
    expect(hub.store.questions("open").filter((q) => q.itemId === it.id)).toHaveLength(0);
  });

  test("'context: Bernardo owns this' stays context: no reader, no card", async () => {
    const it = today();
    const r = await hub.itemNote(it.id, "context: Bernardo owns this");
    await flush();
    expect(r.routed).toBe(false);
    expect(reads).toHaveLength(0);
    expect(hub.store.questions("open")).toHaveLength(0);
    expect(hub.store.item(it.id)!.notes?.map((n) => n.text)).toEqual(["context: Bernardo owns this"]);
    expect(hub.store.journal().some((j) => j.text === `Note on ${it.title}: context: Bernardo owns this`)).toBe(true);
  });

  test("an instruction the reader calls background expires its one-off card instead of resurfacing", async () => {
    const it = today();
    decision = { reply: "Bernardo already has it." };
    await hub.itemNote(it.id, "check whether Bernardo replied");
    await flush();
    expect(reads).toHaveLength(1);
    expect(hub.store.questions("open")).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    expect(hub.store.item(it.id)!.status).toBe("today");
  });

  test("a longer instruction goes to the note reader", async () => {
    const it = today();
    decision = { dispatch: { action: "reply", note: "Ask Bernardo for the numbers in the thread" } };
    await hub.itemNote(it.id, "ask Bernardo for the numbers in the thread");
    await flush();
    expect(reads.map((r) => r.text)).toEqual(["ask Bernardo for the numbers in the thread"]);
    expect(dispatched).toEqual([{ itemId: it.id, action: "reply", note: "Ask Bernardo for the numbers in the thread" }]);
  });

  test("uses the item's open card when there is one", async () => {
    const it = today();
    const q = hub.ask({
      kind: "state", itemId: it.id, key: `state:${it.id}`, priority: 50, prompt: "Still live?",
      options: [{ id: "done", label: "Done", effect: { type: "status", status: "done" } }],
    })!;
    decision = { pick: "done" };
    await hub.itemNote(it.id, "mark it done, Bernardo sorted it");
    await flush();
    expect(reads[0]!.questionId).toBe(q.id);
    expect(hub.store.item(it.id)!.status).toBe("done");
    expect(hub.store.question(q.id)!.status).toBe("answered");
  });

  test("the one-off card is born parked, so it never flashes up", async () => {
    const it = today();
    let seen: string | undefined;
    hub.dispatcher!.readNote = async (questionId) => {
      seen = hub.store.question(questionId)!.notBefore;
      return {};
    };
    await hub.itemNote(it.id, "ask Bernardo for the numbers");
    await flush();
    expect(Date.parse(seen!)).toBeGreaterThan(Date.now());
  });

  test("isInstruction", () => {
    for (const t of ["do it", "Do it.", "ask Bernardo", "check the logs first", "please chase Joan", "yes, send it", "drop", "done", "verify the MR merged", "follow up with Kevin"])
      expect([t, isInstruction(t)]).toEqual([t, true]);
    for (const t of ["context: Bernardo owns this", "fyi: do it later maybe", "Bernardo owns this now", "The MR merged on Tuesday", "not sure this matters", "no, don't send it", "Deploy is blocked by legal", "Merge conflicts were ugly on the MR"])
      expect([t, isInstruction(t)]).toEqual([t, false]);
  });
});
