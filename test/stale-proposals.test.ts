import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { Prompter } from "../src/server/prompter.ts";
import { notePrompt } from "../src/server/prompts.ts";
import {
  lastTouch, STALE_PROPOSED_KEY, STALE_PROPOSED_PICKS, staleProposals, staleProposalsCard, sweepStaleProposals,
} from "../src/server/stale-proposals.ts";
import { blockedOption } from "../src/web/parts.tsx";
import type { Item, Job } from "../src/shared/types.ts";

// 11-06: 122 items on Proposed, 87 created over two weeks before, and nothing ever aged one out.

let hub: Hub;
beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
});

const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const item = (title: string, created: number, extra: Partial<Item> = {}) => {
  const it = hub.createItem({ title, kind: "task", status: "proposed" });
  const next = { ...it, createdAt: daysAgo(created), ...extra };
  hub.store.putItem(next);
  return next;
};
const card = () => hub.store.openQuestionByKey(STALE_PROPOSED_KEY);
const sweep = (at = now) => sweepStaleProposals(hub, hub.store.items(), hub.store.questions("open"), at);
const job = (itemId: string, createdAt: string): Job =>
  hub.store.putJob({ id: `job_${itemId}`, kind: "action", name: "work", title: "t", surface: "headless", status: "done", itemId, tail: [], createdAt } as Job);

describe("lastTouch", () => {
  test("latest of created, confirmed, an owner note and the latest job; agent / hq notes don't count", () => {
    const it = { createdAt: daysAgo(30), confirmedAt: daysAgo(20), notes: [{ at: daysAgo(10), text: "mine" }, { at: daysAgo(1), text: "bot", who: "agent" as const }] };
    expect(lastTouch(it)).toBe(Date.parse(daysAgo(10)));
    expect(lastTouch(it, daysAgo(5))).toBe(Date.parse(daysAgo(5)));
  });
});

describe("staleProposals", () => {
  test("only proposed items untouched for 14+ days, oldest first", () => {
    const a = item("old", 30);
    const b = item("older", 40);
    item("fresh", 3);
    item("two weeks less a day", 13);
    item("waiting, old", 30, { status: "waiting" });
    const found = staleProposals(hub.store.items(), now, { lastJob: new Map(), busy: new Set(), asked: new Set() });
    expect(found.map((f) => f.it.id)).toEqual([b.id, a.id]);
  });

  test("updatedAt doesn't make it fresh (memory re-imports bump it daily); confirmedAt does", () => {
    const a = item("memory item", 30);
    hub.updateItem(a.id, { detail: "refreshed text" }, { quiet: true });
    item("confirmed last week", 30, { confirmedAt: daysAgo(7) });
    const found = staleProposals(hub.store.items(), now, { lastJob: new Map(), busy: new Set(), asked: new Set() });
    expect(found.map((f) => f.it.id)).toEqual([a.id]);
  });

  test("left out: a future slot, a kill date, an agent on it, another card about it, a recent job", () => {
    item("deferred", 30, { scheduledFor: daysAgo(-2) });
    const pastSlot = item("past slot", 30, { scheduledFor: daysAgo(10) });
    item("kill date", 30, { signals: { killDate: "2026-11-11" } });
    const busy = item("busy", 30);
    const asked = item("asked", 30);
    const ran = item("job last week", 30);
    const found = staleProposals(hub.store.items(), now, {
      lastJob: new Map([[ran.id, daysAgo(6)]]),
      busy: new Set([busy.id]),
      asked: new Set([asked.id]),
    });
    expect(found.map((f) => f.it.title)).toEqual([pastSlot.title]);
  });
});

