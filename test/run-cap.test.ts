import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { config } from "../src/server/config.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { RunCap } from "../src/server/launch-gate.ts";
import type { Item } from "../src/shared/types.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("RunCap", () => {
  test("lets `max` through, queues the rest in order, frees a slot when one stops running", async () => {
    let running = 0;
    const cap = new RunCap(() => 2, () => running);
    const order: string[] = [];
    const take = (name: string) =>
      cap.acquire().then((release) => {
        order.push(name);
        running++; // the job is now marked running in the store…
        release!(); // …so its reservation goes
      });
    void take("a"), void take("b"), void take("c"), void take("d");
    await tick();
    expect(order).toEqual(["a", "b"]);
    expect(cap.full()).toBe(true);
    expect(cap.waiting).toBe(2);
    running--; // a finished
    cap.pump();
    await tick();
    expect(order).toEqual(["a", "b", "c"]);
    running -= 2;
    cap.pump();
    await tick();
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(cap.waiting).toBe(0);
  });

  test("a reservation holds the slot until released, so two waiters can't share one", async () => {
    const cap = new RunCap(() => 1, () => 0);
    const first = await cap.acquire();
    let second = false;
    void cap.acquire().then(() => (second = true));
    await tick();
    expect(second).toBe(false);
    first!();
    first!(); // a second call is ignored
    await tick();
    expect(second).toBe(true);
  });

  test("a waiter cancelled while queued resolves undefined and doesn't hold up the queue", async () => {
    let running = 1;
    const cap = new RunCap(() => 1, () => running);
    let wanted = true;
    const cancelled = cap.acquire(() => wanted);
    let next: (() => void) | undefined;
    void cap.acquire().then((r) => (next = r));
    wanted = false;
    running = 0;
    cap.pump();
    expect(await cancelled).toBeUndefined();
    await tick();
    expect(next).toBeFunction();
  });

  test("full() ignores a waiter that's no longer wanted, before any pump drops it", async () => {
    let running = 1;
    const cap = new RunCap(() => 1, () => running);
    let wanted = true;
    void cap.acquire(() => wanted);
    running = 0;
    wanted = false;
    expect(cap.waiting).toBe(1);
    expect(cap.full()).toBe(false);
  });

  test("max 0 turns the cap off", async () => {
    const cap = new RunCap(() => 0, () => 99);
    expect(cap.full()).toBe(false);
    expect(await cap.acquire()).toBeFunction();
  });
});

