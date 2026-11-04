import { afterEach, expect, setSystemTime, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agents, NO_BEACON_ERROR, NO_BEACON_MS, type CmuxDeps } from "../src/server/agents.ts";
import { jobDir } from "../src/server/cmux.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Item, Job } from "../src/shared/types.ts";

// A running cmux action job picked up after a restart (the constructor tracks it), started `ageMs` ago.
const fakeCmux: CmuxDeps = { available: () => true, launch: () => ({ workspace: "ws", statusPath: "/dev/null" }) };

function setup(id: string, ageMs: number, extra: Partial<Job> = {}, deps: Partial<CmuxDeps> = {}) {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: `it_${id}`, kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const at = new Date(Date.now() - ageMs).toISOString();
  const job: Job = { id: `job_nb_${id}`, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "running", itemId: item.id, tail: [], createdAt: at, startedAt: at, ...extra };
  hub.store.putJob(job);
  const agents = new Agents(hub, { ...fakeCmux, ...deps });
  const beacon = (b: object) => writeFileSync(resolve(jobDir(job.id), "status.json"), JSON.stringify(b));
  return { hub, job, agents, beacon };
}

afterEach(() => setSystemTime());

test("no workspace, no beacon, 31 min after start: failed, with a stopped card", () => {
  const { hub, job, agents } = setup("old", 31 * 60_000);
  agents.pollCmux();
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("failed");
  expect(after.error).toBe(NO_BEACON_ERROR);
  expect(hub.store.questions("open")[0]?.key).toBe(`after:${job.id}`);
});

test("no workspace, no beacon, but still young: left running until the limit passes", () => {
  const { hub, job, agents } = setup("young", NO_BEACON_MS - 60_000);
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("running");
  setSystemTime(new Date(Date.now() + 2 * 60_000));
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("failed");
});

test("no workspace but a beacon: the beacon rules, not the age", () => {
  const { hub, job, agents, beacon } = setup("beacon", 2 * NO_BEACON_MS);
  beacon({ state: "working", seq: 1 });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("running");
});

test("a known workspace without a beacon is left to the live-workspace check", () => {
  // cmux answers nothing in tests (CMUX_BIN=/usr/bin/false), so the live check can't close it either.
  const { hub, job, agents } = setup("ws", 2 * NO_BEACON_MS, { workspace: "ws-1" });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("running");
});

test("a job that already reported finishes done, not failed", () => {
  const { hub, job, agents } = setup("reported", 31 * 60_000);
  hub.ingestReport({ jobId: job.id, summary: "Did it", status: "done" });
  agents.pollCmux();
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("done");
  expect(after.error).toBeUndefined();
});

test("past the limit but its workspace turns up on a last look: tracked, not failed", () => {
  const { hub, job, agents } = setup("found", 31 * 60_000, {}, { findWorkspace: () => "ws-found" });
  agents.pollCmux();
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("running");
  expect(after.workspace).toBe("ws-found");
});

test("cmux can't list workspaces: absence isn't proven, so the job keeps running", () => {
  const { hub, job, agents } = setup("nolist", 31 * 60_000, {}, { findWorkspace: () => false });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("running");
});

test("cmux still can't list a whole limit later: failed anyway", () => {
  const { hub, job, agents } = setup("nolist-long", 2 * NO_BEACON_MS + 60_000, {}, { findWorkspace: () => false });
  agents.pollCmux();
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("failed");
  expect(after.error).toContain("cmux couldn't list workspaces");
  expect(hub.store.questions("open")[0]?.key).toBe(`after:${job.id}`);
});

test("a beacon written while the last look runs keeps the job running", () => {
  let write = () => {};
  const { hub, job, agents, beacon } = setup("racing", 31 * 60_000, {}, { findWorkspace: () => (write(), undefined) });
  write = () => beacon({ state: "working", seq: 1 });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("running");
});

test("no startedAt: the limit counts from createdAt", () => {
  const { hub, job, agents } = setup("created", 31 * 60_000, { startedAt: undefined });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("failed");
});
