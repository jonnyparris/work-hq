import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub, queuedNote } from "../src/server/hub.ts";
import { cardItemIds, errorKey, FOLD_WINDOW_MS, FOLD_PREFIX, foldJobs, isFoldCard, pruneFold } from "../src/server/stopped-fold.ts";
import { Prompter } from "../src/server/prompter.ts";
import { blockedOption } from "../src/web/parts.tsx";
import type { Item, Job } from "../src/shared/types.ts";

// 10-24 17:31: five jobs stopped on "Connection error." in the same second and drew five "Agent stopped" cards.
// Stops on the same error within 2 min now share one card.

const noCmux: CmuxDeps = { available: () => false, launch: () => undefined, bootWaitMs: 10, bootRetryMs: 5 };

function setup(n: number) {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  const jobs: Job[] = [];
  for (let i = 0; i < n; i++) {
    const item: Item = { id: `it_${i}`, kind: "idea", status: "doing", title: `Thing ${i}`, source: { type: "manual" }, createdAt: "", updatedAt: "" };
    hub.store.putItem(item);
    const job: Job = { id: `job_${i}`, kind: "action", name: i % 2 ? "ticket" : "work", title: `Work · Thing ${i}`, surface: "headless", status: "running", itemId: item.id, note: `note ${i}`, decision: `Q${i} → Do it`, tail: [], createdAt: new Date().toISOString() };
    hub.store.putJob(job);
    jobs.push(job);
  }
  const fail = (id: string, error: string) => (agents as unknown as { finishAction(id: string, r: { ok: boolean; text: string; error?: string }): void }).finishAction(id, { ok: false, text: "", error });
  return { hub, agents, jobs, fail };
}

const stopped = (hub: Hub) => hub.store.questions("open").filter((q) => q.key.startsWith("after:"));

test("five jobs failing 'Connection error.' in the same second draw one card", () => {
  const { hub, jobs, fail } = setup(5);
  for (const j of jobs) fail(j.id, "Connection error.");
  const open = stopped(hub);
  expect(open).toHaveLength(1);
  const q = open[0]!;
  expect(q.key).toBe(`${FOLD_PREFIX}job_0`);
  expect(q.itemId).toBeUndefined();
  expect(q.prompt).toBe("5 agents stopped on the same error. Where do they stand?");
  expect(q.picks!.map((p) => p.id)).toEqual(["it_0", "it_1", "it_2", "it_3", "it_4"]);
  expect(foldJobs(q)).toEqual({ it_0: "job_0", it_1: "job_1", it_2: "job_2", it_3: "job_3", it_4: "job_4" });
  expect(q.options.map((o) => o.id)).toEqual(["check", "check-ticked", "rerun", "rerun-ticked", "today"]);
  expect(q.context!.split("\n")[0]).toBe("Connection error.");
  // The per-job cards it replaced are closed, not left open.
  const closed = hub.store.questions().filter((x) => x.key === "after:job_0" || x.key === "after:job_1");
  expect(closed.every((x) => x.status === "expired")).toBe(true);
  expect(cardItemIds(q)).toEqual(["it_0", "it_1", "it_2", "it_3", "it_4"]);
});

test("a retry suffix is the same error; a different error gets its own card", () => {
  const { hub, jobs, fail } = setup(3);
  fail(jobs[0]!.id, "Connection error.");
  fail(jobs[1]!.id, "Connection error. (again after one retry)");
  fail(jobs[2]!.id, "Request timed out.");
  const open = stopped(hub);
  expect(open.map((q) => q.key).sort()).toEqual(["after:fold:job_0", "after:job_2"]);
  expect(errorKey("Connection error. (again after one retry)")).toBe("Connection error.");
});

test("a stop more than 2 min after the last one gets its own card", () => {
  const { hub, jobs, fail } = setup(2);
  fail(jobs[0]!.id, "Connection error.");
  const j0 = hub.store.job(jobs[0]!.id)!;
  hub.store.putJob({ ...j0, finishedAt: new Date(Date.now() - 3 * 60_000).toISOString() });
  fail(jobs[1]!.id, "Connection error.");
  expect(stopped(hub).map((q) => q.key).sort()).toEqual(["after:job_0", "after:job_1"]);
});

