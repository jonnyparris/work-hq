import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { actionPrompt } from "../src/server/prompts.ts";

// Three runs asked the same "when do we switch it on?" in 26 minutes because the answer lived
// only on the question. The next agent sees item.notes, so the answer has to land there.

let hub: Hub;
beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
});

function agentQuestion(prompt: string, key?: string) {
  const it = hub.createItem({ title: "Ship the triage bot", status: "doing", kind: "task" });
  hub.ask({
    kind: "open",
    itemId: it.id,
    prompt,
    priority: 72,
    key: key ?? `agent:${prompt.length}`,
    options: [
      { id: "o0", label: "Turn it on day one", effect: { type: "noop" } },
      { id: "o1", label: "Later", effect: { type: "noop" } },
    ],
  });
  const q = hub.store.questions("open").find((x) => x.itemId === it.id)!;
  return { it, q };
}

describe("answers to agent questions are remembered on the item", () => {
  test("agent:* answer goes into notes and the next prompt", async () => {
    const { it, q } = agentQuestion("When do we switch on the triage bot?");
    await hub.answer(q.id, "o0");
    const item = hub.store.item(it.id)!;
    expect(item.notes?.map((n) => n.text)).toEqual(["When do we switch on the triage bot? → Turn it on day one"]);
    const prompt = actionPrompt("job_x", item, "work");
    expect(prompt).toContain("When do we switch on the triage bot?");
    expect(prompt).toContain("Turn it on day one");
  });

  test("an after:* answer with a note keeps the note, once", async () => {
    const { it, q } = agentQuestion("Where does it stand?", "after:job_1");
    hub.updateItem(it.id, { notes: [{ at: new Date().toISOString(), text: "pending legal" }] });
    await hub.answer(q.id, "o1", "pending legal");
    expect(hub.store.item(it.id)!.notes?.map((n) => n.text)).toEqual(["Where does it stand? → Later — pending legal"]);
  });

  test("other questions don't touch notes", async () => {
    const { it, q } = agentQuestion("Triage this?", "triage:abc");
    await hub.answer(q.id, "o0");
    expect(hub.store.item(it.id)!.notes ?? []).toEqual([]);
  });

  test("capped at 20", async () => {
    const { it, q } = agentQuestion("Q?");
    hub.updateItem(it.id, { notes: Array.from({ length: 20 }, (_, i) => ({ at: new Date().toISOString(), text: `n${i}` })) });
    await hub.answer(q.id, "o0");
    const notes = hub.store.item(it.id)!.notes!;
    expect(notes).toHaveLength(20);
    expect(notes.at(-1)!.text).toBe("Q? → Turn it on day one");
  });
});
