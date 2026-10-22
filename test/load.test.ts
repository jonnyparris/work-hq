import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { RunCap } from "../src/server/launch-gate.ts";
import { LoadLog, type LoadSample, overloaded, summarise } from "../src/server/load.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("LoadLog keeps samples in the store and drops ones older than the window", () => {
  const store = new Store(":memory:");
  let l = [3.333, 2, 1];
  const log = new LoadLog(store, 10 * 60_000, () => l);
  const t0 = 1_000_000_000_000;
  log.record(2, t0);
  l = [7, 5, 4];
  log.record(4, t0 + 5 * 60_000);
  expect(log.samples()).toEqual([
    [t0, 3.33, 2, 1, 2],
    [t0 + 5 * 60_000, 7, 5, 4, 4],
  ]);
  log.record(1, t0 + 11 * 60_000); // the first sample is now outside the 10 min window
  expect(log.samples().map((s) => s[0])).toEqual([t0 + 5 * 60_000, t0 + 11 * 60_000]);
  expect(log.samples(t0 + 6 * 60_000)).toHaveLength(1);
});

test("a restart keeps the history: samples live in the db, not in memory", () => {
  const path = `${tmpdir()}/whq-load-${Date.now()}.db`;
  const a = new Store(path);
  new LoadLog(a, 86400_000, () => [9, 8, 7]).record(3, Date.now());
  a.db.close();
  const b = new Store(path);
  expect(new LoadLog(b).latest()?.slice(1)).toEqual([9, 8, 7, 3]);
  b.db.close();
  rmSync(path, { force: true });
});

test("hub.sampleLoad records, pushes a load event, and the snapshot carries the latest", () => {
  const hub = new Hub(new Store(":memory:"));
  const seen: unknown[] = [];
  hub.subscribe((e) => e.type === "load" && seen.push(e.data));
  const s = hub.sampleLoad(5);
  expect(s.jobs).toBe(5);
  expect(s.cores).toBeGreaterThan(0);
  expect(seen).toHaveLength(1);
  expect(hub.snapshot().load?.jobs).toBe(5);
});

test("summarise: peak, minutes over the core count, correlation and load by job count", () => {
  const t = 1_000_000_000_000;
  // Load tracks jobs closely: r near 1.
  const samples: LoadSample[] = Array.from({ length: 12 }, (_, i) => [t + i * 60_000, (i % 4) * 10 + 1, 0, 0, i % 4]);
  const s = summarise(samples, 12);
  expect(s.samples).toBe(12);
  expect(s.peak).toEqual({ at: new Date(t + 3 * 60_000).toISOString(), l1: 31, jobs: 3 });
  expect(s.overCores).toBe(6); // l1 21 and 31
  expect(s.r).toBe(1);
  expect(s.byJobs).toEqual([
    { jobs: 0, n: 3, meanL1: 1 },
    { jobs: 1, n: 3, meanL1: 11 },
    { jobs: 2, n: 3, meanL1: 21 },
    { jobs: 3, n: 3, meanL1: 31 },
  ]);
  // Too few samples, or no spread in job count: no r.
  expect(summarise(samples.slice(0, 5), 12).r).toBeUndefined();
  expect(summarise(samples.map((x) => [x[0], x[1], 0, 0, 2] as LoadSample), 12).r).toBeUndefined();
  expect(summarise([], 12)).toMatchObject({ samples: 0, meanL1: 0, byJobs: [] });
});

test("overloaded: off at 0, compares the 1-minute load", () => {
  expect(overloaded(0, () => [500, 0, 0])).toBe(false);
  expect(overloaded(40, () => [41, 0, 0])).toBe(true);
  expect(overloaded(40, () => [39, 99, 99])).toBe(false);
});

test("RunCap holds launches while overloaded, only when one of ours is running, and lets go on pump once load drops", async () => {
  let running = 0;
  let hot = true;
  const cap = new RunCap(() => 8, () => running, () => hot);
  // Nothing of ours running: outside load must not stall the queue.
  expect(cap.blocker()).toBeUndefined();
  const started: string[] = [];
  const take = (n: string) =>
    cap.acquire().then((release) => {
      started.push(n);
      running++;
      release!();
    });
  void take("a");
  await tick();
  expect(started).toEqual(["a"]);
  void take("b");
  void take("c");
  await tick();
  expect(started).toEqual(["a"]); // a is running and load is high: b and c wait
  expect(cap.blocker()).toBe("load");
  expect(cap.full()).toBe(true);
  hot = false; // load fell; no job stopped, so only a timer pump notices
  await tick();
  expect(started).toEqual(["a"]);
  cap.pump();
  await tick();
  expect(started).toEqual(["a", "b", "c"]);
});

test("RunCap: the job cap is reported before load, and a cap of 0 with load off never waits", async () => {
  const cap = new RunCap(() => 1, () => 1, () => true);
  expect(cap.blocker()).toBe("cap");
  const off = new RunCap(() => 0, () => 50);
  expect(off.full()).toBe(false);
  expect(await off.acquire()).toBeFunction();
});

test("RunCap: the load gate works with the job cap off (pi.maxRunningJobs 0, pi.maxLoad set)", async () => {
  let running = 1;
  let hot = true;
  const cap = new RunCap(() => 0, () => running, () => hot);
  let went = false;
  void cap.acquire().then(() => (went = true));
  await tick();
  expect(went).toBe(false);
  expect(cap.blocker()).toBe("load");
  hot = false;
  cap.pump();
  await tick();
  expect(went).toBe(true);
  running = 0;
});

test("usage digest has a machine-load section", async () => {
  const path = `${tmpdir()}/whq-usage-load-${Date.now()}.db`;
  const store = new Store(path);
  const now = Date.now();
  for (let i = 0; i < 12; i++) store.putLoad([now - (30 - i) * 60_000, 5 + (i % 3) * 10, 0, 0, i % 3], 0);
  store.db.close();
  const p = Bun.spawn(["bun", "src/cli/usage.ts", "--db", path, "--since", new Date(now - 3600_000).toISOString(), "--until", new Date(now + 60_000).toISOString()], {
    stdout: "pipe",
    env: { ...process.env, WORK_HQ_CONFIG: "none" },
  });
  const out = await new Response(p.stdout).text();
  rmSync(path, { force: true });
  expect(out).toContain("## Machine load");
  expect(out).toContain("12 samples");
  expect(out).toContain("Pearson r");
  expect(out).toContain("| 2 | 4 | 25 |");
});