test("a later stop on the same error joins the open fold card", () => {
  const { hub, jobs, fail } = setup(3);
  fail(jobs[0]!.id, "Connection error.");
  fail(jobs[1]!.id, "Connection error.");
  fail(jobs[2]!.id, "Connection error.");
  const open = stopped(hub);
  expect(open).toHaveLength(1);
  expect(open[0]!.picks).toHaveLength(3);
  expect(open[0]!.options[0]!.label).toBe("Check all 3 for me");
});

test("Check all sends a verify agent per item; Send ticked again re-sends only the ticked ones, same action and note", async () => {
  const { hub, jobs, fail } = setup(3);
  for (const j of jobs) fail(j.id, "Connection error.");
  const sent: Array<{ itemId: string; action: string; note?: string; decision?: string }> = [];
  hub.dispatcher = { dispatch: async (itemId, action, note, decision) => (sent.push({ itemId, action, note, decision }), undefined), scheduleFromWords: async () => {} };
  const q = stopped(hub)[0]!;
  await hub.answer(q.id, "rerun-ticked", undefined, { picks: ["it_1"] });
  expect(sent).toEqual([{ itemId: "it_1", action: "ticket", note: "note 1", decision: "Q1 → Do it" }]);
  expect(hub.store.question(q.id)!.status).not.toBe("open");

  // Same again on a fresh fold card, Check all this time, with a note for the agents.
  const h2 = setup(3);
  for (const j of h2.jobs) h2.fail(j.id, "Connection error.");
  const got: typeof sent = [];
  h2.hub.dispatcher = { dispatch: async (itemId, action, note) => (got.push({ itemId, action, note }), undefined), scheduleFromWords: async () => {} };
  await h2.hub.answer(stopped(h2.hub)[0]!.id, "check", "the gateway was down");
  expect(got.map((s) => [s.itemId, s.action])).toEqual([["it_0", "verify"], ["it_1", "verify"], ["it_2", "verify"]]);
  expect(got[1]!.note).toContain("job_1");
  expect(got[1]!.note).toContain("They added: the gateway was down");
});

test("a ticked option with nothing ticked keeps the card and sends nothing", async () => {
  const { hub, jobs, fail } = setup(2);
  for (const j of jobs) fail(j.id, "Connection error.");
  const sent: string[] = [];
  hub.dispatcher = { dispatch: async (itemId) => (sent.push(itemId), undefined), scheduleFromWords: async () => {} };
  const q = stopped(hub)[0]!;
  await hub.answer(q.id, "check-ticked");
  expect(sent).toEqual([]);
  expect(hub.store.openQuestionByKey(q.key)).toBeDefined(); // reopened under a new id
  expect(blockedOption({ type: "stoppedPicks", act: "check", jobs: {} }, 0, "a note")).toBe(true);
  expect(blockedOption({ type: "stoppedPicks", act: "check", jobs: {} }, 1, "")).toBe(false);
  expect(blockedOption({ type: "stoppedPicks", act: "rerun", all: true, jobs: {} }, 0, "a note")).toBe(false);
});

test("the fold card follows the board: closed items and recovered jobs drop off, it goes when none are left", () => {
  const { hub, jobs, fail } = setup(3);
  for (const j of jobs) fail(j.id, "Connection error.");
  const q = () => hub.store.questions().find((x) => isFoldCard(x))!;
  hub.store.putItem({ ...hub.store.item("it_0")!, status: "done" });
  pruneFold(hub, q());
  expect(q().picks!.map((p) => p.id)).toEqual(["it_1", "it_2"]);
  expect(Object.keys(foldJobs(q()))).toEqual(["it_1", "it_2"]);
  hub.store.putJob({ ...hub.store.job("job_1")!, status: "done" }); // reported after all
  pruneFold(hub, q());
  expect(q().prompt).toBe("Agent stopped: Thing 2. Where does it stand?");
  expect(q().itemId).toBe("it_2");
  hub.store.putItem({ ...hub.store.item("it_2")!, status: "dropped" });
  pruneFold(hub, q());
  expect(q().status).toBe("expired");
});