describe("Agents with a cap of 2", () => {
  const prev = { max: config.pi.maxRunningJobs, spacing: config.pi.launchSpacingSec };
  beforeEach(() => {
    config.pi.maxRunningJobs = 2;
    config.pi.launchSpacingSec = 0;
  });
  afterEach(() => {
    config.pi.maxRunningJobs = prev.max;
    config.pi.launchSpacingSec = prev.spacing;
  });

  function setup() {
    const launched: string[] = [];
    const deps: CmuxDeps = { available: () => true, launch: (o) => (launched.push(o.jobId), { workspace: `ws_${o.jobId}`, statusPath: "/dev/null" }) };
    const hub = new Hub(new Store(":memory:"));
    const items = ["a", "b", "c", "d"].map((x): Item => ({ id: `it_cap${x}`, kind: "idea", status: "proposed", title: `Thing ${x}`, source: { type: "manual" }, createdAt: "", updatedAt: "" }));
    for (const i of items) hub.store.putItem(i);
    const agents = new Agents(hub, deps);
    return { hub, items, agents, launched };
  }
  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 200 && !until(); i++) await Bun.sleep(5);
  };

  test("the third and fourth dispatch wait as queued, then launch as running ones stop", async () => {
    const { hub, items, agents, launched } = setup();
    const jobs = [];
    for (const i of items) jobs.push((await agents.dispatch(i.id, "work"))!);
    await settle(() => launched.length >= 2);
    await Bun.sleep(20);
    expect(launched).toEqual([jobs[0]!.id, jobs[1]!.id]);
    expect(hub.store.job(jobs[2]!.id)!.status).toBe("queued");
    expect(hub.store.job(jobs[2]!.id)!.tail.join("\n")).toContain("waiting for a slot: 2 agents running (cap 2)");

    // Stopping a running one frees its slot for the oldest waiter.
    agents.cancel(jobs[0]!.id);
    await settle(() => launched.length >= 3);
    expect(launched[2]).toBe(jobs[2]!.id);
    expect(hub.store.job(jobs[2]!.id)!.status).toBe("running");
    expect(hub.store.job(jobs[3]!.id)!.status).toBe("queued");

    // Stopping a queued one drops it: it never launches, and the next slot isn't wasted on it.
    agents.cancel(jobs[3]!.id);
    agents.cancel(jobs[1]!.id);
    await Bun.sleep(30);
    expect(launched).toHaveLength(3);
  });

  test("with load above pi.maxLoad, the second dispatch holds on load, then goes once load falls", async () => {
    const { hub, items, agents, launched } = setup();
    const prevLoad = config.pi.maxLoad;
    config.pi.maxLoad = 40;
    agents.readLoad = () => [55.2, 30, 20];
    try {
      const a = (await agents.dispatch(items[0]!.id, "work"))!;
      await settle(() => launched.length >= 1);
      expect(launched).toEqual([a.id]); // nothing of ours was running: outside load doesn't hold the first
      const b = (await agents.dispatch(items[1]!.id, "work"))!;
      await Bun.sleep(20);
      expect(launched).toHaveLength(1);
      expect(hub.store.job(b.id)!.status).toBe("queued");
      expect(hub.store.job(b.id)!.tail.join("\n")).toContain("holding: load 55.2 is above 40 (pi.maxLoad)");
      agents.readLoad = () => [12, 30, 20]; // load fell; nothing stopped
      agents.cap.pump(); // the scheduler's 15 s timer
      await settle(() => launched.length >= 2);
      expect(launched).toEqual([a.id, b.id]);
    } finally {
      config.pi.maxLoad = prevLoad;
    }
  });

  test("a headless run waiting out a rate limit (queued, already started) keeps its slot", async () => {
    const { hub, items, agents, launched } = setup();
    const base = { kind: "action" as const, name: "work", title: "t", surface: "headless" as const, tail: [], createdAt: "2026-01-01T00:00:00Z" };
    hub.putJob({ ...base, id: "job_retry", status: "queued", startedAt: "2026-01-01T00:00:01Z" });
    hub.putJob({ ...base, id: "job_run", status: "running", startedAt: "2026-01-01T00:00:01Z" });
    expect(agents.cap.full()).toBe(true);
    const job = (await agents.dispatch(items[0]!.id, "work"))!;
    await Bun.sleep(20);
    expect(launched).toEqual([]);
    expect(hub.store.job(job.id)!.status).toBe("queued");
  });

  test("cancelling a queued job frees the queue at once (no 'waiting' for a slot that's free)", async () => {
    const { hub, items, agents, launched } = setup();
    const jobs = [];
    for (const i of items.slice(0, 3)) jobs.push((await agents.dispatch(i.id, "work"))!);
    await settle(() => launched.length >= 2);
    agents.cancel(jobs[2]!.id); // the waiter: dropped at once, while both runners still run
    expect(agents.cap.waiting).toBe(0);
    agents.cancel(jobs[0]!.id); // a runner: one slot free, nobody waiting
    expect(agents.cap.full()).toBe(false);
    expect(agents.cap.waiting).toBe(0);
    expect(hub.store.job(jobs[2]!.id)!.status).toBe("failed");
  });

  test("a launch that throws fails the job and frees its reservation", async () => {
    const hub = new Hub(new Store(":memory:"));
    const items = ["x", "y"].map((x): Item => ({ id: `it_thr${x}`, kind: "idea", status: "proposed", title: x, source: { type: "manual" }, createdAt: "", updatedAt: "" }));
    for (const i of items) hub.store.putItem(i);
    let n = 0;
    const deps: CmuxDeps = { available: () => true, launch: (o) => { if (n++ === 0) throw new Error("boom"); return { workspace: `ws_${o.jobId}`, statusPath: "/dev/null" }; } };
    const agents = new Agents(hub, deps);
    config.pi.maxRunningJobs = 1;
    const a = (await agents.dispatch(items[0]!.id, "work"))!;
    const b = (await agents.dispatch(items[1]!.id, "work"))!;
    await settle(() => hub.store.job(b.id)!.status === "running");
    expect(hub.store.job(a.id)!.status).toBe("failed");
    expect(hub.store.job(a.id)!.error).toContain("launch failed: boom");
    expect(hub.store.job(b.id)!.status).toBe("running");
  });

  test("after a restart, queued cmux launches go oldest first, however many jobs came since", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { jobDir } = await import("../src/server/cmux.ts");
    const hub = new Hub(new Store(":memory:"));
    const launched: string[] = [];
    const deps: CmuxDeps = { available: () => true, launch: (o) => (launched.push(o.jobId), { workspace: `ws_${o.jobId}`, statusPath: "/dev/null" }) };
    // 120 finished jobs touched after the queued ones: a newest-100 window would miss them.
    const queued = ["old", "mid", "new"].map((x, i) => {
      const id = `job_rq${x}${Math.random().toString(36).slice(2, 6)}`;
      hub.store.putItem({ id: `it_${id}`, kind: "idea", status: "doing", title: x, source: { type: "manual" }, createdAt: "", updatedAt: "" });
      mkdirSync(jobDir(id), { recursive: true });
      writeFileSync(`${jobDir(id)}/prompt.md`, "go");
      return { id, kind: "action" as const, name: "work", title: x, surface: "cmux" as const, status: "queued" as const, itemId: `it_${id}`, tail: [], createdAt: `2026-01-01T00:00:0${i}Z` };
    });
    for (const j of [queued[2]!, queued[0]!, queued[1]!]) hub.putJob(j);
    for (let i = 0; i < 120; i++) hub.putJob({ id: `job_done${i}`, kind: "sweep", name: "calendar", title: "c", surface: "headless", status: "done", tail: [], createdAt: "2026-01-02T00:00:00Z" });
    new Agents(hub, deps);
    await settle(() => launched.length >= 2);
    await Bun.sleep(20);
    expect(launched).toEqual([queued[0]!.id, queued[1]!.id]);
  });

  test("a job blocked on the owner gives its slot up", async () => {
    const { hub, items, agents, launched } = setup();
    const jobs = [];
    for (const i of items.slice(0, 3)) jobs.push((await agents.dispatch(i.id, "work"))!);
    await settle(() => launched.length >= 2);
    expect(hub.store.job(jobs[2]!.id)!.status).toBe("queued");
    (agents as unknown as { patch: (id: string, p: object) => void }).patch(jobs[0]!.id, { status: "blocked" });
    await settle(() => launched.length >= 3);
    expect(launched).toEqual(jobs.map((j) => j.id));
  });
});
