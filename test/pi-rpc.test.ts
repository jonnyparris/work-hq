import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
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
