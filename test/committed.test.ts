import { describe, expect, test } from "bun:test";
import { committedView } from "../src/shared/committed.ts";
import type { Item, Job } from "../src/shared/types.ts";

const now = Date.parse("2026-10-21T15:00:00");
const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
const item = (id: string, status: Item["status"], minsAgo = 10): Item =>
  ({ id, status, title: id, kind: "task", source: { type: "agent" }, createdAt: iso(minsAgo), updatedAt: iso(minsAgo) }) as Item;
const job = (itemId: string, status: Job["status"]): Job => ({ id: `job_${itemId}`, itemId, status }) as Job;

describe("Committed panel", () => {
  test("shows your open items, not doing items a live agent job owns", () => {
    const v = committedView([item("t", "today"), item("mine", "doing"), item("agent", "doing"), item("blocked", "doing")], [job("agent", "running"), job("blocked", "blocked"), job("mine", "done")], now);
    expect(v.rows.map((i) => i.id)).toEqual(["t", "mine"]);
    expect(v.open).toBe(2);
    expect(v.withAgents).toBe(2);
  });

  test("closures from the last 2 hours show, at most 3, newest first; older ones only count", () => {
    const done = [item("d5", "done", 5), item("d30", "done", 30), item("d60", "done", 60), item("d90", "done", 90), item("d200", "done", 200)];
    const v = committedView([item("t", "today"), ...done, item("old", "done", 60 * 24)], [], now);
    expect(v.rows.map((i) => i.id)).toEqual(["t", "d5", "d30", "d60"]);
    expect(v.doneToday).toBe(5);
  });

  test("dropped and other statuses never show", () => {
    expect(committedView([item("x", "dropped"), item("p", "proposed"), item("w", "waiting")], [], now).rows).toEqual([]);
  });
});
