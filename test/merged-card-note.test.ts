// 10-22 07:58 and 13:58: "chase Omar" typed on the one-item "Waiting on this, but its tickets are done: …TSINV-118…"
// card. HQ replied "Sending an agent to chase Omar." and nothing started, twice. The batched card had no itemId, so
// applyNote skipped the dispatch branch and saved the reader's false reply as context.
import { beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { type Dispatcher, Hub } from "../src/server/hub.ts";
import { type JiraInfo, JiraStates } from "../src/server/jira-state.ts";
import { MrStates } from "../src/server/mr-state.ts";
import { Prompter } from "../src/server/prompter.ts";
import type { NoteDecision } from "../src/shared/types.ts";

const J = (k: string) => `https://jira.example.org/browse/${k}`;
const tickets: Record<string, JiraInfo> = {
  "TSINV-118": { state: "done", status: "Done", doneAt: "2026-10-21T10:00:00Z" },
  "TSINV-119": { state: "done", status: "Closed", doneAt: "2026-10-21T11:00:00Z" },
};

let hub: Hub;
let p: Prompter;
let mrs: MrStates;
let jira: JiraStates;
let decision: NoteDecision;
const dispatched: Array<{ itemId: string; action: string; note?: string }> = [];
const toasts: string[] = [];

beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  mrs = new MrStates(async () => ({ state: "unknown" }));
  jira = new JiraStates(async (r) => tickets[r.key] ?? { state: "unknown" }, new Set(["jira.example.org"]));
  p = new Prompter(hub, mrs, jira);
  dispatched.length = 0;
  toasts.length = 0;
  decision = { dispatch: { action: "reply", note: "chase Omar" }, reply: "Sending an agent to chase Omar." };
  const d: Dispatcher = {
    dispatch: async (itemId, action, note) => (dispatched.push({ itemId, action, note }), undefined),
    scheduleFromWords: async () => {},
    readNote: async () => decision,
  };
  hub.dispatcher = d;
  hub.subscribe((e) => void (e.type === "toast" && toasts.push(e.data.text)));
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const card = () => hub.store.questions("open").find((q) => q.key === "wait:merged");
const run = async () => {
  p.tick(new Date());
  await Promise.all([mrs.settled(), jira.settled()]);
  p.tick(new Date());
};

test("one-item merged card: the card carries the item, and 'chase Omar' sends an agent on it", async () => {
  const it = hub.createItem({ title: "Omar: TSINV-118 follow-up", status: "waiting", links: [J("TSINV-118")] });
  await run();
  const q = card()!;
  expect(q.prompt).toBe("Waiting on this, but its tickets are done: Omar: TSINV-118 follow-up");
  expect(q.itemId).toBe(it.id);
  await hub.note(q.id, "chase Omar");
  await flush();
  expect(dispatched).toEqual([{ itemId: it.id, action: "reply", note: "chase Omar" }]);
  expect(hub.store.question(q.id)!.status).toBe("answered");
  expect(toasts.some((t) => /No agent started/.test(t))).toBe(false);
});

test("a card drawn before the fix (no itemId) heals on the next tick", async () => {
  const it = hub.createItem({ title: "x", status: "waiting", links: [J("TSINV-118")] });
  await run();
  const q = card()!;
  hub.store.putQuestion({ ...q, itemId: undefined });
  p.tick(new Date());
  expect(hub.store.question(q.id)!.itemId).toBe(it.id);
});

test("growing from one item to two clears itemId; shrinking back sets it", async () => {
  const a = hub.createItem({ title: "a", status: "waiting", links: [J("TSINV-118")] });
  await run();
  expect(card()!.itemId).toBe(a.id);
  const b = hub.createItem({ title: "b", status: "waiting", links: [J("TSINV-119")] });
  await run();
  expect(card()!.prompt).toBe("2 waiting items: their tickets are done. Mark all done?");
  expect(card()!.itemId).toBeUndefined();
  hub.setStatus(a.id, "done");
  p.tick(new Date());
  expect(card()!.itemId).toBe(b.id);
});

test("multi-item card: a dispatch note starts nothing and says so; the reply is kept only with its correction", async () => {
  hub.createItem({ title: "a", status: "waiting", links: [J("TSINV-118")] });
  hub.createItem({ title: "b", status: "waiting", links: [J("TSINV-119")] });
  await run();
  const q = card()!;
  await hub.note(q.id, "chase Omar");
  await flush();
  expect(dispatched).toHaveLength(0);
  expect(toasts).toContain("That card covers several items. Open one to act on it.");
  expect(toasts.some((t) => t.includes("Sending an agent"))).toBe(false);
  expect(hub.store.question(q.id)!.context).toContain("**HQ:** Sending an agent to chase Omar. (No agent started.)");
  expect(hub.store.journal().some((j) => j.who === "hq" && j.text.startsWith("Note reply claimed a dispatch but none started (card has no single item)"))).toBe(true);
  expect(Date.parse(hub.store.question(q.id)!.notBefore!)).toBeGreaterThan(Date.now() + 60 * 60_000);
});

test("context-only reply that claims an agent gets '(No agent started.)' everywhere it's kept", async () => {
  const it = hub.createItem({ title: "a", status: "waiting", links: [J("TSINV-118")] });
  await run();
  const q = card()!;
  decision = { reply: "Chasing Omar now." }; // reader forgot dispatch[]
  await hub.note(q.id, "chase Omar");
  await flush();
  expect(dispatched).toHaveLength(0);
  const want = "Chasing Omar now. (No agent started.)";
  expect(hub.store.item(it.id)!.notes?.some((n) => n.who === "hq" && n.text === want)).toBe(true);
  expect(hub.store.question(q.id)!.context).toContain(`**HQ:** ${want}`);
  expect(toasts.some((t) => t.startsWith(want))).toBe(true);
  expect(hub.store.journal().some((j) => j.text.startsWith("Note reply claimed a dispatch but none started (heuristic"))).toBe(true);
});

test("a plain answer in a context-only reply is left alone", async () => {
  hub.createItem({ title: "a", status: "waiting", links: [J("TSINV-118")] });
  await run();
  decision = { reply: "TSINV-118 closed yesterday." };
  await hub.note(card()!.id, "when did it close?");
  await flush();
  expect(toasts.some((t) => t.startsWith("TSINV-118 closed yesterday. Back"))).toBe(true);
  expect(hub.store.journal().some((j) => j.text.startsWith("Note reply claimed"))).toBe(false);
});

test("one-item card closes when its item is marked done elsewhere", async () => {
  const a = hub.createItem({ title: "a", status: "waiting", links: [J("TSINV-118")] });
  await run();
  const q = card()!;
  hub.setStatus(a.id, "done");
  expect(hub.store.question(q.id)!.status).toBe("expired");
});

test("one-item card expires once its item leaves waiting, so it stops blocking the item's other prompts", async () => {
  const a = hub.createItem({ title: "a", status: "waiting", links: [J("TSINV-118")] });
  await run();
  const q = card()!;
  // A full deck: the merged sweep (which would also drop it) doesn't run, so expireMoot has to.
  for (let i = 0; i < 20; i++) hub.ask({ kind: "open", key: `filler:${i}`, priority: 1, prompt: `filler ${i}`, options: [{ id: "x", label: "OK", effect: { type: "status", status: "done" } }] });
  hub.updateItem(a.id, { status: "today" });
  p.tick(new Date());
  expect(hub.store.question(q.id)!.status).toBe("expired");
});

test("a card that expired because its item moved on doesn't start the once-a-day cooldown", async () => {
  const a = hub.createItem({ title: "a", status: "waiting", links: [J("TSINV-118")] });
  await run();
  hub.setStatus(a.id, "done"); // closed on its own: the card expires unseen
  expect(card()).toBeUndefined();
  const b = hub.createItem({ title: "b", status: "waiting", links: [J("TSINV-119")] });
  await run();
  expect(card()?.itemId).toBe(b.id);
});
