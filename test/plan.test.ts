import { describe, expect, test } from "bun:test";
import { Hub } from "../src/server/hub.ts";
import { Store } from "../src/server/db.ts";
import { MAX_SUGGESTED, planView, rate, searchPlan } from "../src/shared/plan.ts";
import type { Item } from "../src/shared/types.ts";

// 10-21: the plan card pre-ticked all 29 today + doing items, offered agent ideas, went stale, and unticking did nothing.
const NOW = new Date(2026, 9, 21, 9, 30).getTime();
const iso = (daysAgo: number, h = 9) => new Date(2026, 9, 21 - daysAgo, h).toISOString();
let n = 0;
const it = (p: Partial<Item>): Item => ({ id: `i${++n}`, title: `t${n}`, kind: "task", status: "proposed", source: { type: "memory" }, createdAt: iso(5), updatedAt: iso(1), ...p }) as Item;

describe("planView", () => {
  test("suggests at most three; agent-run and closed items never show", () => {
    const items = [
      ...Array.from({ length: 6 }, () => it({ status: "today", confirmedAt: iso(0) })),
      it({ status: "doing" }), it({ status: "doing" }), it({ status: "done" }), it({ status: "waiting" }),
    ];
    const v = planView(items, NOW);
    expect(v.suggested).toHaveLength(MAX_SUGGESTED);
    expect(v.rows.every((r) => !["doing", "done", "waiting"].includes(r.item.status))).toBe(true);
    expect(v.withAgents).toBe(2);
  });

  test("ranks a commitment from today and a due date over a stale carried item and an agent idea", () => {
    const stale = it({ title: "Blog posts", status: "today", confirmedAt: iso(6) });
    const fresh = it({ title: "Accept the invites", status: "today", confirmedAt: iso(0), source: { type: "transcript", label: "BUPK weekly" } });
    const due = it({ title: "Send the doc", signals: { dueDate: iso(-1).slice(0, 10) } });
    const sched = it({ title: "Call at 14", status: "scheduled", scheduledFor: new Date(2026, 9, 21, 14).toISOString() });
    const idea = it({ title: "Agent idea", kind: "idea", source: { type: "agent" } });
    const v = planView([stale, fresh, due, sched, idea], NOW);
    expect(v.suggested).toEqual([fresh.id, sched.id, due.id]);
    expect(v.hiddenIdeas).toBe(1);
    expect(v.rows.find((r) => r.item.id === idea.id)).toBeUndefined();
    expect(v.rows.find((r) => r.item.id === stale.id)!.why).toContain("still real?");
    expect(v.rows.find((r) => r.item.id === fresh.id)!.why).toBe("you committed to it today");
    expect(v.rows.find((r) => r.item.id === sched.id)!.why).toBe("scheduled 14:00");
    expect(v.rows.find((r) => r.item.id === due.id)!.group).toBe("due");
  });

  test("backlog is capped and scheduled-for-later stays out", () => {
    const items = [...Array.from({ length: 20 }, () => it({})), it({ status: "scheduled", scheduledFor: iso(-3) })];
    const v = planView(items, NOW);
    expect(v.rows.filter((r) => r.group === "backlog")).toHaveLength(8);
    expect(v.rows.some((r) => r.item.status === "scheduled")).toBe(false);
  });

  test("nothing ranks: falls back to what's already on today, never the backlog", () => {
    const t = it({ status: "today", confirmedAt: iso(9), source: { type: "agent" } });
    const v = planView([t, it({ source: { type: "agent" } })], NOW);
    expect(v.suggested).toEqual([t.id]);
  });
});

test("rate: reasons people can read", () => {
  expect(rate(it({ kind: "decision" }), NOW).why).toBe("a decision only you can make");
  expect(rate(it({ signals: { pineapple: true } }), NOW).why).toBe("you captured it 🍍");
  expect(rate(it({ signals: { killDate: iso(1).slice(0, 10) } }), NOW).why).toMatch(/^kill date passed/);
  expect(rate(it({ status: "today", confirmedAt: iso(1) }), NOW).why).toBe("carried from yesterday");
});

test("searchPlan: all words, any open status but doing, title hits first", () => {
  const a = it({ title: "Kitesurf RPS plan", status: "waiting" });
  const b = it({ title: "Other", detail: "about kitesurf rps" });
  const c = it({ title: "Kitesurf RPS run", status: "doing" });
  const d = it({ title: "Kitesurf RPS old", status: "done" });
  expect(searchPlan([b, a, c, d], "kitesurf rps").map((i) => i.id)).toEqual([a.id, b.id]);
  expect(searchPlan([a], "  ")).toEqual([]);
});

test("commitPlan: picks go to today, unticked today items go back to proposed, doing is untouched", async () => {
  const hub = new Hub(new Store(":memory:"));
  const keep = hub.createItem({ title: "keep", status: "today" });
  const drop = hub.createItem({ title: "not today", status: "today" });
  const pick = hub.createItem({ title: "pick", status: "proposed" });
  const agent = hub.createItem({ title: "agent", status: "doing" });
  const q = hub.ask({ kind: "plan", key: "plan:test", priority: 95, prompt: "three?", options: [{ id: "plan", label: "Commit", effect: { type: "commitPlan" } }] })!;
  await hub.answer(q.id, "plan", undefined, { itemIds: [keep.id, pick.id] });
  expect(hub.store.item(keep.id)!.status).toBe("today");
  expect(hub.store.item(pick.id)!.status).toBe("today");
  expect(hub.store.item(drop.id)!.status).toBe("proposed");
  expect(hub.store.item(agent.id)!.status).toBe("doing");
});
