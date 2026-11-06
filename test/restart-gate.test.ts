import { expect, test } from "bun:test";
import type { Job } from "../src/shared/types.ts";
import { MAX_HOLD_MS, RestartGate, SERVER_ROOT, blockers } from "../src/server/restart.ts";

// 10-21: every landing kickstarted the server at once and killed whatever sweep was mid-run (five by 11:00).
const job = (id: string, surface: Job["surface"], status: Job["status"] = "running"): Job =>
  ({ id, kind: "sweep", name: id, title: `T ${id}`, surface, status, tail: [], createdAt: "2026-10-21T10:00:00Z" }) as Job;

const gate = (live: Job[], t = { now: 0 }) => {
  const ran: string[] = [];
  const g = new RestartGate({ live: () => live, command: "restart-cmd", run: (c) => ran.push(c), now: () => t.now, pollMs: 60_000_000 });
  return { g, ran, t };
};
const flush = () => Bun.sleep(350); // fire() defers the command so the HTTP answer goes out first

test("blockers: running/queued headless jobs only; cmux jobs survive a restart", () => {
  const live = [job("a", "headless"), job("b", "headless", "queued"), job("c", "cmux"), job("d", "headless", "blocked" as Job["status"])];
  expect(blockers(live).map((j) => j.id)).toEqual(["a", "b"]);
});

test("nothing headless running: restarts now", async () => {
  const { g, ran } = gate([job("c", "cmux")]);
  expect(g.request("job_1")).toMatchObject({ status: "now", waitingFor: [] });
  expect(g.pending).toBeUndefined();
  await flush();
  expect(ran).toEqual(["restart-cmd"]);
});

test("a running sweep holds it; landings fold into one restart once the sweep ends", async () => {
  const live = [job("cal", "headless")];
  const { g, ran } = gate(live);
  expect(g.request("job_1")).toMatchObject({ status: "queued", waitingFor: ["T cal"] });
  expect(g.request("job_2").status).toBe("queued");
  expect(g.check()).toBe(false);
  live.length = 0;
  expect(g.check()).toBe(true);
  expect(g.pending).toBeUndefined();
  await flush();
  expect(ran).toEqual(["restart-cmd"]);
  expect(g.check()).toBe(false);
});

test("a stuck sweep holds it at most MAX_HOLD_MS", async () => {
  const { g, ran, t } = gate([job("cal", "headless")]);
  g.request("job_1");
  t.now = MAX_HOLD_MS - 1;
  expect(g.check()).toBe(false);
  t.now = MAX_HOLD_MS;
  expect(g.check()).toBe(true);
  await flush();
  expect(ran).toEqual(["restart-cmd"]);
});

// 11-05: job_mw2cz30ktqlbv landed, the restart fired at once and killed it before its report ("server restarted mid-run").
test("a headless landing job holds its own restart until it leaves running", async () => {
  const live = [job("job_1", "headless")];
  const { g, ran } = gate(live);
  const a = g.request("job_1");
  expect(a.status).toBe("queued");
  expect(a.waitingFor).toEqual(["T job_1 (the job asking: restarts when it ends)"]);
  expect(g.check()).toBe(false);
  await flush();
  expect(ran).toEqual([]);
  live[0] = { ...live[0]!, status: "done" };
  expect(g.check()).toBe(true);
  await flush();
  expect(ran).toEqual(["restart-cmd"]);
});

test("a headless landing job that never finishes still restarts at MAX_HOLD_MS", async () => {
  const { g, ran, t } = gate([job("job_1", "headless")]);
  expect(g.request("job_1").status).toBe("queued");
  t.now = MAX_HOLD_MS;
  expect(g.check()).toBe(true);
  await flush();
  expect(ran).toEqual(["restart-cmd"]);
});

test("a landing job that joins a long hold late still gets MAX_HOLD_MS from its own ask", async () => {
  const live = [job("cal", "headless")];
  const { g, ran, t } = gate(live);
  g.request("job_1");
  t.now = 20 * 60_000;
  live.push(job("job_2", "headless"));
  expect(g.request("job_2").status).toBe("queued");
  t.now = MAX_HOLD_MS + 1; // the sweep's cap has passed, job_2's hasn't
  expect(g.check()).toBe(false);
  t.now = 20 * 60_000 + MAX_HOLD_MS;
  expect(g.check()).toBe(true);
  await flush();
  expect(ran).toEqual(["restart-cmd"]);
});

test("a cmux landing job doesn't hold its restart: cmux sessions survive it", () => {
  const { g } = gate([job("job_1", "cmux")]);
  expect(g.request("job_1").status).toBe("now");
});

test("handles only this server's checkout, and only with a restart command", () => {
  expect(gate([]).g.handles(SERVER_ROOT)).toBe(true);
  expect(gate([]).g.handles("/tmp")).toBe(false);
  expect(new RestartGate({ live: () => [], command: undefined }).handles(SERVER_ROOT)).toBe(false);
  expect(RestartGate.commandFor(SERVER_ROOT, [{ dir: "/elsewhere", restart: "x" }, { dir: SERVER_ROOT, restart: "kick" }])).toBe("kick");
  expect(RestartGate.commandFor(SERVER_ROOT, [{ dir: "/elsewhere", restart: "x" }])).toBeUndefined();
});