describe("the card", () => {
  test("shows at most STALE_PROPOSED_PICKS rows, oldest first, and says how many are left", () => {
    const found = Array.from({ length: 25 }, (_, i) => ({ it: { id: `it_${i}`, title: `t${i}`, kind: "task" as const, source: { type: "voice" as const } }, at: Date.parse(daysAgo(40 - i)) }));
    const c = staleProposalsCard(found, now);
    expect(c.picks).toHaveLength(STALE_PROPOSED_PICKS);
    expect(c.prompt).toContain("25 proposed items");
    expect(c.context).toContain(`Showing the oldest ${STALE_PROPOSED_PICKS} of 25`);
    expect(c.options.find((o) => o.id === "all")!.label).toBe(`Retire these ${STALE_PROPOSED_PICKS}`);
    expect(c.picks[0]!.hint).toContain("untouched 40 d");
  });

  test("tick asks one card for stale proposals; nothing stale, no card", () => {
    item("fresh", 2);
    new Prompter(hub).tick(now);
    expect(card()).toBeUndefined();
    const a = item("old", 30);
    new Prompter(hub).tick(now);
    expect(card()?.picks?.map((p) => p.id)).toEqual([a.id]);
  });

  test("a job on the item in the last two weeks keeps it off the card (store lookup), also one stored after the first lookup", () => {
    const a = item("old but worked on", 30);
    job(a.id, daysAgo(3));
    expect(sweep()).toBe(false);
    expect(card()).toBeUndefined();
    const b = item("old, job later", 30);
    expect(hub.store.lastJobAtByItem().has(b.id)).toBe(false); // the map is cached now
    job(b.id, daysAgo(1));
    expect(sweep()).toBe(false);
    expect(card()).toBeUndefined();
  });

  test("lastJobAtByItem covers every job, not just the last jobs() page", () => {
    const a = item("a", 30);
    hub.store.putJob({ id: "job_old", kind: "action", name: "work", title: "t", surface: "headless", status: "done", itemId: a.id, tail: [], createdAt: daysAgo(5) } as Job);
    for (let i = 0; i < 70; i++) hub.store.putJob({ id: `job_n${i}`, kind: "action", name: "work", title: "t", surface: "headless", status: "done", itemId: `it_other${i}`, tail: [], createdAt: daysAgo(1) } as Job);
    expect(hub.store.lastJobAtByItem().get(a.id)).toBe(daysAgo(5));
    // putJob keeps the cached map current: a newer job moves it, an older one doesn't.
    const newer = daysAgo(2);
    hub.store.putJob({ id: "job_newer", kind: "action", name: "work", title: "t", surface: "headless", status: "done", itemId: a.id, tail: [], createdAt: newer } as Job);
    hub.store.putJob({ id: "job_older", kind: "action", name: "work", title: "t", surface: "headless", status: "done", itemId: a.id, tail: [], createdAt: daysAgo(9) } as Job);
    expect(hub.store.lastJobAtByItem().get(a.id)).toBe(newer);
    hub.store.forgetJobCache();
    expect(hub.store.lastJobAtByItem().get(a.id)).toBe(newer);
  });

  test("a row on a recheck / stopped-agents card (picks, no itemId) stays off this card", () => {
    const a = item("on the recheck card", 30);
    const b = item("free", 31);
    hub.store.putQuestion({ id: "q_re", kind: "state", key: "recheck", prompt: "landed", picks: [{ id: a.id, label: "a" }], options: [], priority: 70, status: "open", createdAt: new Date().toISOString() });
    sweep();
    expect(card()!.picks!.map((p) => p.id)).toEqual([b.id]);
  });

  test("open card follows the board: a touched row drops off, the card goes when none are left", () => {
    const a = item("a", 30);
    const b = item("b", 31);
    sweep();
    expect(card()!.picks!.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    hub.setStatus(a.id, "today");
    sweep();
    expect(card()!.picks!.map((p) => p.id)).toEqual([b.id]);
    hub.setStatus(b.id, "waiting");
    sweep();
    expect(card()).toBeUndefined();
  });

  test("an open card doesn't grow while it's being read", () => {
    const a = item("a", 30);
    sweep();
    item("b", 31);
    sweep();
    expect(card()!.picks!.map((p) => p.id)).toEqual([a.id]);
  });
});

describe("answers", () => {
  test("Retire ticked: ticked go to dropped, the rest are kept (staleKeptAt now) and stay off the next card", async () => {
    const a = item("a", 30);
    const b = item("b", 31);
    sweep();
    await hub.answer(card()!.id, "retire", undefined, { picks: [a.id] });
    expect(hub.store.item(a.id)!.status).toBe("dropped");
    const kept = hub.store.item(b.id)!;
    expect(kept.status).toBe("proposed");
    expect(Date.parse(kept.staleKeptAt!)).toBeGreaterThan(now.getTime() - 60_000);
    expect(kept.confirmedAt).toBeUndefined();
    // A day later: b was kept, nothing else is stale.
    expect(sweep(new Date(now.getTime() + 86_400_000))).toBe(false);
    expect(hub.store.journal(10).some((j) => j.text.includes("retired: stale proposal"))).toBe(true);
  });

  test("Retire ticked with nothing ticked keeps the card open and changes nothing", async () => {
    const a = item("a", 30);
    sweep();
    const id = card()!.id;
    await hub.answer(id, "retire", undefined, { picks: [] });
    // reopen: the same card again, as a fresh open copy.
    expect(card()?.reopenedFrom).toBe(id);
    expect(hub.store.item(a.id)!.status).toBe("proposed");
    expect(hub.store.item(a.id)!.staleKeptAt).toBeUndefined();
  });

  test("Retire all drops every row; with a note it refuses", async () => {
    const a = item("a", 30);
    const b = item("b", 31);
    sweep();
    const id = card()!.id;
    await hub.answer(id, "all", "all but b");
    expect(card()?.reopenedFrom).toBe(id);
    expect(hub.store.item(b.id)!.status).toBe("proposed");
    await hub.answer(card()!.id, "all");
    expect([a, b].map((x) => hub.store.item(x.id)!.status)).toEqual(["dropped", "dropped"]);
  });

  test("Keep all drops nothing and keeps every row", async () => {
    const a = item("a", 30);
    sweep();
    await hub.answer(card()!.id, "keep");
    const it = hub.store.item(a.id)!;
    expect(it.status).toBe("proposed");
    expect(it.staleKeptAt).toBeDefined();
    expect(it.confirmedAt).toBeUndefined();
  });

  test("a row an agent picked up since the card was drawn is neither dropped nor kept", async () => {
    const a = item("a", 30);
    const b = item("b", 31);
    sweep();
    const id = card()!.id;
    hub.store.putJob({ id: "job_live", kind: "action", name: "work", title: "t", surface: "headless", status: "running", itemId: a.id, tail: [], createdAt: new Date().toISOString() } as Job);
    await hub.answer(id, "all");
    expect(hub.store.item(a.id)!.status).toBe("proposed");
    expect(hub.store.item(a.id)!.staleKeptAt).toBeUndefined();
    expect(hub.store.item(b.id)!.status).toBe("dropped");
    // Its job is a touch: it doesn't come straight back on the next card.
    expect(sweep(new Date(now.getTime() + 86_400_000))).toBe(false);
  });

  test("a typed note never answers the card (the note path refuses every option)", async () => {
    const a = item("a", 30);
    sweep();
    const id = card()!.id;
    // note() parks the card for 15 min while the reader reads; the refusal shows it again.
    const park = () => hub.store.putQuestion({ ...hub.store.question(id)!, notBefore: new Date(Date.now() + 15 * 60_000).toISOString() });
    park();
    await hub.applyNote(id, { pick: "keep" }, "still want this next quarter");
    expect(hub.store.question(id)!.notBefore).toBeUndefined();
    park();
    await hub.applyNote(id, { pick: "all" }, "drop them");
    park();
    await hub.applyNote(id, { status: "dropped" }, "drop the old ones");
    expect(hub.store.question(id)!.notBefore).toBeUndefined();
    park();
    await hub.applyNote(id, {}, "hmm");
    expect(hub.store.question(id)!.notBefore).toBeUndefined();
    expect(hub.store.question(id)!.status).toBe("open");
    expect(hub.store.item(a.id)!.status).toBe("proposed");
    expect(hub.store.item(a.id)!.staleKeptAt).toBeUndefined();
  });

  test("never changes another status: a row that moved off proposed since the card was drawn is left alone", async () => {
    const a = item("a", 30);
    const b = item("b", 31);
    sweep();
    const id = card()!.id;
    hub.updateItem(a.id, { status: "waiting" }); // no prompter tick in between
    await hub.answer(id, "all");
    expect(hub.store.item(a.id)!.status).toBe("waiting");
    expect(hub.store.item(b.id)!.status).toBe("dropped");
  });

  test("a note can't pick rows: the button is blocked and the note reader is told so", () => {
    const retire = { type: "retirePicks" } as const;
    expect(blockedOption(retire, 0, "the old ones")).toBe(true);
    expect(blockedOption(retire, 2, "")).toBe(false);
    expect(blockedOption({ type: "retirePicks", all: true }, 0, "but not b")).toBe(true);
    expect(blockedOption({ type: "retirePicks", keep: true }, 0, "")).toBe(false);
    item("a", 30);
    sweep();
    expect(notePrompt(card()!, undefined, "x", { now })).toContain("needs a tap, never pick this from a note");
  });

  test("the stale-cards fold leaves this card alone after 3 workdays (and still folds an ordinary old card)", () => {
    item("a", 30);
    sweep();
    const q = card()!;
    hub.store.putQuestion({ ...q, createdAt: daysAgo(10) });
    hub.store.putQuestion({ id: "q_old_agent", kind: "open", key: "agent:old", prompt: "old agent question", options: [], priority: 80, status: "open", createdAt: daysAgo(10) });
    new Prompter(hub).tick(now);
    const picks = hub.store.openQuestionByKey("stale")!.picks!.map((p) => p.id);
    expect(picks).toContain("q_old_agent");
    expect(picks).not.toContain(q.id);
  });

  test("keep doesn't stamp confirmedAt, so memory-sync can still retire an item memory stops listing", async () => {
    const a = item("memory todo", 30, { source: { type: "memory", key: "memory:todo:x" } });
    sweep();
    await hub.answer(card()!.id, "keep");
    const kept = hub.store.item(a.id)!;
    // memory-sync retire()'s condition: unconfirmed proposed/inbox items it no longer sees get dropped.
    expect(Boolean(kept.confirmedAt) || !["proposed", "inbox"].includes(kept.status)).toBe(false);
  });
});
