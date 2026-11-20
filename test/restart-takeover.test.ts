import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Item, Job } from "../src/shared/types.ts";

// 11-19: a forced restart (25 min hold, restart.ts) killed two long headless jobs at 01:56. Nothing re-sent them until
// the owner tapped "Send all 2 again" at 08:17. Now the first restart to kill a headless action job sends one fresh
// agent to take over; a restart that kills the takeover asks the owner, as before.

let n = 0;
function setup(o: Partial<Job> = {}, itemStatus: Item["status"] = "doing") {
  const hub = new Hub(new Store(":memory:"));
  const id = `rt${++n}`;
  const item: Item = { id: `it_${id}`, kind: "idea", status: itemStatus, title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const job: Job = {
    id: `job_${id}`, kind: "action", name: "work", title: "Work · Fix the thing", surface: "headless", status: "running", itemId: item.id,
    decision: "Fix it? → Do it", note: "use the small fix", tail: [], createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), ...o,
  };
  hub.store.putJob(job);
  return { hub, item, job };
}

const fakeCmux = (launches: string[]): CmuxDeps => ({
  available: () => true,
  launch: (o) => {
    launches.push(o.prompt);
    return { workspace: `ws_${o.jobId}`, statusPath: "/dev/null" };
  },
});

const actionJobs = (hub: Hub, itemId: string) => hub.store.jobsOfKind("action").filter((j) => j.itemId === itemId);

async function until(f: () => boolean) {
  for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(10);
}

test("restart kills a running headless action job: one fresh job takes over, same action, note and decision, no card", async () => {
  const { hub, item, job } = setup();
  const launches: string[] = [];
  new Agents(hub, fakeCmux(launches));
  await until(() => launches.length > 0);
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.job(job.id)!.error).toBe("server restarted mid-run");
  const jobs = actionJobs(hub, item.id);
  expect(jobs).toHaveLength(2);
  const next = jobs.find((j) => j.id !== job.id)!;
  expect(next.takeoverOf).toBe(job.id);
  expect(next.name).toBe("work");
  expect(next.decision).toBe(job.decision);
  expect(next.note).toContain("use the small fix");
  expect(next.note).toContain(`Took over from ${job.id}`);
  expect(next.note).toContain(`jobs/${job.id}`);
  expect(launches).toHaveLength(1);
  expect(launches[0]).toContain(`Took over from ${job.id}`);
  expect(hub.store.item(item.id)!.status).toBe("doing");
  // The takeover is the answer: no "Agent stopped" card for the killed job.
  expect(hub.store.questions("open").filter((q) => q.itemId === item.id || q.key.startsWith("after:"))).toHaveLength(0);
});

test("a second restart over the takeover doesn't send a third: it asks where the item stands", async () => {
  const { hub, item, job } = setup();
  const launches: string[] = [];
  new Agents(hub, fakeCmux(launches));
  await until(() => launches.length > 0);
  const next = actionJobs(hub, item.id).find((j) => j.id !== job.id)!;
  // Say the takeover ran headless and the next restart caught it mid-run too.
  hub.store.putJob({ ...hub.store.job(next.id)!, surface: "headless", status: "running", workspace: undefined });
  new Agents(hub, fakeCmux(launches));
  await Bun.sleep(50);
  expect(hub.store.job(next.id)!.status).toBe("failed");
  expect(actionJobs(hub, item.id)).toHaveLength(2);
  expect(launches).toHaveLength(1);
  const q = hub.store.questions("open").find((x) => x.key === `after:${next.id}`);
  expect(q?.badge).toBe("Agent stopped");
});

test("no takeover when the agent already said it's finished, or the item is closed", async () => {
  const launches: string[] = [];
  const a = setup({ reportedFinal: true, reported: true, summary: "Landed it" });
  new Agents(a.hub, fakeCmux(launches));
  const b = setup({}, "done");
  new Agents(b.hub, fakeCmux(launches));
  await Bun.sleep(50);
  expect(launches).toHaveLength(0);
  expect(actionJobs(a.hub, a.item.id)).toHaveLength(1);
  expect(actionJobs(b.hub, b.item.id)).toHaveLength(1);
  expect(a.hub.store.job(a.job.id)!.status).toBe("failed");
  expect(a.hub.store.questions("open").find((q) => q.key === `after:${a.job.id}`)?.context).toBe("Landed it");
});

