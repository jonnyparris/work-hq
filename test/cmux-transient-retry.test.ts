import { afterEach, expect, setSystemTime, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agents, ERROR_GRACE_MS, TRANSIENT_RETRY_MS, type CmuxDeps } from "../src/server/agents.ts";
import { jobDir } from "../src/server/cmux.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { isTransient } from "../src/server/launch-gate.ts";
import type { Item, Job } from "../src/shared/types.ts";

// A running cmux action job with a workspace, picked up as after a restart. CMUX_BIN is /usr/bin/false in tests,
// so the live-workspace check reads "unknown" and skips; `send` records the nudges instead of typing into cmux.
function setup(id: string, sendOk = true) {
  const sent: Array<{ ws: string; text: string }> = [];
  const deps: CmuxDeps = {
    available: () => true,
    launch: () => ({ workspace: "ws", statusPath: "/dev/null" }),
    send: (ws, text) => (sent.push({ ws, text }), sendOk),
  };
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: `it_${id}`, kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const job: Job = { id: `job_${id}`, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "running", itemId: item.id, workspace: `ws_${id}`, tail: [], createdAt: new Date().toISOString() };
  hub.store.putJob(job);
  const agents = new Agents(hub, deps);
  const beacon = (b: object) => writeFileSync(resolve(jobDir(job.id), "status.json"), JSON.stringify(b));
  const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));
  return { hub, item, job, agents, beacon, sent, later, deps };
}

afterEach(() => setSystemTime());

test("isTransient: pi's timeout and connection errors, not rate limits or auth", () => {
  for (const t of ["Request timed out.", "Connection error.", "terminated", "Anthropic stream ended before message_stop", "fetch failed", "read ECONNRESET"]) {
    expect(isTransient(t)).toBe(true);
  }
  for (const t of [undefined, "", "overloaded", "429 Too Many Requests", "API key auth failed for provider x: connection error", "invalid_request_error", "aborted"]) {
    expect(isTransient(t)).toBe(false);
  }
});

test("a turn that ends on 'Request timed out.' is nudged once after 60 s; a clean retried turn finishes the job", () => {
  const { hub, job, agents, beacon, sent, later } = setup("t1");
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "Request timed out." });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("running");
  expect(sent).toHaveLength(0);
  later(TRANSIENT_RETRY_MS - 5_000);
  agents.pollCmux();
  expect(sent).toHaveLength(0);
  later(10_000);
  agents.pollCmux();
  expect(sent).toEqual([{ ws: job.workspace!, text: expect.stringContaining("network error") }]);
  expect(hub.store.job(job.id)!.nudges).toEqual({ transient: 1, transientSeq: 1 });
  beacon({ state: "working", seq: 2 });
  agents.pollCmux();
  hub.ingestReport({ jobId: job.id, summary: "Fixed it", status: "done" });
  beacon({ state: "idle", seq: 2, outcome: "completed" });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("done");
  expect(sent).toHaveLength(1);
});

test("the retried turn blips too: the job fails at once, says so, and isn't nudged again", () => {
  const { hub, job, agents, beacon, sent, later } = setup("t2");
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "Connection error." });
  agents.pollCmux();
  later(TRANSIENT_RETRY_MS + 1_000);
  agents.pollCmux();
  beacon({ state: "working", seq: 2 });
  agents.pollCmux();
  beacon({ state: "idle", seq: 2, outcome: "error", detail: "Connection error." });
  agents.pollCmux();
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("failed");
  expect(after.error).toBe("Connection error. (again after one retry)");
  expect(sent).toHaveLength(1);
  expect(hub.store.questions("open")[0]?.badge).toBe("Agent stopped");
});

test("the agent reports before the retry is due: no nudge, job done", () => {
  const { hub, job, agents, beacon, sent, later } = setup("t3");
  hub.ingestReport({ jobId: job.id, summary: "Did it", status: "done" });
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "Request timed out." });
  agents.pollCmux();
  later(TRANSIENT_RETRY_MS + 1_000);
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("done");
  expect(sent).toHaveLength(0);
});

