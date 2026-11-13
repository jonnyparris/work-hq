import { afterEach, expect, setSystemTime, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agents, WORKSPACE_GONE_MIN_MS, WORKSPACE_GONE_SPAN_MS, type CmuxDeps } from "../src/server/agents.ts";
import { jobDir } from "../src/server/cmux.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Item, Job } from "../src/shared/types.ts";

// 11-09: job_mw9g8jfbhh74g got "workspace closed" 0.18 s after launch: the first `cmux tree` after a launch can miss
// the new workspace. One missing snapshot, a short run of them, or misses in the first minute aren't proof it closed.
function setup(id: string, ageMs: number, extra: Partial<Job> = {}, beacon = true) {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: `it_${id}`, kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const at = new Date(Date.now() - ageMs).toISOString();
  const job: Job = { id: `job_wc_${id}`, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "running", itemId: item.id, tail: [], createdAt: at, startedAt: at, workspace: "ws-1", ...extra };
  hub.store.putJob(job);
  let live: Set<string> | undefined = new Set();
  const deps: CmuxDeps = { available: () => true, launch: () => undefined, liveWorkspaces: () => live };
  const agents = new Agents(hub, deps);
  const status = resolve(jobDir(job.id), "status.json");
  writeFileSync(status, beacon ? JSON.stringify({ state: "working", seq: 1 }) : "");
  const setLive = (s: Set<string> | undefined) => (live = s);
  const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));
  return { hub, job, agents, setLive, later };
}

afterEach(() => setSystemTime());

const OLD = 10 * 60_000;
const status = (hub: Hub, id: string) => hub.store.job(id)!.status;

test("missing on the first snapshot right after launch: still running", () => {
  const { hub, job, agents } = setup("first", 200);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("running");
  expect(hub.store.questions("open")).toHaveLength(0);
});

test("missing past the span but inside the first minute: still running, finished once the minute is up", () => {
  const { hub, job, agents, later } = setup("young", 1_000);
  agents.pollCmux();
  later(WORKSPACE_GONE_SPAN_MS);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("running");
  later(WORKSPACE_GONE_MIN_MS);
  agents.pollCmux();
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("failed");
  expect(after.error).toBe("workspace closed");
  expect(hub.store.questions("open")[0]?.key).toBe(`after:${job.id}`);
});

test("an old job: two misses 3 s apart aren't enough, missing for the whole span finishes it", () => {
  const { hub, job, agents, later } = setup("old", OLD);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("running");
  later(3_000);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("running");
  later(WORKSPACE_GONE_SPAN_MS - 3_000);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("failed");
});

test("an old job, one missing snapshot: still running", () => {
  const { hub, job, agents } = setup("single", OLD);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("running");
});

test("listed again between misses: the count and span start over", () => {
  const { hub, job, agents, setLive, later } = setup("blip", OLD);
  agents.pollCmux();
  later(WORKSPACE_GONE_SPAN_MS);
  setLive(new Set(["ws-1"]));
  agents.pollCmux();
  setLive(new Set());
  later(3_000);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("running");
  later(WORKSPACE_GONE_SPAN_MS);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("failed");
});

test("listed by its ref: still running", () => {
  const { hub, job, agents, setLive, later } = setup("ref", OLD, { workspace: "workspace:7" });
  setLive(new Set(["uuid-7", "workspace:7"]));
  agents.pollCmux();
  later(WORKSPACE_GONE_SPAN_MS);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("running");
});

test("cmux can't list between misses: not counted, not reset", () => {
  const { hub, job, agents, setLive, later } = setup("nolist", OLD);
  agents.pollCmux();
  setLive(undefined);
  later(WORKSPACE_GONE_SPAN_MS);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("running");
  setLive(new Set());
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("failed");
});

test("no beacon yet and the workspace is gone: same rule", () => {
  const { hub, job, agents, later } = setup("nobeacon", OLD, {}, false);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("running");
  later(WORKSPACE_GONE_SPAN_MS);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("failed");
});

test("unparseable startedAt: the minute counts from the first miss, not from 1970", () => {
  const { hub, job, agents, later } = setup("badstart", OLD, { startedAt: "garbage" });
  agents.pollCmux();
  later(WORKSPACE_GONE_SPAN_MS);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("running");
  later(WORKSPACE_GONE_MIN_MS - WORKSPACE_GONE_SPAN_MS);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("failed");
});

test("no startedAt: the minute counts from createdAt", () => {
  const { hub, job, agents, later } = setup("nostart", OLD, { startedAt: undefined });
  agents.pollCmux();
  later(WORKSPACE_GONE_SPAN_MS);
  agents.pollCmux();
  expect(status(hub, job.id)).toBe("failed");
});

test("already reported and the workspace is gone: done, not failed", () => {
  const { hub, job, agents, later } = setup("reported", OLD);
  hub.ingestReport({ jobId: job.id, summary: "Did it", status: "done" });
  agents.pollCmux();
  later(WORKSPACE_GONE_SPAN_MS);
  agents.pollCmux();
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("done");
  expect(after.error).toBeUndefined();
});
