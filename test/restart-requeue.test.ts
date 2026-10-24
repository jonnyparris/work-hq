import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { claimLaunch, jobDir } from "../src/server/cmux.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Item, Job } from "../src/shared/types.ts";

// A cmux action job the server restarted on while it waited on the launch gate.
function setup(id: string, { savedPrompt = true } = {}) {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: `it_${id}`, kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const job: Job = { id: `job_${id}`, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "queued", itemId: item.id, tail: [], createdAt: new Date().toISOString() };
  hub.store.putJob(job);
  if (savedPrompt) writeFileSync(resolve(jobDir(job.id), "prompt.md"), "do the work");
  return { hub, item, job };
}

const fakeCmux = (ok: boolean, launches: string[] = []): CmuxDeps => ({
  available: () => ok,
  launch: (o) => {
    launches.push(`${o.jobId}:${o.prompt}`);
    return { workspace: `ws_${o.jobId}`, statusPath: "/dev/null" };
  },
});

test("queued cmux job with no workspace goes back on the gate and launches with its saved prompt", async () => {
  const { hub, item, job } = setup("a");
  const launches: string[] = [];
  new Agents(hub, fakeCmux(true, launches));
  for (let i = 0; i < 50 && !launches.length; i++) await Bun.sleep(10);
  expect(launches).toEqual([`${job.id}:do the work`]);
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("running");
  expect(after.workspace).toBe(`ws_${job.id}`);
  expect(hub.store.item(item.id)!.status).toBe("doing");
  expect(hub.store.questions("open")).toHaveLength(0);
});

test("no cmux after the restart: fail the job, hand the item back, ask to send it again", async () => {
  const { hub, item, job } = setup("b");
  new Agents(hub, { ...fakeCmux(false), bootWaitMs: 30, bootRetryMs: 10 });
  expect(hub.store.job(job.id)!.status).toBe("queued"); // still pinging cmux
  for (let i = 0; i < 50 && hub.store.job(job.id)!.status === "queued"; i++) await Bun.sleep(10);
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.item(item.id)!.status).toBe("proposed");
  const [q] = hub.store.questions("open");
  expect(q?.kind).toBe("dispatch");
  expect(q?.itemId).toBe(item.id);
  expect(q?.options[0]?.effect).toEqual({ type: "dispatch", action: "work" });
});

test("job queued before prompts were saved: same hand-back, never a stuck doing", async () => {
  const { hub, item, job } = setup("c", { savedPrompt: false });
  new Agents(hub, fakeCmux(true));
  for (let i = 0; i < 50 && hub.store.job(job.id)!.status === "queued"; i++) await Bun.sleep(10);
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.item(item.id)!.status).toBe("proposed");
  expect(hub.store.questions("open")[0]?.key).toBe(`restart:${job.id}`);
});

test("headless action caught mid-run: fail it and ask where the item stands, never a stuck doing", () => {
  const { hub, item, job } = setup("d");
  hub.store.putJob({ ...job, surface: "headless", status: "running" });
  new Agents(hub, fakeCmux(true));
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("failed");
  expect(after.error).toBe("server restarted mid-run");
  const [q] = hub.store.questions("open");
  expect(q?.key).toBe(`after:${job.id}`);
  expect(q?.itemId).toBe(item.id);
  expect(q?.badge).toBe("Agent stopped");
  expect(q?.context).toBe("server restarted mid-run");
});

test("headless sweep caught mid-run still just fails, no card", () => {
  const hub = new Hub(new Store(":memory:"));
  const job: Job = { id: "job_e", kind: "sweep", name: "calendar", title: "Read the calendar", surface: "headless", status: "running", tail: [], createdAt: new Date().toISOString() };
  hub.store.putJob(job);
  new Agents(hub, fakeCmux(true));
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.questions("open")).toHaveLength(0);
});