test("the owner types first (new turn before 60 s): the pending retry is dropped", () => {
  const { hub, job, agents, beacon, sent, later } = setup("t4");
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "Request timed out." });
  agents.pollCmux();
  beacon({ state: "working", seq: 2 });
  agents.pollCmux();
  later(TRANSIENT_RETRY_MS + 1_000);
  beacon({ state: "idle", seq: 2, outcome: "completed" });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("done");
  expect(sent).toHaveLength(0);
});

test("the nudge can't be typed: the job fails with the error, not a silent wait", () => {
  const { hub, job, agents, beacon, later } = setup("t5", false);
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "Request timed out." });
  agents.pollCmux();
  later(TRANSIENT_RETRY_MS + 1_000);
  agents.pollCmux();
  expect(hub.store.job(job.id)!.error).toBe("Request timed out. (couldn't nudge the session)");
});

test("a non-transient model error still gets the recovery grace, no nudge", () => {
  const { hub, job, agents, beacon, sent, later } = setup("t6");
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "invalid_request_error: prompt too long" });
  agents.pollCmux();
  later(TRANSIENT_RETRY_MS + 1_000);
  agents.pollCmux();
  expect(sent).toHaveLength(0);
  expect(hub.store.job(job.id)!.status).toBe("running");
  later(ERROR_GRACE_MS);
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("failed");
});

test("the owner's turn beats the nudge and then blips: it gets its own retry", () => {
  const { hub, job, agents, beacon, sent, later } = setup("t7");
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "Request timed out." });
  agents.pollCmux();
  beacon({ state: "working", seq: 2 });
  agents.pollCmux();
  beacon({ state: "idle", seq: 2, outcome: "error", detail: "Connection error." });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("running");
  later(TRANSIENT_RETRY_MS + 1_000);
  agents.pollCmux();
  expect(sent).toHaveLength(1);
});

test("after a restart, a job that already used its nudge fails on the next blip", () => {
  const { hub, job, beacon, sent, deps } = setup("t8");
  hub.store.putJob({ ...hub.store.job(job.id)!, nudges: { transient: 1, transientSeq: 2 } });
  beacon({ state: "idle", seq: 3, outcome: "error", detail: "Request timed out." });
  const agents = new Agents(hub, deps); // the restart: a fresh Agents picks up the running job
  agents.pollCmux();
  expect(hub.store.job(job.id)!.error).toBe("Request timed out. (again after one retry)");
  expect(sent).toHaveLength(0);
});

test("the nudge is typed but no turn starts: fails after 2 min", () => {
  const { hub, job, agents, beacon, sent, later } = setup("t9");
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "Request timed out." });
  agents.pollCmux();
  later(TRANSIENT_RETRY_MS + 1_000);
  agents.pollCmux();
  expect(sent).toHaveLength(1);
  later(121_000);
  agents.pollCmux();
  expect(hub.store.job(job.id)!.error).toBe("Request timed out. (nudge didn't start a new turn)");
});

test("a restart between the nudge and its turn waits for that turn instead of failing it as a second blip", () => {
  const { hub, job, beacon, sent, deps } = setup("t10");
  hub.store.putJob({ ...hub.store.job(job.id)!, nudges: { transient: 1, transientSeq: 1 } });
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "Request timed out." });
  const agents = new Agents(hub, deps);
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("running");
  beacon({ state: "working", seq: 2 });
  agents.pollCmux();
  beacon({ state: "idle", seq: 2, outcome: "completed" });
  agents.pollCmux();
  expect(hub.store.job(job.id)!.status).toBe("done");
  expect(sent).toHaveLength(0);
});

test("a restart between the nudge and its turn, and no turn comes: fails as a nudge that didn't take", () => {
  const { hub, job, beacon, sent, later, deps } = setup("t11");
  hub.store.putJob({ ...hub.store.job(job.id)!, nudges: { transient: 1, transientSeq: 1 } });
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "Request timed out." });
  const agents = new Agents(hub, deps);
  agents.pollCmux();
  later(121_000);
  agents.pollCmux();
  expect(hub.store.job(job.id)!.error).toBe("Request timed out. (nudge didn't start a new turn)");
  expect(sent).toHaveLength(0);
});
