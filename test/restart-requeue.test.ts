import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { jobDir } from "../src/server/cmux.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Item, Job } from "../src/shared/types.ts";

// A cmux action job the server restarted on while it waited on the launch gate.
function setup(id: string, { savedPrompt = true } = {}) {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: `it_${id}`, kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const job: Job = { id: `job_${id}`, kind: "action", name: "work", title: "Work · Fix the thing", surface: "cmux", status: "queued", itemId: item.id, tail: [], createdAt: new Date().toISOString() };
  hub.store.putJob(job);
  if (savedPrompt) writeFileSync(resolve(jobDir(job.id), "prompt.md"), "do the work");
  return { hub, item, job };
}

const fakeCmux = (ok: boolean, launches: string[] = []): CmuxDeps => ({
  available: () => ok,
  launch: (o) => {
    launches.push(`${o.jobId}:${o.prompt}`);
    return { workspace: `ws_${o.jobId}`, statusPath: "/dev/null" };
  },
});

test("queued cmux job with no workspace goes back on the gate and launches with its saved prompt", async () => {
  const { hub, item, job } = setup("a");
  const launches: string[] = [];
  new Agents(hub, fakeCmux(true, launches));
  for (let i = 0; i < 50 && !launches.length; i++) await Bun.sleep(10);
  expect(launches).toEqual([`${job.id}:do the work`]);
  const after = hub.store.job(job.id)!;
  expect(after.status).toBe("running");
  expect(after.workspace).toBe(`ws_${job.id}`);
  expect(hub.store.item(item.id)!.status).toBe("doing");
  expect(hub.store.questions("open")).toHaveLength(0);
});

test("no cmux after the restart: fail the job, hand the item back, ask to send it again", () => {
  const { hub, item, job } = setup("b");
  new Agents(hub, fakeCmux(false));
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.item(item.id)!.status).toBe("proposed");
  const [q] = hub.store.questions("open");
  expect(q?.kind).toBe("dispatch");
  expect(q?.itemId).toBe(item.id);
  expect(q?.options[0]?.effect).toEqual({ type: "dispatch", action: "work" });
});

test("job queued before prompts were saved: same hand-back, never a stuck doing", () => {
  const { hub, item, job } = setup("c", { savedPrompt: false });
  new Agents(hub, fakeCmux(true));
  expect(hub.store.job(job.id)!.status).toBe("failed");
  expect(hub.store.item(item.id)!.status).toBe("proposed");
  expect(hub.store.questions("open")[0]?.key).toBe(`restart:${job.id}`);
});

test("headless jobs caught mid-run still fail", () => {
  const { hub, job } = setup("d");
  hub.store.putJob({ ...job, surface: "headless", status: "running" });
  new Agents(hub, fakeCmux(true));
  expect(hub.store.job(job.id)!.status).toBe("failed");
});
