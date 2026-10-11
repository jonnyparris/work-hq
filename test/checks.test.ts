import { describe, expect, test } from "bun:test";
import { checkDue, staleCheckItems } from "../src/server/checks.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";

describe("morning checks", () => {
  test("due once per day, retried after an hour", () => {
    const now = new Date(2026, 9, 6, 9, 0);
    expect(checkDue({}, now)).toBe(true);
    expect(checkDue({ lastOkAt: new Date(2026, 9, 6, 8, 30).toISOString() }, now)).toBe(false);
    expect(checkDue({ lastOkAt: new Date(2026, 9, 5, 8, 30).toISOString() }, now)).toBe(true);
    expect(checkDue({ lastRunAt: new Date(2026, 9, 6, 8, 30).toISOString() }, now)).toBe(false);
    expect(checkDue({ lastRunAt: new Date(2026, 9, 6, 7, 30).toISOString() }, now)).toBe(true);
  });

  test("after: held until that time, and an earlier run today doesn't count", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 6, h, m);
    expect(checkDue({}, at(16, 59), "17:00")).toBe(false);
    expect(checkDue({}, at(17, 0), "17:00")).toBe(true);
    expect(checkDue({ lastOkAt: at(9).toISOString(), lastRunAt: at(9).toISOString() }, at(17, 5), "17:00")).toBe(true);
    expect(checkDue({ lastOkAt: at(17, 1).toISOString() }, at(18), "17:00")).toBe(false);
  });

  test("closes only this check's open items that dropped out of the report", () => {
    const hub = new Hub(new Store(":memory:"));
    const src = (key: string, label = "unlanded") => ({ type: "check" as const, label, key });
    const still = hub.createItem({ title: "still", source: src("a") });
    const gone = hub.createItem({ title: "gone", source: src("b") });
    hub.createItem({ title: "other check", source: src("c", "other") });
    hub.createItem({ title: "already done", status: "done", source: src("d") });
    hub.createItem({ title: "manual", source: { type: "manual" } });
    const stale = staleCheckItems(hub.store.items(), "unlanded", { items: [{ title: "still", source: src("a") }] });
    expect(stale.map((i) => i.id)).toEqual([gone.id]);
    expect(still.id).toBeTruthy();
  });

  test("a re-report keeps the status the owner set", () => {
    const hub = new Hub(new Store(":memory:"));
    const it = hub.createItem({ title: "x", source: { type: "check", label: "unlanded", key: "k" } });
    hub.setStatus(it.id, "waiting");
    hub.ingestReport({ items: [{ title: "x", source: { type: "check", label: "unlanded", key: "k" } }] });
    expect(hub.store.item(it.id)!.status).toBe("waiting");
  });
});

describe("Checks.run", () => {
  test("ingests items from a command, then closes them when they stop being reported", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const hub = new Hub(new Store(":memory:"));
    const checks = new Checks(hub);
    const report = JSON.stringify({ items: [{ title: "Merged but not landed: x!1", kind: "task", source: { key: "unlanded:x!1" } }] });
    await checks.run({ name: "unlanded", command: `echo '${report}'; exit 1` });
    const [it] = hub.store.items();
    expect(it).toMatchObject({ title: "Merged but not landed: x!1", status: "inbox", source: { type: "check", label: "unlanded" } });
    expect(hub.store.syncState("check:unlanded").lastOkAt).toBeTruthy();
    await checks.run({ name: "unlanded", command: `echo '{"items":[]}'` });
    expect(hub.store.item(it!.id)!.status).toBe("done");
  });

  test("no JSON is an error, not an empty board", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const hub = new Hub(new Store(":memory:"));
    hub.createItem({ title: "keep", source: { type: "check", label: "unlanded", key: "k" } });
    await new Checks(hub).run({ name: "unlanded", command: "echo 'fatal: timed out' >&2; exit 2" });
    expect(hub.store.syncState("check:unlanded").error).toContain("fatal: timed out");
    expect(hub.store.items()[0]!.status).toBe("inbox");
  });

  test("questions about its own items: asked once, carry the dispatch note, suppress inbox triage", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const { Prompter } = await import("../src/server/prompter.ts");
    const hub = new Hub(new Store(":memory:"));
    const checks = new Checks(hub);
    const report = JSON.stringify({
      items: [{ title: "ESC-1 unassigned", kind: "decision", source: { key: "esc:ESC-1" } }],
      questions: [
        { itemKey: "esc:ESC-1", key: "ESC-1", prompt: "ESC-1?", options: [{ label: "Assign to on-call", action: "work", note: "assign it" }, { label: "Take it", status: "today" }] },
        { itemKey: "esc:nope", prompt: "orphan" },
      ],
    });
    const cmd = `cat <<'J'\n${report}\nJ`;
    await checks.run({ name: "esc", command: cmd });
    const [it] = hub.store.items();
    const qs = hub.store.questions("open");
    expect(qs.map((q) => q.prompt)).toEqual(["ESC-1?"]);
    expect(qs[0]).toMatchObject({ itemId: it!.id, key: "check:esc:ESC-1" });
    expect(qs[0]!.options[0]!.effect).toEqual({ type: "dispatch", action: "work", note: "assign it" });
    new Prompter(hub).tick(new Date(2026, 9, 6, 10, 0));
    expect(hub.store.questions("open").filter((q) => q.itemId === it!.id).length).toBe(1);
    await hub.answer(qs[0]!.id, "o1");
    await checks.run({ name: "esc", command: cmd });
    expect(hub.store.questions("open").filter((q) => q.itemId === it!.id).length).toBe(0);
  });
});
