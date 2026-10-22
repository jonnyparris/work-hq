import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Question } from "../src/shared/types.ts";

// 10-22, it_mvj713axaje2b: three answers on one item sent three TICKET jobs in 17 s. Each prompt carried every
// note on the item and nothing said which one was its own, so each job filed tickets for all of them:
// KITE-166/169 and KITE-167/168 were duplicate pairs. Each job now gets its own decision, sees the jobs
// already running on the item, and a second dispatch of the very same thing returns the running job.

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };

function setup() {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  hub.dispatcher = agents;
  const prompts = new Map<string, string>();
  // Keep the job queued (live) and capture the prompt; never launch.
  (agents as any).launchAction = async (jobId: string, _t: string, prompt: string) => void prompts.set(jobId, prompt);
  const item = hub.createItem({ title: "Commerce.com WebMCP post. Could help Kitesurf", kind: "idea", status: "doing" });
  const ask = (key: string, prompt: string, label: string) =>
    hub.ask({
      kind: "open", itemId: item.id, key, priority: 72, prompt,
      options: [
        { id: "go", label, effect: { type: "dispatch", action: "ticket" } },
        { id: "no", label: "Not now", effect: { type: "noop" } },
      ],
    }) as Question;
  return { hub, agents, prompts, item, ask };
}

test("parallel answers on one item: each job is scoped to its own decision and sees the ones before it", async () => {
  const { hub, prompts, item, ask } = setup();
  const q1 = ask("agent:1", "Close PAY-1668 and PAY-1496 as already done?", "Close both");
  const q2 = ask("agent:2", "File KITE ticket: wrap AbortSignal.timeout in the defer-shim?", "File the ticket");
  const q3 = ask("agent:3", "Close KITE-97 and file an edge-bridge e2e fixture?", "File the ticket");
  await hub.answer(q1.id, "go");
  await hub.answer(q2.id, "go");
  await hub.answer(q3.id, "go");

  const live = hub.store.liveJobs().filter((j) => j.itemId === item.id);
  expect(live).toHaveLength(3);
  // Same-millisecond createdAt is common here, so find each job by its decision rather than sorting.
  const decisions = [
    "Close PAY-1668 and PAY-1496 as already done? → Close both",
    "File KITE ticket: wrap AbortSignal.timeout in the defer-shim? → File the ticket",
    "Close KITE-97 and file an edge-bridge e2e fixture? → File the ticket",
  ];
  const jobs = decisions.map((d) => live.find((j) => j.decision === d)!);
  expect(jobs.every(Boolean)).toBe(true);

  const [p1, p2, p3] = jobs.map((j) => prompts.get(j.id)!);
  expect(p1).toContain("THIS JOB'S DECISION (do this one, nothing else):\n- Close PAY-1668 and PAY-1496 as already done? → Close both");
  expect(p1).not.toContain("ALSO RUNNING ON THIS ITEM");
  expect(p2).toContain("- File KITE ticket: wrap AbortSignal.timeout in the defer-shim? → File the ticket\nThe other decisions");
  expect(p2).toContain(`- ${jobs[0]!.id} · TICKET: Close PAY-1668`);
  // The third job knows both earlier ones are running and what each is for.
  expect(p3).toContain(`- ${jobs[0]!.id} · TICKET: Close PAY-1668`);
  expect(p3).toContain(`- ${jobs[1]!.id} · TICKET: File KITE ticket: wrap AbortSignal.timeout`);
  // Notes still carry all three decisions as context.
  expect(p3).toContain("notes on it (newest last)");
  expect(p3.indexOf("THIS JOB'S DECISION")).toBeLessThan(p3.indexOf("notes on it"));
});

test("the same action for the same decision while it's running returns the running job", async () => {
  const { hub, agents, item } = setup();
  const a = await agents.dispatch(item.id, "ticket", "file it", "Q? → File the ticket");
  const b = await agents.dispatch(item.id, "ticket", "file it", "Q? → File the ticket");
  expect(b?.id).toBe(a!.id);
  // A different decision or action is a different job.
  const c = await agents.dispatch(item.id, "ticket", "file it", "Other Q? → File the ticket");
  const d = await agents.dispatch(item.id, "reply", "file it", "Q? → File the ticket");
  expect(new Set([a!.id, c!.id, d!.id]).size).toBe(3);
  // Once the first one has finished, the same dispatch runs again.
  hub.putJob({ ...hub.store.job(a!.id)!, status: "done", finishedAt: new Date().toISOString() });
  const e = await agents.dispatch(item.id, "ticket", "file it", "Q? → File the ticket");
  expect(e?.id).not.toBe(a!.id);
});

test("a dispatch with no decision (drawer button) gets no scope block but still sees siblings", async () => {
  const { prompts, agents, item } = setup();
  const a = await agents.dispatch(item.id, "ticket", undefined, "Q? → File the ticket");
  const b = await agents.dispatch(item.id, "work");
  const p = prompts.get(b!.id)!;
  expect(p).not.toContain("THIS JOB'S DECISION");
  expect(p).toContain(`- ${a!.id} · TICKET: Q? → File the ticket`);
});