test("an earlier stop on the same item folds in too, so the item sits on one card", () => {
  const { hub, jobs, fail } = setup(2);
  fail(jobs[0]!.id, "Connection error.");
  hub.store.putJob({ ...hub.store.job("job_0")!, finishedAt: new Date(Date.now() - 1000).toISOString() });
  // A re-send on it_0 that died on the same error a moment later.
  const again: Job = { ...jobs[0]!, id: "job_0b", status: "running", finishedAt: undefined };
  hub.store.putJob(again);
  fail(again.id, "Connection error.");
  // Same item only: the usual single card each, as before.
  expect(stopped(hub).map((q) => q.key).sort()).toEqual(["after:job_0", "after:job_0b"]);
  fail(jobs[1]!.id, "Connection error.");
  const open = stopped(hub);
  expect(open).toHaveLength(1);
  expect(foldJobs(open[0]!)).toEqual({ it_0: "job_0b", it_1: "job_1" });
});

test("the prompter prunes the fold card and doesn't ask 'Still on it?' about items on it", () => {
  const { hub, jobs, fail } = setup(3);
  for (const j of jobs.slice(0, 2)) fail(j.id, "Connection error.");
  // A weekday 15:00 two-plus days on; every item and job went quiet a day and a half before it.
  const now = new Date(Date.now() + 2 * 86400_000);
  while (now.getDay() === 0 || now.getDay() === 6) now.setDate(now.getDate() + 1);
  now.setHours(15, 0, 0, 0);
  const quiet = new Date(now.getTime() - 36 * 3600_000).toISOString();
  for (const id of ["it_0", "it_1", "it_2"]) hub.store.putItem({ ...hub.store.item(id)!, updatedAt: quiet });
  for (const id of ["job_0", "job_1", "job_2"]) hub.store.putJob({ ...hub.store.job(id)!, ...(id === "job_2" ? { status: "done" as const } : {}), finishedAt: quiet });
  const p = new Prompter(hub);
  p.tick(now);
  // it_2 (no card) gets asked; the two on the fold card don't.
  expect(hub.store.questions("open").filter((q) => q.key.startsWith("doing:")).map((q) => q.itemId)).toEqual(["it_2"]);
  hub.store.putItem({ ...hub.store.item("it_0")!, status: "done" });
  p.tick(new Date(now.getTime() + 5 * 60_000));
  const fold = hub.store.questions("open").find(isFoldCard)!;
  expect(cardItemIds(fold)).toEqual(["it_1"]);
  expect(fold.picks).toBeUndefined(); // nothing to tick
  // One row: that item's card, with its id and the single card's Waiting / Done.
  expect(fold.itemId).toBe("it_1");
  expect(fold.options.map((o) => o.id)).toEqual(["check", "rerun", "today", "wait", "done"]);
});

test("Send ticked again: the unticked rows come back on the card", async () => {
  const { hub, jobs, fail } = setup(3);
  for (const j of jobs) fail(j.id, "Connection error.");
  const sent: string[] = [];
  hub.dispatcher = { dispatch: async (itemId) => (sent.push(itemId), undefined), scheduleFromWords: async () => {} };
  const q = stopped(hub)[0]!;
  await hub.answer(q.id, "rerun-ticked", undefined, { picks: ["it_1"] });
  expect(sent).toEqual(["it_1"]);
  const back = hub.store.openQuestionByKey(q.key)!;
  expect(back.id).not.toBe(q.id);
  expect(back.picks!.map((p) => p.id)).toEqual(["it_0", "it_2"]);
  // Everything sent: nothing comes back.
  await hub.answer(back.id, "check");
  expect(hub.store.openQuestionByKey(q.key)).toBeUndefined();
});

test("the window is anchored to the job that started the card: stops 1.5 min apart don't chain forever", () => {
  const { hub, jobs, fail } = setup(3);
  fail(jobs[0]!.id, "Connection error.");
  fail(jobs[1]!.id, "Connection error.");
  const key = stopped(hub)[0]!.key;
  // The card's first stop is now 3 min back, the second 1.5 min: a third stop joins neither the card nor its rows.
  hub.store.putJob({ ...hub.store.job("job_0")!, finishedAt: new Date(Date.now() - 3 * 60_000).toISOString() });
  hub.store.putJob({ ...hub.store.job("job_1")!, finishedAt: new Date(Date.now() - FOLD_WINDOW_MS * 0.75).toISOString() });
  fail(jobs[2]!.id, "Connection error.");
  const open = stopped(hub);
  expect(open.map((q) => q.key).sort()).toEqual([key, "after:job_2"]);
});

