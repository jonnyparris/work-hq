import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { keptKill } from "../src/server/memory-sync.ts";
import { Prompter } from "../src/server/prompter.ts";

// A keep answer on a kill card moves the kill date (it_mwkl5o0t6lsor).
// 11-04 "Extend a week" on it_mvryad2y4u8nl left killDate 11-04 behind: at the 11-11 slot the due card and the kill
// card opened together and sat there. 11-12 "do it" typed on it_mw5m4rjjysw1k's kill card became "Do it today" (the
// card had no agent button), no agent ran, and the same kill card came back 11-18.

let hub: Hub;
let p: Prompter;
let sent: Array<{ itemId: string; action: string }>;
beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  p = new Prompter(hub);
  sent = [];
  hub.dispatcher = { dispatch: async (itemId, action) => (sent.push({ itemId, action }), undefined), scheduleFromWords: async () => {} };
});
afterEach(() => setSystemTime());

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };

// Wednesday 2026-09-23.
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m);
const tick = (d: Date) => (setSystemTime(d), p.tick(d));
const cardsFor = (id: string) => hub.store.questions("open").filter((q) => q.itemId === id);
const killCard = (id: string) => cardsFor(id).find((q) => q.key.startsWith("kill:"));

test("Extend a week: the kill date moves to the slot, and the slot asks one card with Kill it", async () => {
  const it = hub.createItem({ title: "chat-room blog", status: "proposed", signals: { killDate: "2026-09-22" } });
  tick(at(23, 10));
  await hub.answer(killCard(it.id)!.id, "week");
  expect(hub.store.item(it.id)!.signals).toMatchObject({ killDate: "2026-09-30", killKept: "2026-09-30" });
  tick(at(29, 10)); // the day before the slot: a kept kill date doesn't ask two days early
  expect(cardsFor(it.id)).toHaveLength(0);
  tick(at(30, 10)); // the slot (Wed 09-30 09:30) has come
  const open = cardsFor(it.id);
  expect(open.map((q) => q.key)).toEqual([`due:${it.id}:${hub.store.item(it.id)!.scheduledFor}`]);
  expect(open[0]!.options.map((o) => o.id)).toContain("kill");
  await hub.answer(open[0]!.id, "kill");
  expect(hub.store.item(it.id)!.status).toBe("dropped");
  expect(cardsFor(it.id)).toHaveLength(0);
});

test("Do it today: the kill date moves to the next workday, and no kill card before it", async () => {
  // Friday 09-25: the next workday is Monday 09-28.
  const it = hub.createItem({ title: "keep doing it", status: "proposed", signals: { killDate: "2026-09-24" } });
  tick(at(25, 10));
  await hub.answer(killCard(it.id)!.id, "today");
  expect(hub.store.item(it.id)!.signals?.killDate).toBe("2026-09-28");
  tick(at(25, 15));
  tick(at(27, 12)); // Sunday
  expect(killCard(it.id)).toBeUndefined();
  tick(at(28, 10)); // Monday, still on today: keep or kill again
  expect(killCard(it.id)?.key).toBe(`kill:${it.id}:2026-09-28`);
});

test("a proposal's kill card has Send an agent; a typed 'do it' dispatches work, not today", async () => {
  const agents = new Agents(hub, noCmux);
  hub.dispatcher = agents;
  (agents as unknown as { launchAction: () => Promise<void> }).launchAction = async () => {};
  const it = hub.createItem({
    title: "agent-relay: reply under your own post",
    kind: "idea",
    status: "proposed",
    source: { type: "memory", label: "Proposals 2026-11-08 · Medium Priority", key: "memory:proposals:relay" },
    signals: { killDate: "2026-09-23" },
  });
  tick(at(23, 10));
  const q = killCard(it.id)!;
  expect(q.options.find((o) => o.id === "go")?.effect).toEqual({ type: "dispatch", action: "work" });
  await hub.note(q.id, "do it");
  expect(hub.store.liveJobs().map((j) => [j.itemId, j.name])).toEqual([[it.id, "work"]]);
  expect(hub.store.item(it.id)!.status).toBe("doing");
  expect(hub.store.item(it.id)!.signals?.killDate).toBe("2026-09-24");
});

test("a dispatch whose build throws leaves the kill date alone", async () => {
  const agents = new Agents(hub, noCmux);
  hub.dispatcher = agents;
  (agents as unknown as { worktreeFor: () => Promise<never> }).worktreeFor = async () => {
    throw new Error("no worktree");
  };
  const it = hub.createItem({ title: "an idea", kind: "idea", status: "proposed", signals: { killDate: "2026-09-23" } });
  setSystemTime(at(23, 10));
  await agents.dispatch(it.id, "work").catch(() => {});
  expect(hub.store.item(it.id)!.status).toBe("proposed");
  expect(hub.store.item(it.id)!.signals).toEqual({ killDate: "2026-09-23" });
});

test("a message-shaped item's kill card has no agent button", () => {
  const it = hub.createItem({ title: "reply to Sam", kind: "message", status: "proposed", signals: { killDate: "2026-09-23" } });
  tick(at(23, 10));
  expect(killCard(it.id)!.options.some((o) => o.effect.type === "dispatch")).toBe(false);
});

