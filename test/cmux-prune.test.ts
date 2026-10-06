import { describe, expect, test } from "bun:test";
import { pickIdle, type JobWorkspace } from "../src/server/cmux.ts";

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
});
