import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { rpcError } from "../src/server/agents.ts";
import { GatewayToken, jwtExpiry } from "../src/server/gateway-token.ts";
import { assertShortArgs, PiPool, PiRpc } from "../src/server/pi-rpc.ts";

const FAKE = resolve(import.meta.dir, "fixtures/fake-pi.ts");
const live: PiRpc[] = [];
const make = () => {
  const w = new PiRpc({ bin: FAKE, args: [], cwd: import.meta.dir, env: process.env as Record<string, string> });
  live.push(w);
  return w;
};
const started = () => {
  const w = make();
  w.start();
  return w;
};
afterEach(async () => {
  await Promise.all(live.splice(0).map((w) => w.stop(500)));
});

test("argv guard rejects long strings", () => {
  expect(() => assertShortArgs(["-p", "x".repeat(600)])).toThrow(/600 bytes/);
  expect(() => assertShortArgs(["-p", "x".repeat(400)])).not.toThrow();
  expect(() => make().opts && new PiRpc({ bin: FAKE, args: ["y".repeat(2000)], cwd: ".", env: {} }).start()).toThrow(/stdin/);
});

test("a long prompt goes over stdin and comes back", async () => {
  const w = started();
  const r = await w.run("a".repeat(20_000), { timeoutMs: 5000 });
  expect(r.ok).toBe(true);
  expect(r.text).toBe("echo:20000:s1");
  expect(r.session).toMatch(/fake-session-\d+-1\.jsonl$/);
});

test("model error, tool use and dialogs", async () => {
  const w = started();
  const e = await w.run("ERROR", { timeoutMs: 5000 });
  expect(e.ok).toBe(false);
  expect(e.lastError).toBe("429 rate limit");
  const seen: string[] = [];
  const t = await w.run("TOOL", { timeoutMs: 5000, onEvent: (ev) => seen.push(ev.type) });
  expect(t.toolsRan).toBe(true);
  expect(seen).toContain("tool_execution_start");
  // Nobody can answer a dialog headless: it's declined, and the run carries on.
  const d = await w.run("DIALOG", { timeoutMs: 5000 });
  expect(d.text).toBe("dialog:true");
});

test("deadline aborts cleanly and the worker stays usable", async () => {
  const w = started();
  const r = await w.run("SLOW", { timeoutMs: 300 });
  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(true);
  expect(w.alive).toBe(true);
  expect((await w.run("again", { timeoutMs: 5000 })).ok).toBe(true);
});

test("a stalled run is aborted by the inactivity watchdog", async () => {
  const w = started();
  const r = await w.run("SLOW", { timeoutMs: 60_000, idleMs: 300 });
  expect(r.stalled).toBe(true);
  expect(r.timedOut).toBeFalsy();
});

test("a run that goes silent after agent_start leaves rpc.jsonl ending in agent_start", async () => {
  const logPath = resolve(mkdtempSync(resolve(tmpdir(), "whq-rpc-")), "rpc.jsonl");
  const w = new PiRpc({ bin: FAKE, args: [], cwd: import.meta.dir, env: process.env as Record<string, string>, logPath });
  live.push(w);
  w.start();
  const r = await w.run("SLOW", { timeoutMs: 60_000, idleMs: 300, killAfterMs: 500 });
  expect(r.stalled).toBe(true);
  expect(r.lastEvent?.type).toBe("agent_start");
  expect(rpcError(r, 30, 10)).toMatch(/^stalled: no activity for 10 min \(last event: agent_start at \d\d:\d\d:\d\dZ\)$/);
  const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // Everything up to the stall: our prompt, pi's reply, agent_start. Then our abort.
  const upToStall = lines.slice(0, lines.findIndex((l) => l.dir === "out" && l.type === "abort"));
  expect(upToStall.map((l) => `${l.dir}:${l.type}`)).toEqual(["out:prompt", "in:response", "in:agent_start"]);
  expect(upToStall.at(-1).type).toBe("agent_start");
  expect(lines.every((l) => typeof l.t === "string" && !("message" in l))).toBe(true); // no prompt text in the log
});

test("stall error says when pi sent nothing at all", () => {
  expect(rpcError({ ok: false, text: "", toolsRan: false, stalled: true, stderr: "" }, 30, 10)).toBe("stalled: no activity for 10 min (no events from pi)");
});

test("a run that ignores abort gets killed", async () => {
  const w = started();
  const r = await w.run("HANG", { timeoutMs: 200, killAfterMs: 300 });
  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(true);
  expect(w.alive).toBe(false);
});

test("a crash mid-run reports exit code and stderr", async () => {
  const w = started();
  const r = await w.run("CRASH", { timeoutMs: 5000 });
  expect(r.ok).toBe(false);
  expect(r.exit?.code).toBe(3);
  expect(r.stderr).toContain("boom");
  await expect(w.request("get_state")).rejects.toThrow(/not running/);
});