test("no kill card while an agent is on the item", () => {
  const it = hub.createItem({ title: "busy", status: "doing", signals: { killDate: "2026-09-23" } });
  hub.putJob({ id: "j1", kind: "action", name: "work", title: "x", surface: "headless", status: "running", itemId: it.id, tail: [], createdAt: at(23, 9).toISOString() } as any);
  tick(at(23, 10));
  expect(killCard(it.id)).toBeUndefined();
});

test("an agent's schedule doesn't move the kill date; a kill date never moves earlier", () => {
  const it = hub.createItem({ title: "x", status: "proposed", signals: { killDate: "2026-09-22" } });
  hub.schedule(it.id, at(30, 9, 30).toISOString(), "next week", "agent");
  expect(hub.store.item(it.id)!.signals?.killDate).toBe("2026-09-22");
  const later = hub.createItem({ title: "y", status: "proposed", signals: { killDate: "2026-10-10" } });
  hub.schedule(later.id, at(30, 9, 30).toISOString(), "next week");
  expect(hub.store.item(later.id)!.signals).toEqual({ killDate: "2026-10-10" });
});

test("memory re-import keeps a moved kill date; memory dropping or extending it still wins", () => {
  const existing = { signals: { killDate: "2026-09-30", killKept: "2026-09-30" } };
  const base = { stateUnknown: false, lowConfidence: false, pineapple: false };
  expect(keptKill(existing, { ...base, killDate: "2026-09-22" }).killDate).toBe("2026-09-30");
  expect(keptKill(existing, { ...base, killDate: "2026-10-07" }).killDate).toBe("2026-10-07");
  expect(keptKill(existing, base).killDate).toBeUndefined();
  expect(keptKill(undefined, { ...base, killDate: "2026-09-22" }).killDate).toBe("2026-09-22");
  // Memory restating the same date keeps the marker: the card still asks on the day, not two days early.
  expect(keptKill(existing, { ...base, killDate: "2026-09-30" })).toMatchObject({ killDate: "2026-09-30", killKept: "2026-09-30" });
});

test("a due card asked before the kill date was due doesn't hide the kill card", () => {
  // Slot Mon 09-21, kill Fri 09-25: the due card (no Kill it) is still open on Thursday.
  const it = hub.createItem({ title: "slot first", status: "scheduled", scheduledFor: at(21, 9, 30).toISOString(), signals: { killDate: "2026-09-25" } });
  tick(at(21, 10));
  const due = cardsFor(it.id);
  expect(due.map((q) => q.key.split(":")[0])).toEqual(["due"]);
  expect(due[0]!.options.some((o) => o.id === "kill")).toBe(false);
  tick(at(24, 10));
  expect(killCard(it.id)?.key).toBe(`kill:${it.id}:2026-09-25`);
});

test("a keep on another card closes the old kill card; no second one the same day", async () => {
  const it = hub.createItem({ title: "both", status: "proposed", signals: { killDate: "2026-09-23", stateUnknown: true } });
  tick(at(23, 10));
  const kill = killCard(it.id)!;
  const state = cardsFor(it.id).find((q) => q.key.startsWith("state:"))!;
  await hub.answer(state.id, "today");
  expect(hub.store.item(it.id)!.signals?.killDate).toBe("2026-09-24");
  tick(at(23, 10, 5));
  expect(hub.store.question(kill.id)).toMatchObject({ status: "expired" });
  expect(killCard(it.id)).toBeUndefined();
});

test("I'm on it with the kill date tomorrow: kept to tomorrow, no kill card today", async () => {
  const it = hub.createItem({ title: "on it", status: "scheduled", scheduledFor: at(23, 9, 30).toISOString(), signals: { killDate: "2026-09-24" } });
  tick(at(23, 10));
  const due = cardsFor(it.id).find((q) => q.key.startsWith("due:"))!;
  await hub.answer(due.id, "doing");
  expect(hub.store.item(it.id)!.signals).toMatchObject({ killDate: "2026-09-24", killKept: "2026-09-24" });
  tick(at(23, 10, 5));
  expect(killCard(it.id)).toBeUndefined();
});

test("bulk Check all for me doesn't send work agents from kill cards", async () => {
  const it = hub.createItem({ title: "an idea", kind: "idea", status: "proposed", signals: { killDate: "2026-09-23" } });
  tick(at(23, 10));
  expect(killCard(it.id)!.options.some((o) => o.id === "go")).toBe(true);
  const r = await hub.bulk({ op: "dispatch", group: "state" });
  expect(sent).toEqual([]);
  expect(r.skipped).toBe(1);
});

test("bulk defer of a scheduled item moves its kill date with the slot", async () => {
  const it = hub.createItem({ title: "pushed", status: "scheduled", scheduledFor: at(23, 9, 30).toISOString(), signals: { killDate: "2026-09-22" } });
  tick(at(23, 10));
  await hub.bulk({ op: "defer", group: "due", until: at(28, 9, 30).toISOString(), label: "Mon" });
  expect(hub.store.item(it.id)!.signals?.killDate).toBe("2026-09-28");
});
