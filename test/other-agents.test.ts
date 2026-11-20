import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { config } from "../src/server/config.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { type HookRecord, OtherAgents, parseEtime, processStarts, readHookRecords, runningRecords, STALE_MS, workingSurfaces } from "../src/server/other-agents.ts";
import type { Item } from "../src/shared/types.ts";

const now = Date.parse("2026-11-20T08:00:00Z");
const sec = (msAgo: number) => (now - msAgo) / 1000;
const rec = (pid: number, surfaceId: string, agentLifecycle: string, msAgo = 1000, workspaceId = `ws_${surfaceId}`): HookRecord => ({
  pid, surfaceId, workspaceId, agentLifecycle, updatedAt: sec(msAgo),
});

describe("other agents from cmux hook records", () => {
  const live = new Set([1, 2, 3, 4, 5, 6]);
  // Every live pid started an hour ago; records carry no pidStartSeconds unless a test sets it.
  const starts = (pids: number[]) => new Map(pids.filter((p) => live.has(p)).map((p) => [p, now / 1000 - 3600]));
  const count = (records: HookRecord[], exclude = new Set<string>()) => {
    const running = runningRecords(records, exclude, now);
    return [...workingSurfaces(running, starts(running.map((r) => r.pid!)))].sort();
  };

  test("counts surfaces mid-turn, once each: a session's subagents share its surface", () => {
    expect(count([rec(1, "A", "running"), rec(2, "A", "running"), rec(3, "B", "running"), rec(4, "C", "idle"), rec(5, "D", "needsInput")])).toEqual(["A", "B"]);
  });

  test("a pid's newest record decides: running then Stop is idle", () => {
    expect(count([rec(1, "A", "running", 5000), rec(1, "A", "idle", 1000)])).toEqual([]);
  });

  test("skips Work HQ's own workspaces, dead pids and running records older than STALE_MS", () => {
    const records = [rec(1, "A", "running", 1000, "ws_whq"), rec(99, "B", "running"), rec(2, "C", "running", STALE_MS + 1000), rec(3, "D", "running")];
    expect(count(records, new Set(["ws_whq"]))).toEqual(["D"]);
  });

  test("a turn an hour in still counts: cmux doesn't update the record mid-turn", () => {
    expect(count([rec(1, "A", "running", 60 * 60_000)])).toEqual(["A"]);
  });

  test("a reused pid (process started after the record's own start) doesn't count", () => {
    const same = { ...rec(1, "A", "running"), pidStartSeconds: now / 1000 - 3602 };
    const reused = { ...rec(2, "B", "running"), pidStartSeconds: now / 1000 - 7200 };
    expect(count([same, reused])).toEqual(["A"]);
  });

  test("with ps failed (start NaN) or no recorded start, liveness alone decides", () => {
    const r = [{ ...rec(1, "A", "running"), pidStartSeconds: now / 1000 - 7200 }, rec(2, "B", "running")];
    expect([...workingSurfaces(r, new Map([[1, Number.NaN], [2, Number.NaN]]))].sort()).toEqual(["A", "B"]);
    expect([...workingSurfaces(r, new Map())]).toEqual([]);
  });

  test("a subagent still running counts its surface after the parent's turn ended", () => {
    expect(count([rec(1, "A", "idle", 1000), rec(2, "A", "running", 60_000)])).toEqual(["A"]);
  });

  test("parseEtime reads every ps etime form", () => {
    expect(parseEtime("00:07")).toBe(7);
    expect(parseEtime("58:28")).toBe(58 * 60 + 28);
    expect(parseEtime("16:18:56")).toBe(16 * 3600 + 18 * 60 + 56);
    expect(parseEtime("03-21:52:18")).toBe(3 * 86400 + 21 * 3600 + 52 * 60 + 18);
    expect(parseEtime("junk")).toBeUndefined();
  });

  test("processStarts reads a child's start from ps, skipping dead and impossible pids", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const before = Date.now() / 1000;
    const child = Bun.spawn(["sleep", "30"]);
    try {
      await Bun.sleep(2100);
      const m = await processStarts([child.pid, dead.pid, 100_000, -1]);
      const at = m?.get(child.pid);
      expect(at).toBeDefined();
      // ps rounds etime to the second: the start lands within a couple of seconds of the spawn.
      expect(Math.abs((at ?? 0) - before)).toBeLessThanOrEqual(2.5);
      expect(m?.has(dead.pid)).toBe(false);
      expect(await processStarts([dead.pid])).toEqual(new Map()); // none running: ps exits 1, still an answer
      // The clock is read when ps answers, not when it was asked: a stale caller clock can't shift the start.
      let clock = 0; // 1970 until ps is running, then a clock 1000 s ahead: the start must come from the later one
      const asked = processStarts([child.pid], () => clock);
      clock = Date.now() + 1_000_000;
      const late = await asked;
      expect(Math.abs((late?.get(child.pid) ?? 0) - (before + 1000))).toBeLessThanOrEqual(2.5);
    } finally {
      child.kill();
    }
  });

  test("reads every <agent>-hook-sessions.json in the dir, skipping broken files and junk records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "whq-hooks-"));
    writeFileSync(join(dir, "pi-hook-sessions.json"), JSON.stringify({ version: 1, sessions: { a: rec(1, "A", "running"), b: rec(2, "B", "idle") } }));
    writeFileSync(join(dir, "opencode-hook-sessions.json"), JSON.stringify({ sessions: { c: { ...rec(3, "C", "running"), pidStartSeconds: null } } }));
    writeFileSync(join(dir, "claude-hook-sessions.json"), "{ half a file");
    writeFileSync(join(dir, "other.json"), JSON.stringify({ sessions: { d: rec(4, "D", "running") } }));
    writeFileSync(join(dir, "codex-hook-sessions.json"), JSON.stringify({ sessions: { e: { ...rec(5, "E", "running"), updatedAt: "soon" }, f: null } }));
    const records = await readHookRecords(dir);
    expect(records.map((r) => r.surfaceId).sort()).toEqual(["A", "B", "C"]);
    expect(records.find((r) => r.surfaceId === "C")?.pidStartSeconds).toBeUndefined(); // junk start = not recorded
    expect(await readHookRecords(join(dir, "missing"))).toEqual([]);
  });

  describe("OtherAgents", () => {
    const setup = (state = "running", pid = 4242) => {
      const dir = mkdtempSync(join(tmpdir(), "whq-hooks-"));
      const file = join(dir, "pi-hook-sessions.json");
      let bump = 0;
      const write = (st: string, p = pid) => {
        writeFileSync(file, JSON.stringify({ sessions: { a: { pid: p, pidStartSeconds: 100, surfaceId: "A", workspaceId: "W", agentLifecycle: st, updatedAt: Date.now() / 1000 } } }));
        const t = new Date(Date.now() + ++bump * 1000); // an mtime that surely moved, whatever the fs resolution
        utimesSync(file, t, t);
      };
      write(state);
      return { dir, write };
    };
    const fakePs = (calls: { n: number }) => async (pids: number[]) => (calls.n++, new Map(pids.map((p) => [p, 100])));

    test("working() never waits: undefined before the first count, then the last count, refreshed past the ttl", async () => {
      const { dir, write } = setup();
      const calls = { n: 0 };
      const o = new OtherAgents(() => new Set(), dir, 10_000, fakePs(calls));
      let changes = 0;
      o.onChange = () => changes++;
      const t = Date.now();
      expect(o.working(t)).toBeUndefined(); // first refresh still running
      expect(await o.refresh(t)).toBe(1);
      expect(changes).toBe(1);
      expect(o.working(t + 5_000)).toBe(1); // fresh: no new refresh
      expect(calls.n).toBe(1);
      write("idle");
      expect(o.working(t + 11_000)).toBe(1); // stale: kicks a refresh, answers with the last count
      expect(o.working(t + 11_001)).toBe(1); // …and one at a time
      expect(await o.refresh()).toBe(0);
      expect(changes).toBe(2);
      expect(await new OtherAgents(() => new Set(["W"]), dir, 0, fakePs(calls)).refresh()).toBe(0);
    });

    test("a refresh that throws keeps the last count and doesn't wedge the next one", async () => {
      // An empty dir first: no file to read, so the throw comes before any await (the case that wedged).
      const dir = mkdtempSync(join(tmpdir(), "whq-hooks-"));
      const fresh = (pid: number) => ({ pid, pidStartSeconds: 100, surfaceId: `S${pid}`, workspaceId: "W", agentLifecycle: "running", updatedAt: Date.now() / 1000 });
      const file = join(dir, "pi-hook-sessions.json");
      let fail = true;
      const o = new OtherAgents(() => {
        if (fail) throw new Error("store down");
        return new Set();
      }, dir, 0, fakePs({ n: 0 }));
      expect(await o.refresh()).toBeUndefined(); // threw before any await; not wedged:
      fail = false;
      writeFileSync(file, JSON.stringify({ sessions: { a: fresh(1) } }));
      expect(await o.refresh()).toBe(1);
      fail = true;
      writeFileSync(file, JSON.stringify({ sessions: { a: fresh(1), b: fresh(2) } }));
      utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
      expect(await o.refresh()).toBe(1); // the last count, kept
      fail = false;
      expect(await o.refresh()).toBe(2);
    });

    test("a refresh that never settles is given up, keeps the last count, and can't overwrite a newer one", async () => {
      const { dir } = setup(); // one running record (pid 4242)
      let release: ((m: Map<number, number>) => void) | undefined;
      let hang = false;
      let excluded = true;
      const o = new OtherAgents(() => new Set(excluded ? ["W"] : []), dir, 0, (pids) =>
        hang ? new Promise((r) => (release = r)) : fakePs({ n: 0 })(pids),
      );
      let changes = 0;
      o.onChange = () => changes++;
      expect(await o.refresh()).toBe(0); // primed at 0 (the record's workspace excluded); records now cached
      excluded = false;
      hang = true; // this refresh sees the record (would be 1) and hangs in ps
      const prev = setTimeout;
      (globalThis as any).setTimeout = (fn: () => void) => prev(fn, 5); // time out almost at once
      try {
        expect(await o.refresh()).toBe(0); // given up: the last count
      } finally {
        (globalThis as any).setTimeout = prev;
      }
      expect(release).toBeDefined(); // it really reached ps
      hang = false;
      excluded = true;
      expect(await o.refresh()).toBe(0); // a newer refresh, still 0
      const before = changes;
      release!(new Map([[4242, 100]])); // the abandoned one lands late with 1
      await Bun.sleep(5);
      expect(o.working(Date.now() - 1e9)).toBe(0); // (an old `now`: no new refresh) the newer count stands
      expect(changes).toBe(before); // and it pumped nothing
    });

    test("ps failing falls back to liveness, never for an impossible pid (kill(-1) is every process)", async () => {
      expect(await new OtherAgents(() => new Set(), setup("running", -1).dir, 0, async () => undefined).refresh()).toBe(0);
      const { dir } = setup("running", process.pid);
      expect(await new OtherAgents(() => new Set(), dir, 0, async () => undefined).refresh()).toBe(1);
      const gone = setup("running", 4242);
      expect(await new OtherAgents(() => new Set(), gone.dir, 0, async () => undefined).refresh()).toBe(0);
    });
  });
});

