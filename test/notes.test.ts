import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { type Dispatcher, Hub, nextMorning, quickNote } from "../src/server/hub.ts";
import { Prompter } from "../src/server/prompter.ts";
import type { NoteDecision } from "../src/shared/types.ts";

// A note typed on a question used to be journalled and then ignored: the question stayed open
// and came straight back. These pin down that a note now acts, or at least parks the question.

let hub: Hub;
let p: Prompter;
let decision: NoteDecision | undefined;
const dispatched: Array<{ itemId: string; action: string; note?: string }> = [];
const scheduled: Array<{ itemId: string; words: string }> = [];

beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  p = new Prompter(hub);
  decision = undefined;
  dispatched.length = 0;
  scheduled.length = 0;
  const d: Dispatcher = {
    dispatch: async (itemId, action, note) => { dispatched.push({ itemId, action, note }); return undefined; },
    scheduleFromWords: async (itemId, words) => { scheduled.push({ itemId, words }); },
    readNote: async () => decision,
  };
  hub.dispatcher = d;
});

const at = (h: number, m = 0) => new Date(2026, 8, 23, h, m); // Wed
const flush = () => new Promise((r) => setTimeout(r, 0));

function inboxQuestion(title = "Send spec to Jon for review") {
  const it = hub.createItem({ title, status: "inbox", kind: "task" });
  p.tick(at(15));
  const q = hub.store.questions("open").find((q) => q.itemId === it.id)!;
  return { it, q };
}

describe("notes on questions", () => {
  test("the note is kept on the item and the question leaves the queue at once", async () => {
    const { it, q } = inboxQuestion();
    decision = undefined; // reader can't tell → context only
    await hub.note(q.id, "some background");
    await flush();
    const after = hub.store.question(q.id)!;
    expect(hub.store.item(it.id)!.notes?.map((n) => n.text)).toEqual(["some background"]);
    expect(after.status).toBe("open");
    expect(Date.parse(after.notBefore!)).toBeGreaterThan(Date.now() + 60 * 60_000);
    expect(hub.store.journal().some((j) => j.text === `Note on ${it.title}: some background`)).toBe(true);
  });

  test("a parked question isn't re-asked by the next tick", async () => {
    const { q } = inboxQuestion();
    await hub.note(q.id, "context only");
    await flush();
    p.tick(at(15, 5));
    expect(hub.store.questions("open").filter((x) => x.itemId === q.itemId)).toHaveLength(1);
  });

  test("'drop' drops without asking pi", async () => {
    const { it, q } = inboxQuestion();
    decision = { status: "done" }; // would be wrong — must not be consulted
    const r = await hub.note(q.id, "drop");
    expect(r.pending).toBe(false);
    expect(hub.store.item(it.id)!.status).toBe("dropped");
    expect(hub.store.questions("open").filter((x) => x.itemId === it.id)).toHaveLength(0);
  });

  test("an instruction dispatches an agent with the note, and fixes the title", async () => {
    const { it, q } = inboxQuestion();
    decision = { dispatch: { action: "work", note: "Tighten the spec, add SVGs, then send to Joan" }, title: "Send spec to Joan for review" };
    await hub.note(q.id, "It's Joan, not Jon; improve it first, more succinct, with svg illustrations");
    await flush();
    expect(hub.store.item(it.id)!.title).toBe("Send spec to Joan for review");
    expect(dispatched).toEqual([{ itemId: it.id, action: "work", note: "Tighten the spec, add SVGs, then send to Joan" }]);
    expect(hub.store.question(q.id)!.status).toBe("answered");
  });

  test("a time schedules it", async () => {
    const { it, q } = inboxQuestion();
    decision = { when: "Thursday" };
    await hub.note(q.id, "will chase Joan on this on Thursday");
    await flush();
    expect(scheduled).toEqual([{ itemId: it.id, words: "Thursday" }]);
    expect(hub.store.question(q.id)!.status).toBe("answered");
  });

  test("picking an option answers with that option's effect", async () => {
    const { it, q } = inboxQuestion();
    decision = { pick: "notmine" };
    await hub.note(q.id, "that's Kim's, not mine");
    await flush();
    expect(hub.store.item(it.id)!.status).toBe("dropped");
  });

  test("an answer arriving while the note is read wins", async () => {
    const { it, q } = inboxQuestion();
    let release!: () => void;
    hub.dispatcher!.readNote = () => new Promise((r) => { release = () => r({ status: "dropped" }); });
    await hub.note(q.id, "hmm, long note");
    await hub.answer(q.id, "today");
    release();
    await flush();
    expect(hub.store.item(it.id)!.status).toBe("today");
  });

  test("quickNote only matches short, unambiguous notes", () => {
    const opts = [
      { id: "go", label: "Send an agent", effect: { type: "dispatch" as const, action: "work" as const } },
      { id: "drop", label: "Drop it", effect: { type: "status" as const, status: "dropped" as const } },
    ];
    expect(quickNote("Drop.", { options: opts })).toEqual({ pick: "drop", status: "dropped" });
    expect(quickNote("do it", { options: opts })).toEqual({ pick: "go" });
    expect(quickNote("done", { options: opts })).toEqual({ pick: null, status: "done" });
    expect(quickNote("drop this, we're doing it anyway each day", { options: opts })).toBeUndefined();
  });

  test("nextMorning skips the weekend", () => {
    const fri = new Date(2026, 8, 25, 16);
    expect(nextMorning(fri).getDay()).toBe(1);
  });

  test("nextMorning after midnight is the same day", () => {
    const early = new Date(2026, 8, 23, 0, 30); // Wed 00:30
    expect(nextMorning(early).getDate()).toBe(23);
  });
});
