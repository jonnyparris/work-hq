// "Recheck": a bunch of MRs merged and Work HQ hadn't noticed. The merged card only reads `waiting` items, once a
// day, and open MRs sit in the cache for 30 min. Recheck looks every open item's links up again, now, and puts the
// ones that landed on one card, whatever lane they're in.
import { beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { JiraStates } from "../src/server/jira-state.ts";
import { MrStates } from "../src/server/mr-state.ts";
import { type PrInfo, PrStates } from "../src/server/pr-state.ts";
import { Prompter } from "../src/server/prompter.ts";
import { RefCache } from "../src/server/ref-cache.ts";

const PR = (n: number) => `https://github.com/acme/dodo/pull/${n}`;
const merged = (): PrInfo => ({ state: "merged", mergedAt: new Date(Date.now() - 3_600_000).toISOString() });
let prs: Record<string, PrInfo>;
let calls: string[];
let hub: Hub;
let p: Prompter;

beforeEach(() => {
  prs = { [PR(1)]: merged(), [PR(2)]: merged(), [PR(3)]: { state: "open" }, [PR(4)]: merged(), [PR(5)]: merged() };
  calls = [];
  hub = new Hub(new Store(":memory:"));
  const ghs = new PrStates(async (r) => (calls.push(r.url), prs[r.url] ?? { state: "unknown" }));
  p = new Prompter(hub, new MrStates(async () => ({ state: "unknown" })), new JiraStates(async () => ({ state: "unknown" }), new Set()), ghs);
});

const card = () => hub.store.openQuestionByKey("recheck");

test("every open lane, not just waiting; open PRs, failed lookups, busy items and closed items stay off", async () => {
  const doing = hub.createItem({ title: "Doing", status: "doing", links: [PR(1)] });
  const inbox = hub.createItem({ title: "Inbox", status: "inbox", links: [PR(2)] });
  hub.createItem({ title: "Still open", status: "waiting", links: [PR(3)] });
  hub.createItem({ title: "Lookup fails", status: "waiting", links: [PR(99)] });
  const busy = hub.createItem({ title: "Busy", status: "doing", links: [PR(4)] });
  hub.store.putJob({ id: "job_live", kind: "action", name: "work", title: "Work · Busy", surface: "cmux", status: "running", itemId: busy.id, tail: [], createdAt: new Date().toISOString() });
  hub.createItem({ title: "Done already", status: "done", links: [PR(5)] });

  const r = await p.recheck();
  expect(r.checked).toBe(5);
  expect(r.failed).toBe(1);
  expect(r.landed.map((x) => x.id).sort()).toEqual([doing.id, inbox.id].sort());
  const q = card()!;
  expect(q.picks!.map((x) => x.id).sort()).toEqual([doing.id, inbox.id].sort());
  expect(q.picks!.find((x) => x.id === doing.id)!.hint).toMatch(/^doing · dodo#1 merged/);
  expect(hub.store.syncState("recheck").error).toMatch(/1 lookup failed/);
});

test("it looks again even when the cache says open", async () => {
  const it = hub.createItem({ title: "Was open", status: "waiting", links: [PR(3)] });
  p.landed(it);
  await p.prs.settled();
  prs[PR(3)] = merged();
  // The normal path holds the open answer for 30 min.
  expect(p.landed(it)).toBeUndefined();
  const r = await p.recheck();
  expect(r.landed.map((x) => x.id)).toEqual([it.id]);
  expect(calls.filter((u) => u === PR(3)).length).toBe(2);
});

test("ticked items go done, the rest stay put and don't come straight back on the merged card", async () => {
  const a = hub.createItem({ title: "Alpha", status: "waiting", links: [PR(1)] });
  const b = hub.createItem({ title: "Bravo (merge + deploy)", status: "waiting", links: [PR(2)] });
  await p.recheck();
  const q = card()!;
  await hub.answer(q.id, "done", undefined, { picks: [a.id] });
  expect(hub.store.item(a.id)!.status).toBe("done");
  expect(hub.store.journal(20).some((j) => j.itemId === a.id && /Done: Alpha — rechecked: waiting · dodo#1 merged/.test(j.text))).toBe(true);
  expect(hub.store.item(b.id)!.status).toBe("waiting");
  p.tick(new Date());
  await p.prs.settled();
  p.tick(new Date());
  expect(hub.store.openQuestionByKey("wait:merged")).toBeUndefined();
});

test("nothing ticked: the card stays and says so", async () => {
  hub.createItem({ title: "Alpha", status: "waiting", links: [PR(1)] });
  hub.createItem({ title: "Bravo", status: "waiting", links: [PR(2)] });
  await p.recheck();
  await hub.answer(card()!.id, "done");
  expect(card()).toBeDefined();
});

test("an open merged card folds into the recheck card, and the merged sweep leaves its items alone", async () => {
  const a = hub.createItem({ title: "Alpha", status: "waiting", links: [PR(1)] });
  p.tick(new Date());
  await p.prs.settled();
  p.tick(new Date());
  const m = hub.store.openQuestionByKey("wait:merged")!;
  expect(m).toBeDefined();
  await p.recheck();
  expect(hub.store.question(m.id)!.status).toBe("expired");
  expect(card()!.picks!.map((x) => x.id)).toEqual([a.id]);
  p.tick(new Date());
  expect(hub.store.openQuestionByKey("wait:merged")).toBeUndefined();
});

test("items closed elsewhere drop off the card; it goes when none are left", async () => {
  const a = hub.createItem({ title: "Alpha", status: "doing", links: [PR(1)] });
  const b = hub.createItem({ title: "Bravo", status: "doing", links: [PR(2)] });
  await p.recheck();
  hub.setStatus(a.id, "done");
  p.tick(new Date());
  const q = card()!;
  expect(q.picks!.map((x) => x.id)).toEqual([b.id]);
  expect(q.options.find((o) => o.id === "all")!.label).toBe("Mark it done");
  hub.setStatus(b.id, "dropped");
  p.tick(new Date());
  expect(card()).toBeUndefined();
});

test("nothing landed: no card, a toast and the chip's summary", async () => {
  hub.createItem({ title: "Still open", status: "waiting", links: [PR(3)] });
  const r = await p.recheck();
  expect(r.landed).toEqual([]);
  expect(card()).toBeUndefined();
  expect(hub.store.syncState("recheck").cursor).toBe("1 checked · 0 landed");
});

test("RefCache runs at most maxActive lookups at once", async () => {
  let active = 0;
  let peak = 0;
  const cache = new RefCache<{ url: string }, { ok: boolean }>(
    async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { ok: true };
    },
    () => Infinity,
    { ok: false },
    3,
  );
  for (let i = 0; i < 20; i++) cache.get({ url: `u${i}` });
  await cache.settled();
  expect(peak).toBe(3);
  expect(cache.peek("u19")).toMatchObject({ ok: true });
});

test("a note that leaves something out asks for ticks instead of guessing", async () => {
  const a = hub.createItem({ title: "Alpha", status: "waiting", links: [PR(1)] });
  const b = hub.createItem({ title: "Bravo deploy", status: "waiting", links: [PR(2)] });
  await p.recheck();
  for (const words of ["all but the deploy one", "skip the deploy one", "no bravo", "bravo isn't"]) {
    await hub.answer(card()!.id, "done", words);
    expect(card()).toBeDefined();
  }
  expect(hub.store.item(a.id)!.status).toBe("waiting");
  expect(hub.store.item(b.id)!.status).toBe("waiting");
  expect(card()).toBeDefined();
  await hub.answer(card()!.id, "done", "alpha");
  expect(hub.store.item(a.id)!.status).toBe("done");
  expect(hub.store.item(b.id)!.status).toBe("waiting");
});

test("an item an agent picked up after the card was drawn isn't closed under it", async () => {
  const a = hub.createItem({ title: "Alpha", status: "doing", links: [PR(1)] });
  const b = hub.createItem({ title: "Bravo", status: "doing", links: [PR(2)] });
  await p.recheck();
  hub.store.putJob({ id: "job_b", kind: "action", name: "work", title: "Work · Bravo", surface: "cmux", status: "running", itemId: b.id, tail: [], createdAt: new Date().toISOString() });
  await hub.answer(card()!.id, "done", undefined, { picks: [a.id, b.id] });
  expect(hub.store.item(a.id)!.status).toBe("done");
  expect(hub.store.item(b.id)!.status).toBe("doing");
});

test("Mark all skips busy items too", async () => {
  const a = hub.createItem({ title: "Alpha", status: "doing", links: [PR(1)] });
  const b = hub.createItem({ title: "Bravo", status: "doing", links: [PR(2)] });
  await p.recheck();
  hub.store.putJob({ id: "job_b", kind: "action", name: "work", title: "Work · Bravo", surface: "cmux", status: "running", itemId: b.id, tail: [], createdAt: new Date().toISOString() });
  await hub.answer(card()!.id, "all");
  expect(hub.store.item(a.id)!.status).toBe("done");
  expect(hub.store.item(b.id)!.status).toBe("doing");
  expect(hub.store.journal(20).some((j) => j.itemId === a.id && /rechecked: doing · dodo#1 merged/.test(j.text))).toBe(true);
});

test("a recheck that throws says so on the chip, without claiming a successful run", async () => {
  hub.createItem({ title: "Alpha", status: "waiting", links: [PR(1)] });
  (p as unknown as { ask: () => never }).ask = () => {
    throw new Error("boom");
  };
  await expect(p.recheck()).rejects.toThrow("boom");
  const s = hub.store.syncState("recheck");
  expect(s.error).toBe("Recheck failed: boom");
  expect(s.lastOkAt).toBeUndefined();
});

test("a lookup already in flight when Recheck starts is waited for, then looked up again", async () => {
  const it = hub.createItem({ title: "Racing", status: "waiting", links: [PR(3)] });
  p.landed(it); // the tick's lookup, started before the merge
  prs[PR(3)] = merged();
  const r = await p.recheck();
  expect(r.landed.map((x) => x.id)).toEqual([it.id]);
});

test("bulk ops leave the recheck card alone", async () => {
  const { deckGroup, optionFor } = await import("../src/shared/batch.ts");
  hub.createItem({ title: "Alpha", status: "waiting", links: [PR(1)] });
  hub.createItem({ title: "Bravo", status: "waiting", links: [PR(2)] });
  await p.recheck();
  const q = card()!;
  expect(deckGroup(q)).toBe("recheck");
  expect(optionFor(q, "done")).toBeUndefined();
});

test("Mark all with a note that leaves one out asks for ticks", async () => {
  const a = hub.createItem({ title: "Alpha", status: "waiting", links: [PR(1)] });
  const b = hub.createItem({ title: "Bravo", status: "waiting", links: [PR(2)] });
  await p.recheck();
  const toasts: string[] = [];
  hub.subscribe((e) => void (e.type === "toast" && toasts.push(e.data.text)));
  for (const words of ["all but bravo", "the rest", "all with the exception of bravo", "only alpha", "all, leaving out bravo"]) {
    await hub.answer(card()!.id, "all", words);
    expect(card()).toBeDefined();
  }
  // Ticks don't rescue a qualified "Mark all" either.
  await hub.answer(card()!.id, "all", "all but bravo", { picks: [a.id] });
  expect(hub.store.item(a.id)!.status).toBe("waiting");
  expect(hub.store.item(b.id)!.status).toBe("waiting");
  expect(toasts.at(-1)).toMatch(/takes no note/);
  await hub.answer(card()!.id, "all", "all done");
  expect(hub.store.item(a.id)!.status).toBe("done");
  expect(hub.store.item(b.id)!.status).toBe("done");
});

test("the recheck card counts as covering several items", async () => {
  const { batchedItems } = await import("../src/server/hub.ts");
  hub.createItem({ title: "Alpha", status: "waiting", links: [PR(1)] });
  hub.createItem({ title: "Bravo", status: "waiting", links: [PR(2)] });
  await p.recheck();
  expect(batchedItems(card()!)).toBe(2);
});

test("a no-tick note naming an item still picks it, even with words ending in 'nt'", async () => {
  const a = hub.createItem({ title: "Brent client fix", status: "waiting", links: [PR(1)] });
  const b = hub.createItem({ title: "Bravo", status: "waiting", links: [PR(2)] });
  await p.recheck();
  await hub.answer(card()!.id, "done", "brent");
  expect(hub.store.item(a.id)!.status).toBe("done");
  expect(hub.store.item(b.id)!.status).toBe("waiting");
});

test("curly apostrophes count as a no", async () => {
  const a = hub.createItem({ title: "Alpha", status: "waiting", links: [PR(1)] });
  const b = hub.createItem({ title: "Bravo", status: "waiting", links: [PR(2)] });
  await p.recheck();
  await hub.answer(card()!.id, "done", "alpha, don’t close bravo");
  expect(hub.store.item(a.id)!.status).toBe("waiting");
  expect(hub.store.item(b.id)!.status).toBe("waiting");
});