test("takeover can't be sent (the build throws): the killed job's after-card comes back, its unsent folds journalled", async () => {
  const { hub, item, job } = setup({ status: "queued", startedAt: undefined, folded: ["also docs"] });
  const proto = Agents.prototype as any;
  const orig = proto.worktreeFor;
  proto.worktreeFor = async () => {
    throw new Error("disk full");
  };
  try {
    new Agents(hub, fakeCmux([]));
    await until(() => hub.store.questions("open").some((q) => q.key === `after:${job.id}`));
  } finally {
    proto.worktreeFor = orig;
  }
  const q = hub.store.questions("open").find((x) => x.key === `after:${job.id}`);
  expect(q?.context).toBe("server restarted mid-run");
  expect(hub.store.item(item.id)!.status).toBe("doing");
  expect(hub.store.journal().some((e) => e.text.includes("couldn't send an agent to take over (disk full)"))).toBe(true);
  expect(hub.store.journal().some((e) => e.text.includes(`${job.id} never got its folded note`) && e.text.includes("also docs"))).toBe(true);
});

test("item moved off doing during the run (waiting): no takeover, no card", async () => {
  const launches: string[] = [];
  const { hub, item, job } = setup({}, "waiting");
  new Agents(hub, fakeCmux(launches));
  await Bun.sleep(50);
  expect(launches).toHaveLength(0);
  expect(actionJobs(hub, item.id)).toHaveLength(1);
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.item(item.id)!.status).toBe("waiting");
  expect(hub.store.questions("open")).toHaveLength(0);
});

test("queued headless job that never started: taken over, and the note doesn't claim it ran", async () => {
  const launches: string[] = [];
  const { hub, item, job } = setup({ status: "queued", startedAt: undefined });
  new Agents(hub, fakeCmux(launches));
  await until(() => launches.length > 0);
  const next = actionJobs(hub, item.id).find((j) => j.id !== job.id);
  expect(next?.takeoverOf).toBe(job.id);
  expect(next?.note).toContain("restarted while it was queued");
  expect(next?.note).not.toContain("killed it");
  expect(hub.store.journal().some((e) => e.text.includes(`Restart killed ${job.id} before it started: sent ${next?.id} to take over`))).toBe(true);
});

test("two killed jobs on one item: one takeover carries both; no after-cards", async () => {
  const launches: string[] = [];
  const a = setup({ decision: "Fix it? → Do it" });
  const second: Job = { ...a.job, id: `${a.job.id}_b`, decision: "Fix it? → Also the docs", note: "docs too", createdAt: new Date(Date.now() + 1).toISOString() };
  a.hub.store.putJob(second);
  new Agents(a.hub, fakeCmux(launches));
  await until(() => launches.length > 0);
  await Bun.sleep(30);
  const fresh = actionJobs(a.hub, a.item.id).filter((j) => j.id !== a.job.id && j.id !== second.id);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]?.takeoverOf).toBe(a.job.id);
  expect(launches).toHaveLength(1);
  // The second's task folded into the one live takeover and went out in its prompt.
  expect(launches[0]).toContain(`Took over from ${second.id}`);
  expect(a.hub.store.questions("open").filter((q) => q.key.startsWith("after:"))).toHaveLength(0);
});

test("verify job: taken over while the item is open (not on doing); not once it's done", async () => {
  const launches: string[] = [];
  const a = setup({ name: "verify", title: "Verify · Fix the thing" }, "waiting");
  new Agents(a.hub, fakeCmux(launches));
  await until(() => launches.length > 0);
  expect(actionJobs(a.hub, a.item.id).find((j) => j.id !== a.job.id)?.takeoverOf).toBe(a.job.id);
  const b = setup({ name: "verify", title: "Verify · Fix the thing" }, "done");
  new Agents(b.hub, fakeCmux(launches));
  await Bun.sleep(50);
  expect(launches).toHaveLength(1);
  expect(actionJobs(b.hub, b.item.id)).toHaveLength(1);
});

test("takeovers wait for the boot ping and use its answer: no blocking available() call", async () => {
  const launches: string[] = [];
  const { hub, item } = setup();
  let answer!: (ok: boolean) => void;
  let availableCalls = 0;
  new Agents(hub, { ...fakeCmux(launches), available: () => (availableCalls++, true), ping: () => new Promise((r) => (answer = r)) });
  await Bun.sleep(30);
  expect(actionJobs(hub, item.id)).toHaveLength(1); // nothing sent before cmux answers
  answer(true);
  await until(() => launches.length > 0);
  expect(actionJobs(hub, item.id)).toHaveLength(2);
  expect(availableCalls).toBe(0);
});

