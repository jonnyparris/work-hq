import { expect, test } from "bun:test";
import type { ActionKind, Item } from "../src/shared/types.ts";
import { demoActionScript, demoSweepScript, resetDemo, seedDemo } from "../src/server/demo.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";

const item: Item = {
  id: "it_1", kind: "ticket", status: "doing", title: "PAY-2231 · flaky test", people: ["Tom"], project: "PAY",
  source: { type: "manual" }, createdAt: "", updatedAt: "",
};

test("every action has a script that ends by moving the item along", () => {
  for (const a of ["ticket", "reply", "email", "prep", "work", "verify", "draft", "publish"] as ActionKind[]) {
    const s = demoActionScript(item, a);
    expect(s.steps.length).toBeGreaterThan(2);
    expect(s.report.summary).toBeTruthy();
    expect(s.report.updates?.[0]?.id).toBe("it_1");
    expect(s.report.updates?.[0]?.status).not.toBe("doing");
  }
  expect(demoActionScript(item, "verify").steps.some((x) => x.text.includes("PAY-2231"))).toBe(true);
});

test("sweeps find something to show", () => {
  expect(demoSweepScript("transcripts").report.items?.length).toBe(2);
  expect(demoSweepScript("posts").report.items?.[0]?.kind).toBe("post");
});

test("reset wipes everything and reseeds", () => {
  const hub = new Hub(new Store(":memory:"));
  seedDemo(hub);
  const n = hub.store.items().length;
  hub.createItem({ title: "something real", source: { type: "manual" } });
  resetDemo(hub);
  expect(hub.store.items().length).toBe(n);
  expect(hub.store.items().some((i) => i.title === "something real")).toBe(false);
  expect(hub.store.unsyncedJournal().length).toBe(0);
});
