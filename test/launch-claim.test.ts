import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { claimLaunch, claimPath, jobDir, launchInCmux } from "../src/server/cmux.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Item } from "../src/shared/types.ts";

// 10-23: `cmux workspace create` timed out, the server fell back to headless, and cmux made the workspace anyway.
// Two pi sessions on one item. One claim file per job decides who runs it.

test("first claim wins; the second learns who holds the job", () => {
  expect(claimLaunch("job_lc1", "cmux")).toBe(true);
  expect(claimLaunch("job_lc1", "headless")).toBe("cmux");
  expect(readFileSync(claimPath("job_lc1"), "utf8").trim()).toBe("cmux");
});

test("launch.sh stands down without starting pi when the job already runs headless", () => {
  const jobId = "job_lc2";
  expect(claimLaunch(jobId, "headless")).toBe(true);
  // CMUX_BIN is /usr/bin/false in tests: the workspace create fails, but launch.sh is written first.
  const launched = launchInCmux({ jobId, title: "t", prompt: "p", cwd: "/tmp", piArgs: [], command: ["/bin/echo", "PI-RAN"] });
  expect(launched).toBeUndefined();
  const r = spawnSync("/bin/zsh", ["-f", resolve(jobDir(jobId), "launch.sh")], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("already running (headless)");
  expect(r.stdout).not.toContain("PI-RAN");
  expect(existsSync(resolve(jobDir(jobId), "status.json"))).toBe(false);
});

test("cmux create 'fails' but its session already claimed the job: adopt it, don't start headless", async () => {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: "it_lc3", kind: "idea", status: "inbox", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const claims: string[] = [];
  const deps: CmuxDeps = {
    available: () => true,
    launch: () => undefined,
    claim: (_id, owner) => (claims.push(owner), "cmux"),
    findWorkspace: (id) => `ws_${id}`,
  };
  const agents = new Agents(hub, deps);
  const job = (await agents.dispatch(item.id, "work"))!;
  for (let i = 0; i < 100 && hub.store.job(job.id)!.status === "queued"; i++) await Bun.sleep(10);
  const after = hub.store.job(job.id)!;
  expect(claims).toEqual(["headless"]);
  expect(after.status).toBe("running");
  expect(after.surface).toBe("cmux");
  expect(after.workspace).toBe(`ws_${job.id}`);
  expect(existsSync(resolve(jobDir(job.id), "rpc.jsonl"))).toBe(false);
});

// A restart caught a cmux job "queued" with no workspace, but it had already launched.
function restartWith(id: string, claim: "cmux" | "headless") {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: `it_${id}`, kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const jobId = `job_${id}`;
  hub.store.putJob({ id: jobId, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "queued", itemId: item.id, tail: [], createdAt: new Date().toISOString() });
  writeFileSync(resolve(jobDir(jobId), "prompt.md"), "do the work");
  expect(claimLaunch(jobId, claim)).toBe(true);
  const launches: string[] = [];
  const deps: CmuxDeps = { available: () => true, launch: (o) => (launches.push(o.jobId), { workspace: "ws_new", statusPath: "/dev/null" }), findWorkspace: () => "ws_old" };
  new Agents(hub, deps);
  return { hub, jobId, launches };
}

test("restart after its cmux session claimed the job: track that session, launch nothing", async () => {
  const { hub, jobId, launches } = restartWith("lc4", "cmux");
  await Bun.sleep(50);
  expect(launches).toEqual([]);
  expect(hub.store.job(jobId)!.status).toBe("running");
  expect(hub.store.job(jobId)!.workspace).toBe("ws_old");
});

test("restart after the headless fallback claimed the job: that run died with the server, fail it, launch nothing", async () => {
  const { hub, jobId, launches } = restartWith("lc5", "headless");
  await Bun.sleep(50);
  expect(launches).toEqual([]);
  expect(hub.store.job(jobId)!.status).toBe("failed");
});

test("cancelled while its adopted workspace was being looked up: close it, don't revive the job", async () => {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: "it_lc6", kind: "idea", status: "inbox", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  let looks = 0;
  const closed: string[] = [];
  const deps: CmuxDeps = {
    available: () => true,
    launch: () => undefined,
    claim: () => "cmux",
    findWorkspace: () => (looks++ === 0 ? undefined : "ws_late"),
    closeWorkspace: (id) => closed.push(id),
  };
  const agents = new Agents(hub, deps);
  const job = (await agents.dispatch(item.id, "work"))!;
  for (let i = 0; i < 100 && looks === 0; i++) await Bun.sleep(10);
  agents.cancel(job.id);
  for (let i = 0; i < 200 && !closed.length; i++) await Bun.sleep(10);
  expect(closed).toEqual(["ws_late"]);
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.job(job.id)!.workspace).toBeUndefined();
});

