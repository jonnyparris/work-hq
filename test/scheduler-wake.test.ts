import { expect, test } from "bun:test";
import { Scheduler, WAKE_GRACE_MS } from "../src/server/scheduler.ts";

// 10-19: sweeps started in Power Nap DarkWakes (2–10 s awake), froze, and failed on the next wake.
test("no sweeps for 3 min after the laptop wakes; normal ticks are unaffected", () => {
  const s = new Scheduler({} as any, {} as any, {} as any, {} as any);
  const t = Date.now();
  expect(s.justWoke(t + 60_000)).toBe(false); // on-time tick
  expect(s.justWoke(t + 120_000)).toBe(false);
  const wake = t + 120_000 + 45 * 60_000; // 45 min asleep: the overdue tick fires on wake
  expect(s.justWoke(wake)).toBe(true);
  expect(s.justWoke(wake + 60_000)).toBe(true);
  expect(s.justWoke(wake + 120_000)).toBe(true);
  expect(s.justWoke(wake + WAKE_GRACE_MS)).toBe(false);
  // DarkWake again 20 min later: grace restarts.
  expect(s.justWoke(wake + WAKE_GRACE_MS + 20 * 60_000)).toBe(true);
});
