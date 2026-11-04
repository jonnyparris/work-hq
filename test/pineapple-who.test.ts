import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";

// 11-01 08:40: "you · Committed today: Re-auth CF Access" in the journal. The owner never typed it: a 🍍 capture's
// triage moved the item, and setStatus defaulted to "you". The nightly reflection reads `you` lines as first-hand,
// so a model's call became the owner's. 🍍 triage status changes are now "hq"; the command bar stays "you".

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };

function setup() {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  hub.dispatcher = agents;
  const item = hub.createItem({ title: "Re-auth CF Access", kind: "task", status: "proposed" });
  (agents as any).runHeadless = async () => ({ ok: true, text: JSON.stringify({ reply: "On today.", updates: [{ id: item.id, status: "today" }] }) });
  (agents as any).launchAction = async () => {};
  const line = () => hub.store.journal().find((e) => e.itemId === item.id && e.text.startsWith("Committed today:"));
  return { hub, agents, item, line };
}

test("🍍 triage that returns status today writes the journal line as hq; confirmation is unchanged", async () => {
  const { hub, agents, item, line } = setup();
  await agents.triage("cf access keeps logging me out", "pineapple");
  expect(hub.store.item(item.id)!.status).toBe("today");
  expect(line()?.who).toBe("hq");
  // Attribution only: dedupeExisting and the re-ask filter still treat the captured item as owner-touched.
  expect(hub.store.item(item.id)!.confirmedAt).toBeDefined();
});

test("🍍 triage calendar block journals its Scheduled line as hq", async () => {
  const { hub, agents, item } = setup();
  const start = "2026-11-06T10:00:00.000Z";
  (agents as any).runHeadless = async () => ({ ok: true, text: JSON.stringify({ reply: "Booked.", calendar: [{ id: item.id, start }] }) });
  (agents as any).calendarBlock = async () => {};
  await agents.triage("block time for cf access friday", "pineapple");
  expect(hub.store.item(item.id)!.scheduledFor).toBe(start);
  expect(hub.store.journal().find((e) => e.itemId === item.id && e.text.startsWith("Scheduled "))?.who).toBe("hq");
});

test("setStatus without confirm: only who=you stamps confirmedAt on a fresh item", () => {
  const hub = new Hub(new Store(":memory:"));
  const a = hub.createItem({ title: "A", kind: "task", status: "proposed" });
  hub.setStatus(a.id, "done", "check cleared it", "agent");
  expect(hub.store.item(a.id)!.confirmedAt).toBeUndefined();
  const b = hub.createItem({ title: "B", kind: "task", status: "proposed" });
  hub.setStatus(b.id, "today");
  const stamp = hub.store.item(b.id)!.confirmedAt;
  expect(stamp).toBeDefined();
  // confirm=false leaves an earlier stamp alone (updateItem drops undefined).
  hub.setStatus(b.id, "done", undefined, "hq", false);
  expect(hub.store.item(b.id)!.confirmedAt).toBe(stamp);
});

test("command-bar triage with the same update is still the owner's: who is you", async () => {
  const { hub, agents, item, line } = setup();
  await agents.triage("re-auth cf access today");
  expect(hub.store.item(item.id)!.status).toBe("today");
  expect(line()?.who).toBe("you");
  expect(hub.store.item(item.id)!.confirmedAt).toBeDefined();
});