test("launch.sh that can't start (cwd gone) writes the exited beacon so the job settles", () => {
  const jobId = "job_lc7";
  launchInCmux({ jobId, title: "t", prompt: "p", cwd: "/nonexistent/work-hq-test", piArgs: [], command: ["/bin/echo", "PI-RAN"] });
  const r = spawnSync("/bin/zsh", ["-f", resolve(jobDir(jobId), "launch.sh")], { encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(JSON.parse(readFileSync(resolve(jobDir(jobId), "status.json"), "utf8"))).toMatchObject({ state: "exited", code: 1 });
});

test("cancelled before its adopted workspace was listed: keep looking and close it when it shows up", async () => {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: "it_lc8", kind: "idea", status: "inbox", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  let looks = 0;
  let cancelNow: (() => void) | undefined;
  const closed: string[] = [];
  const deps: CmuxDeps = {
    available: () => true,
    launch: () => undefined,
    claim: () => "cmux",
    // First look: not listed yet, and the owner hits Stop right then. Third look: there it is.
    findWorkspace: () => {
      looks++;
      if (looks === 1) cancelNow?.();
      return looks >= 3 ? "ws_later" : undefined;
    },
    closeWorkspace: (id) => closed.push(id),
  };
  const agents = new Agents(hub, deps);
  const job = (await agents.dispatch(item.id, "work"))!;
  cancelNow = () => agents.cancel(job.id);
  for (let i = 0; i < 400 && !closed.length; i++) await Bun.sleep(10);
  expect(closed).toEqual(["ws_later"]);
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.job(job.id)!.workspace).toBeUndefined();
});

test("restart after its workspace was made but before launch.sh claimed: track that workspace, launch nothing", async () => {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: "it_lc9", kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const jobId = "job_lc9";
  hub.store.putJob({ id: jobId, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "queued", itemId: item.id, tail: [], createdAt: new Date().toISOString() });
  writeFileSync(resolve(jobDir(jobId), "prompt.md"), "do the work");
  const launches: string[] = [];
  new Agents(hub, { available: () => true, launch: (o) => (launches.push(o.jobId), { workspace: "ws_new", statusPath: "/dev/null" }), findWorkspace: () => "ws_made" });
  for (let i = 0; i < 100 && !hub.store.job(jobId)!.workspace; i++) await Bun.sleep(10);
  expect(launches).toEqual([]);
  expect(hub.store.job(jobId)!).toMatchObject({ status: "running", surface: "cmux", workspace: "ws_made" });
});

test("restart relaunch: an old session claims the job while the relaunch waits on the gate — adopt it, launch nothing", async () => {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: "it_lc10", kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const jobId = "job_lc10";
  hub.store.putJob({ id: jobId, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "queued", itemId: item.id, tail: [], createdAt: new Date().toISOString() });
  writeFileSync(resolve(jobDir(jobId), "prompt.md"), "do the work");
  const launches: string[] = [];
  let listed = false;
  new Agents(hub, { available: () => true, launch: (o) => (launches.push(o.jobId), { workspace: "ws_new", statusPath: "/dev/null" }), findWorkspace: () => (listed ? "ws_old" : undefined) });
  // Not listed at boot; its launch.sh claims while the relaunch is still on the cap/gate.
  expect(claimLaunch(jobId, "cmux")).toBe(true);
  listed = true;
  for (let i = 0; i < 200 && !hub.store.job(jobId)!.workspace; i++) await Bun.sleep(10);
  expect(launches).toEqual([]);
  expect(hub.store.job(jobId)!).toMatchObject({ status: "running", surface: "cmux", workspace: "ws_old" });
});

test("cancelled, and its workspace only shows up after cmux's slow create: still closed", async () => {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: "it_lc11", kind: "idea", status: "inbox", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  let looks = 0;
  let cancelNow: (() => void) | undefined;
  const closed: string[] = [];
  const deps: CmuxDeps = {
    available: () => true,
    launch: () => undefined,
    claim: () => "cmux",
    findWorkspace: () => {
      looks++;
      if (looks === 1) cancelNow?.();
      return looks >= 8 ? "ws_slow" : undefined;
    },
    closeWorkspace: (id) => closed.push(id),
  };
  const agents = new Agents(hub, deps);
  const job = (await agents.dispatch(item.id, "work"))!;
  cancelNow = () => agents.cancel(job.id);
  for (let i = 0; i < 1000 && !closed.length; i++) await Bun.sleep(10);
  expect(closed).toEqual(["ws_slow"]);
}, 15000);

test("restart relaunch: the job got claimed headless meanwhile — fail it, launch nothing", async () => {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: "it_lc12", kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const jobId = "job_lc12";
  hub.store.putJob({ id: jobId, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "queued", itemId: item.id, tail: [], createdAt: new Date().toISOString() });
  writeFileSync(resolve(jobDir(jobId), "prompt.md"), "do the work");
  const launches: string[] = [];
  new Agents(hub, { available: () => true, launch: (o) => (launches.push(o.jobId), { workspace: "ws_new", statusPath: "/dev/null" }), findWorkspace: () => undefined });
  expect(claimLaunch(jobId, "headless")).toBe(true);
  for (let i = 0; i < 200 && hub.store.job(jobId)!.status === "queued"; i++) await Bun.sleep(10);
  expect(launches).toEqual([]);
  expect(hub.store.job(jobId)!).toMatchObject({ status: "failed" });
  expect(hub.store.job(jobId)!.error).toContain("already launched");
});

test("Stop after the adopted workspace lookup gave up: cancel looks once more and closes it", async () => {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: "it_lc13", kind: "idea", status: "inbox", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  let listed = false;
  const closed: string[] = [];
  const agents = new Agents(hub, { available: () => true, launch: () => undefined, claim: () => "cmux", findWorkspace: () => (listed ? "ws_late" : undefined), closeWorkspace: (id) => closed.push(id) });
  const job = (await agents.dispatch(item.id, "work"))!;
  for (let i = 0; i < 800 && !hub.store.job(job.id)!.tail.some((l) => l.includes("couldn't find")); i++) await Bun.sleep(10);
  listed = true;
  agents.cancel(job.id);
  expect(closed).toEqual(["ws_late"]);
}, 15000);

test("Stop on a blocked cmux job with no workspace yet still looks it up and closes it", async () => {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: "it_lc14", kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  hub.store.putJob({ id: "job_lc14", kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "blocked", itemId: item.id, tail: [], createdAt: new Date().toISOString() });
  const closed: string[] = [];
  const agents = new Agents(hub, { available: () => true, launch: () => undefined, findWorkspace: () => "ws_b", closeWorkspace: (id) => closed.push(id) });
  agents.cancel("job_lc14");
  expect(closed).toEqual(["ws_b"]);
  expect(hub.store.job("job_lc14")!.status).toBe("failed");
});
