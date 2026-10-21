import { expect, setSystemTime, test, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agents, ERROR_GRACE_MS, type CmuxDeps } from "../src/server/agents.ts";
import { jobDir } from "../src/server/cmux.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Item, Job } from "../src/shared/types.ts";

// A running cmux action job (picked up as after a restart). No workspace, so the live-workspace check skips it.
const fakeCmux: CmuxDeps = { available: () => true, launch: () => ({ workspace: "ws", statusPath: "/dev/null" }) };

function setup(id: string) {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: `it_${id}`, kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const job: Job = { id: `job_${id}`, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "running", itemId: item.id, tail: [], createdAt: new Date().toISOString() };
  hub.store.putJob(job);
  const agents = new Agents(hub, fakeCmux);
  const beacon = (b: object) => writeFileSync(resolve(jobDir(job.id), "status.json"), JSON.stringify(b));
  return { hub, item, job, agents, beacon };
}

afterEach(() => setSystemTime());

test("idle+error beacon holds the job for the grace period instead of failing it", () => {
  const { hub, job, agents, beacon } = setup("g1");
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "overloaded" });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("running");
  expect(hub.store.questions("open")).toHaveLength(0);
  setSystemTime(new Date(Date.now() + ERROR_GRACE_MS + 1000));
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.questions("open")[0]?.key).toBe(`after:${job.id}`);
});

test("agent recovers and reports during the grace: job done, no 'Agent stopped' card", () => {
  const { hub, item, job, agents, beacon } = setup("g2");
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "overloaded" });
  agents.pollCmux();
  beacon({ state: "working", seq: 2 });
  agents.pollCmux();
  hub.ingestReport({ jobId: job.id, summary: "Fixed it", status: "done", updates: [{ id: item.id, status: "waiting" }] });
  beacon({ state: "idle", seq: 2, outcome: "completed" });
  agents.pollCmux();
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("done");
  expect(after.error).toBeUndefined();
  expect(hub.store.item(item.id)!.status).toBe("waiting");
});

test("a reported job that ends on an error turn finishes ok straight away", () => {
  const { hub, job, agents, beacon } = setup("g3");
  hub.ingestReport({ jobId: job.id, summary: "Did it", status: "done" });
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "overloaded" });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("done");
});

test("new errored turn restarts the grace", () => {
  const { hub, job, agents, beacon } = setup("g4");
  beacon({ state: "idle", seq: 1, outcome: "error" });
  agents.pollCmux();
  setSystemTime(new Date(Date.now() + ERROR_GRACE_MS - 1000));
  beacon({ state: "idle", seq: 2, outcome: "error" });
  agents.pollCmux();
  setSystemTime(new Date(Date.now() + 5000));
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("running");
});

test("report after the job already failed: done, error cleared, stopped card expired", () => {
  const { hub, job, agents, beacon } = setup("g5");
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "overloaded" });
  agents.pollCmux();
  setSystemTime(new Date(Date.now() + ERROR_GRACE_MS + 1000));
  agents.pollCmux();
  const q = hub.store.questions("open").find((q) => q.key === `after:${job.id}`)!;
  expect(q.badge).toBe("Agent stopped");
  hub.ingestReport({ jobId: job.id, summary: "Recovered", status: "done" });
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("done");
  expect(after.error).toBeUndefined();
  expect(hub.store.question(q.id)!.status).toBe("expired");
  expect(hub.store.question(q.id)!.answer).toBe("agent reported");
});

test("a progress or failed report on a failed job leaves it failed", () => {
  const { hub, job } = setup("g6");
  hub.store.putJob({ ...hub.store.job(job.id)!, status: "failed", error: "boom" });
  hub.ingestReport({ jobId: job.id, status: "progress", summary: "still going" });
  expect(hub.store.job(job.id)!.status).toBe("failed");
  hub.ingestReport({ jobId: job.id, status: "failed", summary: "gave up" });
  expect(hub.store.job(job.id)!.status).toBe("failed");
});