test("cmux slow to answer at boot: keep pinging, then launch every queued job in its old order", async () => {
  const a = setup("f");
  const hub = a.hub;
  const item2: Item = { ...a.item, id: "it_g" };
  hub.store.putItem(item2);
  const job2: Job = { ...a.job, id: "job_g", itemId: item2.id, createdAt: new Date(Date.now() + 1000).toISOString() };
  hub.store.putJob(job2);
  writeFileSync(resolve(jobDir(job2.id), "prompt.md"), "do the work");
  let pings = 0;
  const launches: string[] = [];
  // The boot probe uses the non-blocking ping when there is one, not available().
  const agents = new Agents(hub, { ...fakeCmux(false, launches), ping: async () => ++pings >= 3, bootWaitMs: 5_000, bootRetryMs: 10 });
  expect(launches).toEqual([]);
  for (let i = 0; i < 100 && !launches.length; i++) await Bun.sleep(10);
  expect(pings).toBe(3); // one probe shared by both jobs, not one per job
  // Oldest first; the second waits out the launch gate's spacing, back in the queue rather than failed.
  expect(launches).toEqual([`${a.job.id}:do the work`]);
  expect(hub.store.job(job2.id)!.status).toBe("queued");
  expect(hub.store.job(job2.id)!.tail.some((l) => l.includes("queued again"))).toBe(true);
  expect(hub.store.questions("open")).toHaveLength(0);
  agents.cancel(job2.id); // don't leave it polling the launch gate past the test
});

test("no cmux binary configured: fail at once, no minute of pinging", () => {
  const { hub, item, job } = setup("i");
  let pings = 0;
  new Agents(hub, { ...fakeCmux(false), installed: () => false, ping: async () => (pings++, false), bootWaitMs: 60_000 });
  return Bun.sleep(0).then(() => {
    expect(pings).toBe(0);
    expect(hub.store.job(job.id)!.status).toBe("failed");
    expect(hub.store.item(item.id)!.status).toBe("proposed");
  });
});

test("job cancelled while cmux was being pinged at boot stays cancelled", async () => {
  const { hub, job } = setup("h");
  const launches: string[] = [];
  let pings = 0;
  const agents = new Agents(hub, { ...fakeCmux(true, launches), ping: async () => ++pings >= 3, bootWaitMs: 5_000, bootRetryMs: 10 });
  agents.cancel(job.id);
  for (let i = 0; i < 20 && pings < 3; i++) await Bun.sleep(10);
  await Bun.sleep(20);
  expect(launches).toEqual([]);
  expect(hub.store.job(job.id)!.error).toBe("cancelled");
  expect(hub.store.questions("open")).toHaveLength(0);
});

test("old session claims the job while cmux is down at boot: adopt it without cmux lookups, don't fail it or launch a second", async () => {
  const { hub, item, job } = setup("j");
  const launches: string[] = [];
  let pings = 0;
  const found: string[] = [];
  new Agents(hub, {
    ...fakeCmux(false, launches),
    ping: async () => {
      if (++pings === 2) claimLaunch(job.id, "cmux"); // the pre-restart launch.sh gets there mid-probe
      return false;
    },
    findWorkspace: (id) => (found.push(id), undefined),
    bootWaitMs: 40,
    bootRetryMs: 10,
  });
  for (let i = 0; i < 100 && hub.store.job(job.id)!.status === "queued"; i++) await Bun.sleep(10);
  expect(launches).toEqual([]);
  expect(hub.store.job(job.id)!.status).toBe("running");
  expect(hub.store.job(job.id)!.tail.some((l) => l.includes("tracking it"))).toBe(true);
  expect(found).toEqual([]); // cmux isn't answering: no blocking `cmux tree`
  expect(hub.store.job(job.id)!.tail.at(-1)).toContain("cmux didn't answer at boot");
  expect(hub.store.item(item.id)!.status).toBe("doing");
  expect(hub.store.questions("open")).toHaveLength(0);
});

test("boot doesn't look up cmux workspaces before the probe answers", async () => {
  const { hub, job } = setup("k");
  const found: string[] = [];
  let answer = false;
  new Agents(hub, { ...fakeCmux(true), ping: async () => answer, findWorkspace: (id) => (found.push(id), undefined), bootWaitMs: 5_000, bootRetryMs: 10 });
  await Bun.sleep(30);
  expect(found).toEqual([]); // no `cmux tree` while cmux isn't answering
  answer = true;
  for (let i = 0; i < 100 && !found.length; i++) await Bun.sleep(10);
  expect(found).toEqual([job.id]);
});

test("boot probe keeps pinging for its whole window before it gives up", async () => {
  const { hub, job } = setup("l");
  const at: number[] = [];
  const t0 = Date.now();
  new Agents(hub, { ...fakeCmux(false), ping: async () => (at.push(Date.now() - t0), false), bootWaitMs: 100, bootRetryMs: 30 });
  for (let i = 0; i < 100 && hub.store.job(job.id)!.status === "queued"; i++) await Bun.sleep(10);
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  expect(at.at(-1)!).toBeGreaterThanOrEqual(95); // a last ping at the deadline, not one interval early
  expect(at.length).toBeGreaterThanOrEqual(4);
});
