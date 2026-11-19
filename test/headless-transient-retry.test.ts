import { afterEach, expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { config } from "../src/server/config.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Item } from "../src/shared/types.ts";

// 11-13 gateway DNS outage: the cmux job got "retrying once in 60 s"; the headless one (job_mwe57wl4irmlr, 12 tool
// calls in, session on disk) died on its first "Connection error.: getaddrinfo ENOTFOUND …". A headless action run
// that ends on a network blip now gets one more run through the launch gate, resuming its session when tools ran.

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };
const BLIP = "Connection error.: getaddrinfo ENOTFOUND gateway.opencode.cloudflare.dev";
type Run = { ok: boolean; text: string; error?: string; session?: string; toolsRan?: boolean };
const blip = (o: Partial<Run> = {}): Run => ({ ok: false, text: "", error: BLIP, ...o });
const ok: Run = { ok: true, text: "done" };
const backoffSec = config.pi.rateLimitBackoffSec;
afterEach(() => void (config.pi.rateLimitBackoffSec = backoffSec));

let n = 0;
type Call = { resume?: string; nudge?: string };
/** `seam` "once" fakes runHeadlessOnce; "rpc" fakes runRpc, so the nudge has to get through runHeadlessOnce. */
async function run(runs: Run[], o: { seam?: "once" | "rpc"; retryMs?: number; during?: (hub: Hub, jobId: string, agents: Agents) => void } = {}) {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  agents.actionBlipRetryMs = o.retryMs ?? 20;
  const a = agents as any;
  a.gate.acquire = async () => 0;
  a.gate.wait = () => 0;
  const calls: Call[] = [];
  const fake = async (jobId: string, resume?: string, nudge?: string) => {
    calls.push({ resume, nudge });
    if (calls.length === 1) o.during?.(hub, jobId, agents);
    return runs[calls.length - 1] ?? blip();
  };
  if (o.seam === "rpc") a.runRpc = (id: string, _p: string, _o: unknown, _env: unknown, resume?: string, nudge?: string) => fake(id, resume, nudge);
  else a.runHeadlessOnce = (id: string, _p: string, _o: unknown, resume?: string, nudge?: string) => fake(id, resume, nudge);
  const item: Item = { id: `it_htr${++n}`, kind: "idea", status: "inbox", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const job = (await agents.dispatch(item.id, "work"))!;
  for (let i = 0; i < 400 && !["done", "failed"].includes(hub.store.job(job.id)!.status); i++) await Bun.sleep(5);
  return { hub, agents, job: hub.store.job(job.id)!, calls };
}

test("blip before any tool ran, then ok: two runs, the second fresh, job done", async () => {
  const { job, calls } = await run([blip({ session: "/s/0.jsonl" }), ok]);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.resume).toBeUndefined();
  expect(job.status).toBe("done");
  expect(job.tail.join("\n")).toContain("retrying once");
});

test("blip after tools ran with a session: resume it with the network nudge, through the real runner seam", async () => {
  const { job, calls } = await run([blip({ toolsRan: true, session: "/s/1.jsonl" }), ok], { seam: "rpc" });
  expect(calls).toHaveLength(2);
  expect(calls[1]!.resume).toBe("/s/1.jsonl");
  expect(calls[1]!.nudge).toContain("network error");
  expect(job.status).toBe("done");
});

test("blip after tools ran with no session to resume: no retry (a fresh run would repeat side effects)", async () => {
  const { job, calls } = await run([blip({ toolsRan: true })]);
  expect(calls).toHaveLength(1);
  expect(job.status).toBe("failed");
  expect(job.error).toBe(BLIP);
});

test("blips twice: no third run, failed and says so", async () => {
  const { job, calls } = await run([blip(), blip()]);
  expect(calls).toHaveLength(2);
  expect(job.status).toBe("failed");
  expect(job.error).toBe(`${BLIP} (again after one retry)`);
});

test("a bare DNS error (no 'Connection error.' wrapper) is a blip too", async () => {
  const bare = "getaddrinfo EAI_AGAIN gateway.opencode.cloudflare.dev";
  const { job, calls } = await run([blip({ error: bare }), ok]);
  expect(calls).toHaveLength(2);
  expect(job.status).toBe("done");
});

test("the agent reported, then the network dropped: no retry, the report wins (as in cmux)", async () => {
  const { hub, job, calls } = await run([blip({ toolsRan: true, session: "/s/2.jsonl" })], {
    during: (hub, jobId) => hub.ingestReport({ jobId, summary: "Fixed it", status: "done" }, "agent"),
  });
  expect(calls).toHaveLength(1);
  expect(job.status).toBe("done");
  expect(job.summary).toBe("Fixed it");
  expect(hub.store.questions("open").some((q) => q.badge === "Agent stopped")).toBe(false);
});