test("restart before the takeover went out: the next boot sends it, once", async () => {
  const launches: string[] = [];
  const { hub, item, job } = setup();
  // First boot: cmux never answers before the "restart".
  new Agents(hub, { ...fakeCmux([]), ping: () => new Promise(() => {}) });
  await Bun.sleep(20);
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(actionJobs(hub, item.id)).toHaveLength(1);
  expect(JSON.parse(hub.store.kv("takeoverPending") ?? "[]")).toEqual([job.id]);
  new Agents(hub, fakeCmux(launches));
  await until(() => launches.length > 0);
  expect(actionJobs(hub, item.id).filter((j) => j.takeoverOf === job.id)).toHaveLength(1);
  await until(() => hub.store.kv("takeoverPending") === "[]");
  expect(hub.store.kv("takeoverPending")).toBe("[]");
  // A third boot has nothing left to send.
  new Agents(hub, fakeCmux(launches));
  await Bun.sleep(50);
  expect(launches).toHaveLength(1);
});

test("notes folded into the killed job ride along in the takeover, not journalled as lost", async () => {
  const launches: string[] = [];
  const { hub, item, job } = setup({ status: "queued", startedAt: undefined, folded: ["Fix it? → Also the docs"] });
  new Agents(hub, fakeCmux(launches));
  await until(() => launches.length > 0);
  expect(launches[0]).toContain("Also sent for this job before the restart: Fix it? → Also the docs");
  expect(hub.store.journal().some((e) => e.text.includes(`${job.id} never got its folded note`))).toBe(false);
  expect(actionJobs(hub, item.id)).toHaveLength(2);
});

test("pending id already taken over (boot cut short after dispatch): nothing more sent, no lost-note line, kv drains", async () => {
  const launches: string[] = [];
  // Item still on doing: only the already-sent check stands between this and a second takeover.
  const { hub, item, job } = setup({ status: "failed", error: "server restarted mid-run", folded: ["also docs"], startedAt: undefined });
  hub.store.putJob({ ...job, id: "job_taken", takeoverOf: job.id, status: "failed", error: "cancelled", folded: undefined, note: "x" });
  hub.store.setKv("takeoverPending", JSON.stringify([job.id]));
  new Agents(hub, fakeCmux(launches));
  await until(() => hub.store.kv("takeoverPending") === "[]");
  expect(hub.store.kv("takeoverPending")).toBe("[]");
  expect(launches).toHaveLength(0);
  expect(actionJobs(hub, item.id)).toHaveLength(2);
  expect(hub.store.journal().some((e) => e.text.includes("never got its folded note"))).toBe(false);
  expect(hub.store.journal().some((e) => e.text.includes("to take over"))).toBe(false);
});

test("boot ping says no cmux: the takeover runs headless, with no second ping", async () => {
  const { hub, item, job } = setup();
  let availableCalls = 0;
  let pings = 0;
  const agents = new Agents(hub, { ...fakeCmux([]), available: () => (availableCalls++, true), ping: async () => (pings++, false), bootWaitMs: 0 });
  const a = agents as any;
  const ran: string[] = [];
  a.runHeadlessOnce = async (id: string) => (ran.push(id), { ok: true, text: "" });
  a.gate.acquire = async () => 0;
  await until(() => ran.length > 0);
  const next = actionJobs(hub, item.id).find((j) => j.takeoverOf === job.id);
  expect(next?.surface).toBe("headless");
  expect(availableCalls).toBe(0);
  expect(pings).toBe(1);
});

test("malformed takeoverPending in kv doesn't break boot", () => {
  const { hub, job } = setup({ takeoverOf: "job_before" });
  hub.store.setKv("takeoverPending", "{}");
  new Agents(hub, fakeCmux([]));
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.kv("takeoverPending")).toBe("[]");
});

test("a started job's folds aren't repeated in the takeover (they went to its prompt, session or journal)", async () => {
  const launches: string[] = [];
  const { hub, item } = setup({ folded: ["also docs"] });
  new Agents(hub, fakeCmux(launches));
  await until(() => launches.length > 0);
  expect(launches[0]).not.toContain("Also sent for this job before the restart");
  expect(actionJobs(hub, item.id)).toHaveLength(2);
});
