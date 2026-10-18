import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Effect } from "../src/shared/types.ts";

// 10-13 and 10-17: "Want an agent to find both…? → Yes, dispatch" landed in the journal twice at
// the same millisecond. The answer route journaled every `open` answer, and the hub's item-less
// noop/status/open branch journaled it again.

let hub: Hub;
beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
});

function ask(effect: Effect, itemId?: string) {
  const q = hub.ask({
    kind: "open",
    itemId,
    prompt: "Want an agent to find both and update them to M5?",
    priority: 60,
    key: `t:${Math.random()}`,
    options: [{ id: "yes", label: "Yes, dispatch", effect }],
  })!;
  return q;
}

const lines = (prompt: string) => hub.store.journal(500).filter((e) => e.text.startsWith(prompt));

describe("an open answer is journaled once", () => {
  test("item-less noop", async () => {
    const q = ask({ type: "noop" });
    await hub.answer(q.id, "yes", undefined, { journalOpen: true });
    expect(lines(q.prompt).map((e) => e.text)).toEqual([`${q.prompt} → Yes, dispatch`]);
  });

  test("item-less noop with a note", async () => {
    const q = ask({ type: "noop" });
    await hub.answer(q.id, "yes", "only the Q3 ones", { journalOpen: true });
    expect(lines(q.prompt).map((e) => e.text)).toEqual([`${q.prompt} → Yes, dispatch — only the Q3 ones`]);
  });

  test("item-less multi(noop, snooze) still one line", async () => {
    const q = ask({ type: "multi", effects: [{ type: "noop" }, { type: "snooze", minutes: 5 }] });
    await hub.answer(q.id, "yes", undefined, { journalOpen: true });
    expect(lines(q.prompt)).toHaveLength(1);
  });

  test("item-less effect the hub doesn't journal (snooze) still gets its one line", async () => {
    const q = ask({ type: "snooze", minutes: 5 });
    await hub.answer(q.id, "yes", undefined, { journalOpen: true });
    expect(lines(q.prompt)).toHaveLength(1);
  });

  test("item-bound noop gets one line from the route", async () => {
    const it = hub.createItem({ title: "Leveling", status: "doing", kind: "task" });
    const q = ask({ type: "noop" }, it.id);
    await hub.answer(q.id, "yes", undefined, { journalOpen: true });
    expect(lines(q.prompt)).toHaveLength(1);
  });

  test("without journalOpen (bulk, notes) behaviour is unchanged", async () => {
    const q = ask({ type: "snooze", minutes: 5 });
    await hub.answer(q.id, "yes");
    expect(lines(q.prompt)).toHaveLength(0);
  });
});
