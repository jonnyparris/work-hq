import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agents, CMUX_TOKEN_TTL_MS, type CmuxDeps } from "../src/server/agents.ts";
import { jobDir } from "../src/server/cmux.ts";
import { Store } from "../src/server/db.ts";
import { GatewayToken } from "../src/server/gateway-token.ts";
import { Hub } from "../src/server/hub.ts";
import type { Item, Job } from "../src/shared/types.ts";

// The 10-19 22:38Z error, verbatim from the pi session (cmux run, no "Login expired" card followed).
const AUTH_ERROR =
  `API key auth failed for provider acme-gw: Failed to resolve API key for provider "acme-gw" from shell command: ` +
  `if [ -n "\${ACME_GW_TOKEN:-}" ]; then printf %s "$ACME_GW_TOKEN"; else exec 'cloudflared' access token -app='https://gw.example.com'; fi`;

/** An unsigned JWT that expires `ms` from now. */
function jwt(ms: number) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: Math.floor((Date.now() + ms) / 1000) })}.sig`;
}

function tokenFor(t: string, runs: { n: number }) {
  return new GatewayToken({ env: "ACME_GW_TOKEN", command: "mint" }, async () => {
    runs.n++;
    return { code: 0, stdout: `${t}\n`, stderr: "" };
  });
}

function setup(id: string, deps: CmuxDeps) {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: `it_${id}`, kind: "idea", status: "proposed", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  return { hub, item, agents: new Agents(hub, deps) };
}

async function launchEnv(token: string) {
  const seen: Array<Record<string, string> | undefined> = [];
  const spy: CmuxDeps = { available: () => true, launch: (o) => (seen.push(o.env), { workspace: "ws", statusPath: "/dev/null" }) };
  const { hub, item, agents } = setup(`l${Math.random().toString(36).slice(2, 8)}`, spy);
  const runs = { n: 0 };
  Object.assign(agents, { token: tokenFor(token, runs) });
  const job = await agents.dispatch(item.id, "work");
  for (let i = 0; i < 100 && !seen.length; i++) await Bun.sleep(5);
  expect(hub.store.job(job!.id)!.status).toBe("running");
  return { env: seen[0], runs };
}

test("cmux launch gets the shared gateway token in its env", async () => {
  const t = jwt(10 * 24 * 3600_000);
  const { env, runs } = await launchEnv(t);
  expect(env?.ACME_GW_TOKEN).toBe(t);
  expect(runs.n).toBe(1);
});

test("a token close to expiry isn't baked into a long-lived cmux session", async () => {
  const { env } = await launchEnv(jwt(CMUX_TOKEN_TTL_MS - 60_000));
  expect(env?.ACME_GW_TOKEN).toBeUndefined();
});

/** A running cmux job, picked up by a fresh Agents as after a restart. No workspace, so the live check skips it. */
function running(id: string) {
  const deps: CmuxDeps = { available: () => true, launch: () => ({ workspace: "ws", statusPath: "/dev/null" }) };
  const hub = new Hub(new Store(":memory:"));
  const job: Job = { id: `job_${id}`, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "running", tail: [], createdAt: new Date().toISOString() };
  hub.store.putJob(job);
  const agents = new Agents(hub, deps);
  const beacon = (b: object) => writeFileSync(resolve(jobDir(job.id), "status.json"), JSON.stringify(b));
  return { hub, agents, beacon };
}

test("an auth-error beacon raises the Login expired card and drops the token; a clean turn retires it", async () => {
  const { hub, agents, beacon } = running("ga");
  const runs = { n: 0 };
  const token = tokenFor(jwt(10 * 24 * 3600_000), runs);
  Object.assign(agents, { token });
  await token.env();

  beacon({ state: "idle", seq: 1, outcome: "error", detail: AUTH_ERROR });
  agents.pollCmux();
  agents.pollCmux(); // same turn twice: one card, one journal line
  const cards = hub.store.questions("open").filter((q) => q.key.startsWith("gateway-auth:"));
  expect(cards).toHaveLength(1);
  expect(cards[0]!.badge).toBe("Login expired");
  expect(cards[0]!.options.find((o) => o.id === "login")?.effect).toEqual({ type: "gatewayLogin", app: "https://gw.example.com" });
  expect(agents.gatewayBlocked()).toBe(true);
  await token.env();
  expect(runs.n).toBe(2); // invalidated: next run mints afresh

  beacon({ state: "working", seq: 2 });
  agents.pollCmux();
  beacon({ state: "idle", seq: 2, outcome: "completed" });
  agents.pollCmux();
  expect(hub.store.questions("open").filter((q) => q.key.startsWith("gateway-auth:"))).toHaveLength(0);
  expect(agents.gatewayBlocked()).toBe(false);
});

test("a non-auth error beacon raises no login card", () => {
  const { hub, agents, beacon } = running("gb");
  beacon({ state: "idle", seq: 1, outcome: "error", detail: "500 internal server error" });
  agents.pollCmux();
  expect(hub.store.questions("open").filter((q) => q.key.startsWith("gateway-auth:"))).toHaveLength(0);
});