test("pool reuses a warm worker with a fresh session, and retires bad ones", async () => {
  const pool = new PiPool({ size: 1, make });
  const a = await pool.run("PID", { timeoutMs: 5000 });
  await Bun.sleep(100); // re-arm happens in the background
  const b = await pool.run("PID", { timeoutMs: 5000 });
  expect(b.text).toBe(a.text); // same process
  expect((await pool.run("x", { timeoutMs: 5000 })).text).toBe("echo:1:s3"); // a new session each run
  await pool.run("CRASH", { timeoutMs: 5000 });
  await Bun.sleep(100);
  const c = await pool.run("PID", { timeoutMs: 5000 });
  expect(c.text).not.toBe(a.text); // crashed worker replaced
  await pool.stop();
});

test("pool: concurrent requests beyond size get a one-off worker", async () => {
  const pool = new PiPool({ size: 1, make });
  const [a, b] = await Promise.all([pool.run("PID", { timeoutMs: 5000 }), pool.run("PID", { timeoutMs: 5000 })]);
  expect(a.ok && b.ok).toBe(true);
  expect(a.text).not.toBe(b.text);
  await Bun.sleep(100);
  expect(pool.stats.idle).toBe(1);
  await pool.stop();
});

test("pool: a stamp change retires warm workers", async () => {
  let stamp = "v1";
  const pool = new PiPool({ size: 1, make, stamp: () => stamp });
  const a = await pool.run("PID", { timeoutMs: 5000 });
  await Bun.sleep(100);
  stamp = "v2";
  const b = await pool.run("PID", { timeoutMs: 5000 });
  expect(b.text).not.toBe(a.text);
  await pool.stop();
});

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

test("gateway token: cached until shortly before expiry, refetched after invalidate", async () => {
  const now = Date.now();
  let calls = 0;
  const tok = jwt(Math.floor(now / 1000) + 3600);
  expect(jwtExpiry(tok)).toBe((Math.floor(now / 1000) + 3600) * 1000);
  const g = new GatewayToken({ env: "T", command: "x" }, async () => (calls++, { code: 0, stdout: `${tok}\n`, stderr: "" }));
  expect(await g.env(now)).toEqual({ T: tok });
  await g.env(now + 60_000);
  expect(calls).toBe(1);
  await g.env(now + 3600_000 - 60_000); // inside the 5-minute early-refresh window
  expect(calls).toBe(2);
  g.invalidate();
  await g.env(now + 3600_000 - 60_000);
  expect(calls).toBe(3);
});

test("gateway token: a failing command passes nothing and backs off", async () => {
  let calls = 0;
  const g = new GatewayToken({ env: "T", command: "x" }, async () => (calls++, { code: 1, stdout: "", stderr: "login expired" }));
  expect(await g.env(1000)).toEqual({});
  expect(g.lastError).toBe("login expired");
  await g.env(2000);
  expect(calls).toBe(1);
  expect(await new GatewayToken(undefined).env()).toEqual({});
});

// ── laptop sleep: suspended time is not stall time (10-19: every "stalled" sweep aborted on a DarkWake) ──

/** A clock that runs with real time, plus whatever we jump it by. */
const jumpable = () => {
  let offset = 0;
  return { now: () => Date.now() + offset, jump: (ms: number) => (offset += ms) };
};

test("a 15-minute sleep mid-tool doesn't stall the run", async () => {
  const w = started();
  const c = jumpable();
  setTimeout(() => c.jump(15 * 60_000), 150); // laptop sleeps while pi is busy
  const r = await w.run("LATE:600", { timeoutMs: 20 * 60_000, idleMs: 10 * 60_000, clock: c.now, tickMs: 50 });
  expect(r.ok).toBe(true);
  expect(r.stalled).toBeFalsy();
  expect(r.text).toBe("late");
  expect(r.sleptMs!).toBeGreaterThan(14.9 * 60_000);
  expect(r.sleptMs!).toBeLessThanOrEqual(15 * 60_000);
});

test("the deadline moves out by the sleep, and awake time still runs it out", async () => {
  const w = started();
  const c = jumpable();
  setTimeout(() => c.jump(15 * 60_000), 100);
  const t0 = Date.now();
  const r = await w.run("SLOW", { timeoutMs: 600, clock: c.now, tickMs: 50, killAfterMs: 500 });
  expect(r.timedOut).toBe(true);
  // Without the credit it would have timed out on the first tick after the jump (~100 ms).
  expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
  expect(r.sleptMs!).toBeGreaterThan(14.9 * 60_000);
  expect(rpcError(r, 20, 10)).toBe("machine slept mid-run (15 min), then timed out after 20 min");
});

test("a genuine hang with no sleep is still caught", async () => {
  const w = started();
  const c = jumpable();
  setTimeout(() => c.jump(20_000), 100); // a slow tick, under the suspend threshold: not sleep
  const r = await w.run("SLOW", { timeoutMs: 60 * 60_000, idleMs: 15_000, clock: c.now, tickMs: 50 });
  expect(r.stalled).toBe(true);
  expect(r.sleptMs).toBeUndefined();
  expect(rpcError(r, 20, 10)).toStartWith("stalled: no activity for 10 min");
});