test("finishAction's trailing notes are the same error; other parentheses aren't", () => {
  expect(errorKey("Connection error. (couldn't nudge the session)")).toBe("Connection error.");
  expect(errorKey("Connection error. (nudge didn't start a new turn)")).toBe("Connection error.");
  expect(errorKey("pi exited (1)")).not.toBe(errorKey("pi exited (137)"));
  expect(errorKey("  ")).toBeUndefined();
});

test("a send that fails keeps its row on the card; 'all' brings back only what didn't go", async () => {
  const { hub, jobs, fail } = setup(3);
  for (const j of jobs) fail(j.id, "Connection error.");
  const sent: string[] = [];
  hub.dispatcher = {
    dispatch: async (itemId) => {
      if (itemId === "it_1") throw new Error("worktree failed");
      sent.push(itemId);
      return undefined;
    },
    scheduleFromWords: async () => {},
  };
  const q = stopped(hub)[0]!;
  await hub.answer(q.id, "rerun");
  expect(sent).toEqual(["it_0", "it_2"]);
  const back = hub.store.openQuestionByKey(q.key)!;
  expect(back.itemId).toBe("it_1");
  // One row: "all" works without tick-boxes.
  hub.dispatcher = { dispatch: async (itemId) => (sent.push(itemId), undefined), scheduleFromWords: async () => {} };
  await hub.answer(back.id, "check");
  expect(sent).toEqual(["it_0", "it_2", "it_1"]);
  expect(hub.store.openQuestionByKey(q.key)).toBeUndefined();
});

test("a snoozed fold card shows again when a new stop joins; a peer parked on a note is left alone", () => {
  const { hub, jobs, fail } = setup(4);
  fail(jobs[0]!.id, "Connection error.");
  fail(jobs[1]!.id, "Connection error.");
  const fold = stopped(hub)[0]!;
  hub.store.putQuestion({ ...fold, notBefore: new Date(Date.now() + 3600_000).toISOString() });
  fail(jobs[2]!.id, "Connection error.");
  expect(hub.store.openQuestionByKey(fold.key)!.notBefore).toBeUndefined();
  expect(Object.keys(foldJobs(hub.store.openQuestionByKey(fold.key)!))).toEqual(["it_0", "it_1", "it_2"]);

  const h2 = setup(2);
  h2.fail("job_0", "Connection error.");
  const parked = stopped(h2.hub)[0]!;
  h2.hub.store.putQuestion({ ...parked, notBefore: new Date(Date.now() + 15 * 60_000).toISOString() });
  h2.fail("job_1", "Connection error.");
  expect(stopped(h2.hub).map((q) => q.key).sort()).toEqual(["after:job_0", "after:job_1"]);
});

test("the card still takes stops after its first job reports after all (its error cleared)", () => {
  const { hub, jobs, fail } = setup(3);
  fail(jobs[0]!.id, "Connection error.");
  fail(jobs[1]!.id, "Connection error.");
  hub.store.putJob({ ...hub.store.job("job_0")!, status: "done", error: undefined });
  fail(jobs[2]!.id, "Connection error.");
  const open = stopped(hub);
  expect(open).toHaveLength(1);
  expect(Object.keys(foldJobs(open[0]!))).toEqual(["it_1", "it_2"]); // it_0 recovered: off the card
});

test("a note can't pick a tick-only option; a note on 'Check all' reads as queued work", async () => {
  const { hub, jobs, fail } = setup(2);
  for (const j of jobs) fail(j.id, "Connection error.");
  const sent: string[] = [];
  hub.dispatcher = { dispatch: async (itemId) => (sent.push(itemId), undefined), scheduleFromWords: async () => {} };
  const q = stopped(hub)[0]!;
  await hub.applyNote(q.id, { pick: "check-ticked" }, "check the first one");
  expect(sent).toEqual([]);
  expect(hub.store.question(q.id)!.status).toBe("open");
  expect(queuedNote(q, { pick: "check", reply: "Checked them all" })).toBe("Noted → Check all 2 for me");
});

test("a restart with a fold card open leaves it as it is", () => {
  const { hub, jobs, fail } = setup(2);
  for (const j of jobs) fail(j.id, "Connection error.");
  const before = JSON.stringify(stopped(hub));
  new Agents(hub, noCmux);
  expect(JSON.stringify(stopped(hub))).toBe(before);
});