/** Start a run that blips once, wait until it's in the blip wait, hand back what's needed to act during it. */
async function inWait(first: Run) {
  let hub: Hub | undefined;
  let agents: Agents | undefined;
  let id = "";
  const p = run([first, ok], { retryMs: 1_000, during: (h, j, a) => ((hub = h), (agents = a), (id = j)) });
  let seen = false;
  for (let i = 0; i < 200 && !(seen = Boolean(hub?.store.job(id)?.tail.join("\n").includes("retrying once"))); i++) await Bun.sleep(2);
  expect(seen).toBe(true);
  return { hub: hub!, agents: agents!, id, p };
}

test("a final report that lands during the blip wait: done at once, no second run", async () => {
  const { hub, id, p } = await inWait(blip({ toolsRan: true, session: "/s/3.jsonl" }));
  const t0 = Date.now();
  hub.ingestReport({ jobId: id, summary: "Fixed it", status: "done" }, "agent");
  const { job, calls } = await p;
  expect(calls).toHaveLength(1);
  expect(job.status).toBe("done");
  expect(Date.now() - t0).toBeLessThan(600); // didn't sit out the 1 s wait
});

test("cancelled during the blip wait: no second run", async () => {
  const { agents, id, p } = await inWait(blip());
  agents.cancel(id);
  const { job, calls } = await p;
  expect(calls).toHaveLength(1);
  expect(job.status).toBe("failed");
  expect(job.error).toBe("cancelled");
});

test("a progress report, then a blip: the work isn't done, so it still gets its retry", async () => {
  const { job, calls } = await run([blip({ toolsRan: true, session: "/s/5.jsonl" }), ok], {
    during: (hub, jobId) => hub.ingestReport({ jobId, summary: "Halfway", status: "progress" }, "agent"),
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]!.resume).toBe("/s/5.jsonl");
  expect(job.status).toBe("done");
});

test("the report was the run's last message, then a blip: the report is kept and wins", async () => {
  const text = JSON.stringify({ summary: "Filed PAY-2240", status: "done" });
  const { job, calls } = await run([blip({ text, toolsRan: true, session: "/s/6.jsonl" }), ok]);
  expect(calls).toHaveLength(1);
  expect(job.status).toBe("done");
  expect(job.summary).toBe("Filed PAY-2240");
});

test("a progress `whq report`, then the final report as the last message, then a blip: the final report wins", async () => {
  const text = JSON.stringify({ summary: "Filed PAY-2240", status: "done" });
  const { job, calls } = await run([blip({ text, toolsRan: true, session: "/s/7.jsonl" }), ok], {
    during: (hub, jobId) => hub.ingestReport({ jobId, summary: "Halfway", status: "progress" }, "agent"),
  });
  expect(calls).toHaveLength(1);
  expect(job.status).toBe("done");
  expect(job.summary).toBe("Filed PAY-2240");
});

test("a progress report as the last message, a blip, then the final report as the retry's last message: both kept, final wins", async () => {
  const progress = JSON.stringify({ summary: "Halfway", status: "progress" });
  const done = JSON.stringify({ summary: "Filed PAY-2240", status: "done" });
  const { job, calls } = await run([blip({ text: progress, toolsRan: true, session: "/s/8.jsonl" }), { ok: true, text: done }]);
  expect(calls).toHaveLength(2);
  expect(job.status).toBe("done");
  expect(job.summary).toBe("Filed PAY-2240");
  expect(job.tail.join("\n")).toContain("✓ Halfway");
});

test("no blip: a progress `whq report`, then the final report as the last message: the final one is kept", async () => {
  const done = JSON.stringify({ summary: "Filed PAY-2240", status: "done" });
  const { job, calls } = await run([{ ok: true, text: done }], {
    during: (hub, jobId) => hub.ingestReport({ jobId, summary: "Halfway", status: "progress" }, "agent"),
  });
  expect(calls).toHaveLength(1);
  expect(job.status).toBe("done");
  expect(job.summary).toBe("Filed PAY-2240");
});

test("stray JSON in the last message isn't a report: the blip is retried", async () => {
  const { calls } = await run([blip({ text: '{"port":1234}' }), ok]);
  expect(calls).toHaveLength(2);
});

test("a non-network error isn't retried", async () => {
  const { job, calls } = await run([{ ok: false, text: "", error: "pi exited (1)" }]);
  expect(calls).toHaveLength(1);
  expect(job.status).toBe("failed");
});

test("rate limit, blip, rate limit, ok: the blip doesn't use up a rate-limit retry, each resume gets its own nudge", async () => {
  config.pi.rateLimitBackoffSec = [0, 0];
  const s = "/s/4.jsonl";
  const limited: Run = { ok: false, text: "", error: "429 Too Many Requests", toolsRan: true, session: s };
  const { job, calls } = await run([limited, blip({ toolsRan: true, session: s }), limited, ok]);
  expect(calls).toHaveLength(4);
  expect(calls[1]!.nudge).toContain("rate limit");
  expect(calls[2]!.nudge).toContain("network error");
  expect(calls[3]!.nudge).toContain("rate limit");
  expect(job.status).toBe("done");
  expect(job.tail.join("\n")).toContain(`(2/${config.pi.rateLimitRetries})`);
});
