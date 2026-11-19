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
  // Its proposal card asks first and holds the kill card back; once it has yielded, the kill card asks.
  hub.expireQuestion(cardsFor(it.id).find((q) => q.key.startsWith("proposal:"))!.id, "yielded");
  tick(at(23, 10, 5));
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

// it_mwe701wv3fshv: one decision, one card. 11-11..11-18 it_mvryad2y4u8nl had its due and kill cards open together.
test("a due card asked before the kill date was due gets Kill it then, and no kill card opens", async () => {
  // Slot Mon 09-21, kill Fri 09-25: the due card (no Kill it) is still open on Thursday.
  const it = hub.createItem({ title: "slot first", status: "scheduled", scheduledFor: at(21, 9, 30).toISOString(), signals: { killDate: "2026-09-25" } });
  const seen: string[] = [];
  hub.subscribe((e) => e.type === "question" && e.data.itemId === it.id && seen.push(e.data.options.map((o) => o.id).join(",")));
  tick(at(21, 10));
  const due = cardsFor(it.id);
  expect(due.map((q) => q.key.split(":")[0])).toEqual(["due"]);
  expect(due[0]!.options.some((o) => o.id === "kill")).toBe(false);
  tick(at(24, 10));
  expect(killCard(it.id)).toBeUndefined();
  const now = cardsFor(it.id);
  expect(now.map((q) => q.id)).toEqual([due[0]!.id]); // the same card, changed in place
  expect(now[0]!.options.map((o) => o.id)).toEqual([...due[0]!.options.map((o) => o.id), "kill"]);
  expect(seen.at(-1)).toContain("kill"); // the board got the new version
  tick(at(26, 10)); // past the kill date, days later: still one card, Kill it once
  expect(cardsFor(it.id).map((q) => q.options.filter((o) => o.id === "kill").length)).toEqual([1]);
  await hub.answer(now[0]!.id, "kill");
  expect(hub.store.item(it.id)!.status).toBe("dropped");
});

const proposal = (killDate: string) =>
  hub.createItem({
    title: "a reflection proposal",
    kind: "idea",
    status: "proposed",
    source: { type: "memory", label: "Proposals 2026-09-20 · Medium Priority", key: `memory:proposals:${killDate}` },
    signals: { killDate },
  });

test("an open proposal card holds back the kill card", () => {
  // 11-05 it_mw470qfbthyrj: proposal and kill cards opened in the same tick.
  const it = proposal("2026-09-23");
  tick(at(23, 10));
  expect(cardsFor(it.id).map((q) => q.key)).toEqual([`proposal:${it.id}`]);
  tick(at(24, 11));
  expect(killCard(it.id)).toBeUndefined();
  // Control: the proposal card gone (answered elsewhere, yielded), the kill card asks.
  hub.expireQuestion(cardsFor(it.id)[0]!.id, "yielded");
  tick(at(24, 12));
  expect(killCard(it.id)?.key).toBe(`kill:${it.id}:2026-09-23`);
  expect(cardsFor(it.id)).toHaveLength(1);
});

test("an open kill card holds back the proposal card", () => {
  // 11-11 it_mwcrrhjb97ogt: its kill card opened first, its proposal card the next day beside it.
  const it = proposal("2026-09-23");
  const kill = hub.ask({ kind: "state", itemId: it.id, key: `kill:${it.id}:2026-09-23`, priority: 72, prompt: it.title, options: [] })!;
  tick(at(23, 10));
  expect(cardsFor(it.id).map((q) => q.key)).toEqual([`kill:${it.id}:2026-09-23`]);
  // Control: the kill card closed some other way (the date moved), the proposal card asks.
  hub.updateItem(it.id, { signals: { killDate: "2026-10-30" } });
  tick(at(23, 10, 5));
  expect(hub.store.question(kill.id)?.status).toBe("expired");
  expect(cardsFor(it.id).map((q) => q.key)).toEqual([`proposal:${it.id}`]);
});

test("a full board still puts Kill it on the due card", () => {
  const it = hub.createItem({ title: "slot first", status: "scheduled", scheduledFor: at(21, 9, 30).toISOString(), signals: { killDate: "2026-09-25" } });
  tick(at(21, 10));
  for (let i = 0; i < 20; i++) hub.ask({ kind: "state", key: `filler:${i}`, priority: 50, prompt: `filler ${i}`, options: [] });
  tick(at(24, 10));
  expect(cardsFor(it.id).map((q) => [q.key.split(":")[0], q.options.some((o) => o.id === "kill")])).toEqual([["due", true]]);
});

test("an agent on it: the due card doesn't gain Kill it, and no kill card", () => {
  const it = hub.createItem({ title: "slot first", status: "scheduled", scheduledFor: at(21, 9, 30).toISOString(), signals: { killDate: "2026-09-25" } });
  tick(at(21, 10));
  hub.putJob({ id: "j_busy", kind: "action", name: "work", title: "x", surface: "headless", status: "running", itemId: it.id, tail: [], createdAt: at(23, 9).toISOString() } as any);
  tick(at(24, 10));
  expect(cardsFor(it.id).map((q) => [q.key.split(":")[0], q.options.some((o) => o.id === "kill")])).toEqual([["due", false]]);
});

test("a note being read on the due card: no change, and the kill card stays until the button is there", () => {
  const it = hub.createItem({ title: "slot first", status: "scheduled", scheduledFor: at(21, 9, 30).toISOString(), signals: { killDate: "2026-09-25" } });
  tick(at(21, 10));
  const due = cardsFor(it.id)[0]!;
  const kill = hub.ask({ kind: "state", itemId: it.id, key: `kill:${it.id}:2026-09-25`, priority: 72, prompt: it.title, options: [] })!;
  const reading = (hub as unknown as { reading: Map<string, { n: number }> }).reading;
  reading.set(due.id, { n: 1 });
  tick(at(24, 10));
  expect(hub.store.question(due.id)!.options.some((o) => o.id === "kill")).toBe(false);
  expect(hub.store.question(kill.id)?.status).toBe("open");
  reading.delete(due.id); // the read ended
  tick(at(24, 10, 5));
  expect(hub.store.question(due.id)!.options.some((o) => o.id === "kill")).toBe(true);
  expect(hub.store.question(kill.id)).toMatchObject({ status: "expired", answer: "on It's time" });
});

test("the kill date moves later: the due card loses Kill it", () => {
  const it = hub.createItem({ title: "slot first", status: "scheduled", scheduledFor: at(21, 9, 30).toISOString(), signals: { killDate: "2026-09-25" } });
  tick(at(24, 10));
  expect(cardsFor(it.id)[0]!.options.some((o) => o.id === "kill")).toBe(true);
  hub.updateItem(it.id, { signals: { killDate: "2026-10-09" } }); // a memory re-import extended it
  tick(at(24, 10, 5));
  const open = cardsFor(it.id);
  expect(open.map((q) => q.key.split(":")[0])).toEqual(["due"]);
  expect(open[0]!.options.some((o) => o.id === "kill")).toBe(false);
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
