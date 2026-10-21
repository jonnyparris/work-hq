import { describe, expect, test } from "bun:test";
import { finishedCleanly, pickIdle, type JobWorkspace } from "../src/server/cmux.ts";

const H = 3600_000;
const now = Date.parse("2026-09-28T22:00:00Z");
const ws = (jobId: string, keep = false): JobWorkspace => ({ id: jobId.toUpperCase(), ref: `workspace:${jobId}`, jobId, title: jobId, keep });

describe("pickIdle", () => {
  const since: Record<string, number | undefined> = {
    old: now - 5 * H,
    fresh: now - 1 * H,
    working: undefined, // beacon says working/blocked → undefined
    edge: now - 3 * H,
  };
  const pick = (list: JobWorkspace[], busy: string[] = []) =>
    pickIdle(list, { now, idleMs: 3 * H, busy: new Set(busy), idleSince: (j) => since[j] }).map((w) => w.jobId);

  test("closes only workspaces idle past the threshold", () => {
    expect(pick([ws("old"), ws("fresh"), ws("working"), ws("edge")])).toEqual(["old", "edge"]);
  });

  test("never closes selected/pinned or still-tracked jobs", () => {
    expect(pick([ws("old", true)])).toEqual([]);
    expect(pick([ws("old")], ["old"])).toEqual([]);
  });

  test("unknown beacon is left alone", () => {
    expect(pick([ws("nobeacon")])).toEqual([]);
  });

  test("a per-job threshold (finished cleanly) closes sooner; others keep the default", () => {
    const M = 60_000;
    const s2: Record<string, number> = { done: now - 25 * M, failed: now - 25 * M, fresh: now - 5 * M };
    const idleMsFor = (j: string) => (j === "failed" ? undefined : 20 * M);
    const got = pickIdle([ws("done"), ws("failed"), ws("fresh")], { now, idleMs: 3 * H, busy: new Set(), idleSince: (j) => s2[j], idleMsFor }).map((w) => w.jobId);
    expect(got).toEqual(["done"]);
  });
});

describe("finishedCleanly", () => {
  const job = { id: "job_1", status: "done" as const, itemId: "it_1" };
  test("done with nothing open on its item", () => {
    expect(finishedCleanly(job, [{ key: "other", itemId: "it_2" }])).toBe(true);
    expect(finishedCleanly({ id: "job_2", status: "done" }, [{ key: "x", itemId: undefined }])).toBe(true);
  });
  test("failed, running, or a card still open: keep it the long way", () => {
    expect(finishedCleanly({ ...job, status: "failed" }, [])).toBe(false);
    expect(finishedCleanly({ ...job, status: "running" }, [])).toBe(false);
    expect(finishedCleanly(job, [{ key: "after:job_1" }])).toBe(false);
    expect(finishedCleanly(job, [{ key: "agent:q", itemId: "it_1" }])).toBe(false);
    expect(finishedCleanly(undefined, [])).toBe(false);
  });
});