describe("Agents with pi.maxAgents", () => {
  const prev = { ...config.pi };
  beforeEach(() => {
    config.pi.maxAgents = 4;
    config.pi.minRunningJobs = 1;
    config.pi.maxRunningJobs = 10;
    config.pi.launchSpacingSec = 0;
  });
  afterEach(() => Object.assign(config.pi, prev));

  function setup(others: { n: number | undefined }) {
    const launched: string[] = [];
    const deps: CmuxDeps = { available: () => true, launch: (o) => (launched.push(o.jobId), { workspace: `ws_${o.jobId}`, statusPath: "/dev/null" }) };
    const hub = new Hub(new Store(":memory:"));
    const items = ["a", "b", "c", "d", "e"].map((x): Item => ({ id: `it_tot${x}`, kind: "idea", status: "proposed", title: `Thing ${x}`, source: { type: "manual" }, createdAt: "", updatedAt: "" }));
    for (const i of items) hub.store.putItem(i);
    const agents = new Agents(hub, deps);
    agents.otherAgents = { working: () => others.n };
    return { hub, items, agents, launched };
  }
  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 200 && !until(); i++) await Bun.sleep(5);
  };

  test("jobCap: the budget less other agents, floored at minRunningJobs, capped at maxRunningJobs", () => {
    const others: { n: number | undefined } = { n: undefined };
    const { agents: booting } = setup(others);
    expect(booting.jobCap()).toBe(1); // not counted yet: the floor
    config.pi.minRunningJobs = 3;
    config.pi.maxRunningJobs = 2;
    expect(booting.jobCap()).toBe(2); // …still under the ceiling
    config.pi.minRunningJobs = 1;
    config.pi.maxRunningJobs = 10;
    others.n = 0;
    const { agents } = setup(others);
    expect(agents.jobCap()).toBe(4);
    others.n = 3;
    expect(agents.jobCap()).toBe(1);
    others.n = 9;
    expect(agents.jobCap()).toBe(1); // the floor: the queue never stalls
    others.n = 0;
    config.pi.maxRunningJobs = 3;
    expect(agents.jobCap()).toBe(3);
    config.pi.maxRunningJobs = 10;
    others.n = 9;
    config.pi.minRunningJobs = 0; // never 0 slots: RunCap reads 0 as "no cap"
    expect(agents.jobCap()).toBe(1);
    config.pi.minRunningJobs = Number.NaN;
    expect(agents.jobCap()).toBe(1);
    config.pi.maxAgents = Number.NaN; // a typo'd env value: off, not "no cap"
    expect(agents.jobCap()).toBe(10);
    config.pi.maxAgents = 4;
    config.pi.maxRunningJobs = 3;
    others.n = 0;
    config.pi.maxAgents = 0; // off: the old fixed cap
    others.n = 9;
    expect(agents.jobCap()).toBe(3);
  });

  test("the real OtherAgents pumps the queue when its count changes: a held job launches with no other pump", async () => {
    const dir = process.env.WORK_HQ_CMUX_HOOKS_DIR!;
    const file = join(dir, "pi-hook-sessions.json");
    const live = (n: number) => {
      // n other sessions mid-turn, all this test process (alive, start = its own), on n surfaces
      const sessions = Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`s${i}`, { pid: process.pid, pidStartSeconds: Math.floor(performance.timeOrigin / 1000), surfaceId: `X${i}`, workspaceId: `WX${i}`, agentLifecycle: "running", updatedAt: Date.now() / 1000 + i }]),
      );
      writeFileSync(file, JSON.stringify({ sessions }));
      const t = new Date(Date.now() + n * 1000 + 10_000);
      utimesSync(file, t, t);
    };
    const launched: string[] = [];
    const hub = new Hub(new Store(":memory:"));
    const items = ["p", "q"].map((x): Item => ({ id: `it_wire${x}`, kind: "idea", status: "proposed", title: `Wire ${x}`, source: { type: "manual" }, createdAt: "", updatedAt: "" }));
    for (const i of items) hub.store.putItem(i);
    const agents = new Agents(hub, { available: () => true, launch: (o) => (launched.push(o.jobId), { workspace: `ws_${o.jobId}`, statusPath: "/dev/null" }) });
    const other = agents.otherAgents as OtherAgents;
    expect(other).toBeInstanceOf(OtherAgents);
    config.pi.maxAgents = 2;
    try {
      // One pid, one record per surface: only the newest counts per pid, so a single surface is "working".
      live(1);
      await other.refresh();
      expect(other.working(Date.now() - 1e9)).toBe(1);
      const a = (await agents.dispatch(items[0]!.id, "work"))!;
      await settle(() => launched.length >= 1);
      const b = (await agents.dispatch(items[1]!.id, "work"))!;
      await Bun.sleep(30);
      expect(launched).toEqual([a.id]); // 2 − 1 other = 1 slot, ours
      writeFileSync(file, JSON.stringify({ sessions: {} }));
      utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      await other.refresh(); // count 1 → 0: onChange pumps, no manual cap.pump()
      await settle(() => launched.length >= 2);
      expect(launched).toEqual([a.id, b.id]);
      agents.cancel(a.id);
      agents.cancel(b.id);
    } finally {
      writeFileSync(file, JSON.stringify({ sessions: {} }));
    }
  });

  test("other agents finishing frees slots for queued jobs on the next pump", async () => {
    const others = { n: 2 };
    const { hub, items, agents, launched } = setup(others);
    const jobs = [];
    for (const i of items) jobs.push((await agents.dispatch(i.id, "work"))!);
    await settle(() => launched.length >= 2);
    await Bun.sleep(20);
    expect(launched).toHaveLength(2);
    expect(hub.store.job(jobs[2]!.id)!.tail.join("\n")).toContain("2 of ours running or starting (cap 2, 2 other agents working (pi.maxAgents 4))");

    others.n = 0; // the owner's own sessions went quiet: Work HQ gets the whole budget
    agents.cap.pump(); // the scheduler's 15 s load-gate timer
    await settle(() => launched.length >= 4);
    expect(launched).toHaveLength(4);
    expect(hub.store.job(jobs[4]!.id)!.status).toBe("queued");
    for (const j of jobs) agents.cancel(j.id);
  });
});
