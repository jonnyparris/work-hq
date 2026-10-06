import { describe, expect, test } from "bun:test";
import { backoffMs, isRateLimited, LaunchGate } from "../src/server/launch-gate.ts";

const GRAMMAR =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Grammar compilation rate limit exceeded. Organization 9866 exceeded limit: 20 compilations per minute. You can try again later."}}';

describe("isRateLimited", () => {
  test("catches the 09-29 grammar compilation error and 503s", () => {
    expect(isRateLimited(GRAMMAR)).toBe(true);
    expect(isRateLimited("503 Service temporarily unavailable")).toBe(true);
    expect(isRateLimited("429 Too Many Requests")).toBe(true);
    expect(isRateLimited("overloaded_error: Overloaded")).toBe(true);
  });

  test("ignores real failures and quota exhaustion", () => {
    expect(isRateLimited(undefined)).toBe(false);
    expect(isRateLimited("pi exited 1: ENOENT")).toBe(false);
    expect(isRateLimited("400 invalid_request_error: prompt is too long")).toBe(false);
    expect(isRateLimited("429 insufficient_quota: check your billing")).toBe(false);
    expect(isRateLimited("request id req_5034")).toBe(false);
  });
});

describe("backoffMs", () => {
  test("stays inside the range", () => {
    expect(backoffMs({ minSec: 60, maxSec: 90 }, () => 0)).toBe(60_000);
    expect(backoffMs({ minSec: 60, maxSec: 90 }, () => 1)).toBe(90_000);
    expect(backoffMs({ minSec: 60, maxSec: 90 }, () => 0.5)).toBe(75_000);
    expect(backoffMs({ minSec: 90, maxSec: 60 }, () => 1)).toBe(90_000);
  });
});

describe("LaunchGate", () => {
  test("spaces a burst 20 s apart, in order", async () => {
    let t = 1_000_000;
    const slept: number[] = [];
    const gate = new LaunchGate(() => 20_000, () => t, async (ms) => void slept.push(ms));
    const waits = await Promise.all([gate.acquire(), gate.acquire(), gate.acquire()]);
    expect(waits).toEqual([0, 20_000, 40_000]);
    expect(slept).toEqual([20_000, 40_000]);
    expect(gate.wait()).toBe(60_000);
  });

  test("no wait once the spacing has passed", async () => {
    let t = 0;
    const gate = new LaunchGate(() => 20_000, () => t, async () => {});
    await gate.acquire();
    t = 25_000;
    expect(gate.wait()).toBe(0);
    expect(await gate.acquire()).toBe(0);
  });

  test("spacing 0 turns it off", async () => {
    const gate = new LaunchGate(() => 0, () => 5, async () => {});
    expect(await Promise.all([gate.acquire(), gate.acquire()])).toEqual([0, 0]);
  });
});
