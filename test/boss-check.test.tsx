import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Agents, bossCards, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { bossPrompt } from "../src/server/prompts.ts";
import type { Job, Question } from "../src/shared/types.ts";
import { AgentsPanel, BossButton } from "../src/web/parts.tsx";

// 10-23: 13 "Agent asks" cards were open. 11 were stale (10 about PRs/MRs that had already merged, 1 about a
// workaround already removed); 2 were real. The boss check verifies them in one go and closes the stale ones.

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };

function setup() {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  hub.dispatcher = agents;
  const launched: string[] = [];
  (agents as any).launchAction = async (_id: string, _t: string, prompt: string) => void launched.push(prompt);
  const item = hub.createItem({ title: "Merge dodo#150", kind: "task", status: "waiting", links: ["https://github.com/x/dodo/pull/150"] });
  hub.store.putJob({ id: "job_asker", kind: "action", name: "work", title: "Work · Merge dodo#150", surface: "cmux", status: "done", itemId: item.id, tail: [], createdAt: new Date(Date.now() - 3600_000).toISOString(), summary: "Opened #150" });
  const ask = (prompt: string, key = `agent:${prompt.length}`) =>
    hub.ask({ kind: "open", badge: "Agent asks", itemId: item.id, key, priority: 72, prompt, options: [{ id: "o0", label: "Merge + deploy", effect: { type: "dispatch", action: "work" } }] }) as Question;
  return { hub, agents, launched, item, ask };
}

const bossJob = (hub: Hub) => {
  hub.store.putJob({ id: "job_boss", kind: "action", name: "boss", title: "Boss check", surface: "cmux", status: "running", tail: [], createdAt: new Date().toISOString() });
  return "job_boss";
};

test("closeQuestions from the boss expires the card with its reason and runs none of its buttons", () => {
  const { hub, item, ask } = setup();
  const q = ask("Merge Dodo PR #150?");
  const r = hub.ingestReport({ jobId: bossJob(hub), closeQuestions: [{ id: q.id, reason: "dodo#150 merged 10-23" }, { id: "q_nope", reason: "x" }] });
  expect(r.closed).toBe(1);
  const after = hub.store.question(q.id)!;
  expect(after.status).toBe("expired");
  expect(after.answer).toBe("dodo#150 merged 10-23");
  expect(hub.store.item(item.id)!.status).toBe("waiting");
  expect(hub.store.jobs().filter((j) => !["job_asker", "job_boss"].includes(j.id))).toHaveLength(0);
  expect(hub.store.journal(10).some((j) => j.text.includes("Closed card: Merge Dodo PR #150?"))).toBe(true);
});

test("closeQuestions from any other job, or on the owner's own cards, closes nothing", () => {
  const { hub, item, ask } = setup();
  const q = ask("Merge Dodo PR #150?");
  const mine = hub.ask({ kind: "state", itemId: item.id, key: "stale:x", priority: 10, prompt: "Still waiting?", options: [] })!;
  expect(hub.ingestReport({ jobId: "job_asker", closeQuestions: [{ id: q.id, reason: "x" }] }).closed).toBeUndefined();
  expect(hub.ingestReport({ closeQuestions: [{ id: q.id, reason: "x" }] }).closed).toBeUndefined();
  expect(hub.ingestReport({ jobId: bossJob(hub), closeQuestions: [{ id: mine.id, reason: "x" }] }).closed).toBeUndefined();
  expect(hub.store.question(q.id)!.status).toBe("open");
  expect(hub.store.question(mine.id)!.status).toBe("open");
});

test("an agent update to done closes the item's agent cards, not the owner's own", () => {
  const { hub, item, ask } = setup();
  const a = ask("Merge Dodo PR #150?");
  const b = ask("Re-verify #150 on preview?");
  const mine = hub.ask({ kind: "state", itemId: item.id, key: "stale:x", priority: 10, prompt: "Still waiting?", options: [] })!;
  hub.ingestReport({ updates: [{ id: item.id, status: "done", note: "merged" }] });
  expect(hub.store.question(a.id)!.status).toBe("expired");
  expect(hub.store.question(b.id)!.status).toBe("expired");
  expect(hub.store.question(mine.id)!.status).toBe("open");
});

test("a card asked in the same report as a done update stays open", () => {
  const { hub, item } = setup();
  hub.ingestReport({ updates: [{ id: item.id, status: "done" }], questions: [{ prompt: "Flip the prod var now?", itemId: item.id }] });
  expect(hub.store.questions("open").map((q) => q.prompt)).toEqual(["Flip the prod var now?"]);
});

test("bossCheck sends one item-less job whose prompt lists each agent card with its links and asker", async () => {
  const { hub, agents, launched, ask } = setup();
  const q = ask("Merge Dodo PR #150?");
  hub.ask({ kind: "state", key: "stale:x", priority: 10, prompt: "Not an agent card", options: [] });
  const job = (await agents.bossCheck())!;
  expect(job.name).toBe("boss");
  expect(job.itemId).toBeUndefined();
  expect(job.title).toBe("Boss check · 1 agent card");
  expect(launched).toHaveLength(1);
  expect(launched[0]).toContain(`Card ${q.id}`);
  expect(launched[0]).toContain("https://github.com/x/dodo/pull/150");
  expect(launched[0]).toContain("Asked by job job_asker (work, now done): Opened #150");
  expect(launched[0]).toContain("closeQuestions");
  expect(launched[0]).not.toContain("Not an agent card");
  // A system line, not something the owner said (11-01: the reflection read `you` lines as first-hand).
  expect(hub.store.journal().find((e) => e.text.startsWith("Boss check sent"))?.who).toBe("hq");
  // A second click while it runs hands back the same job.
  hub.store.putJob({ ...hub.store.job(job.id)!, status: "running" });
  expect((await agents.bossCheck())!.id).toBe(job.id);
  expect(launched).toHaveLength(1);
});

test("bossCheck with nothing waiting starts nothing", async () => {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  expect(await agents.bossCheck()).toBeUndefined();
  expect(hub.store.jobs()).toHaveLength(0);
});

test("bossCards ignores closed cards and non-agent keys", () => {
  const { hub, ask } = setup();
  const q = ask("Merge Dodo PR #150?");
  ask("Older one", "after:job_asker");
  hub.expireQuestion(q.id);
  expect(bossCards(hub).map((c) => c.q.key)).toEqual(["after:job_asker"]);
});

test("bossPrompt lists sessions with their status file", () => {
  const p = bossPrompt("job_b", [], [{ job: { id: "job_s", title: "Reply · X", status: "blocked", startedAt: "2026-10-23T19:50:17.108Z" }, statusFile: "/tmp/s.json" }]);
  expect(p).toContain("job_s · blocked since 2026-10-23 19:50Z · Reply · X");
  expect(p).toContain("status file: /tmp/s.json");
  expect(p).toContain("They may be watching this session.");
  expect(bossPrompt("job_b", [], [], false)).toContain("This run is headless");
});

test("an agent card reported with its own key still counts as an agent card", () => {
  const { hub, item } = setup();
  hub.ingestReport({ jobId: "job_asker", questions: [{ prompt: "Merge #150?", key: "merge:dodo#150", itemId: item.id }] });
  expect(bossCards(hub).map((c) => c.q.key)).toEqual(["merge:dodo#150"]);
  const mine = hub.ask({ kind: "state", itemId: item.id, key: "mine:custom", priority: 10, prompt: "Mine", options: [] })!;
  expect(renderToStaticMarkup(<BossButton jobs={[]} questions={hub.store.questions("open")} min={1} />)).toContain("1 agent says they need you");
  hub.ingestReport({ updates: [{ id: item.id, status: "done" }] });
  expect(hub.store.questions("open").map((q) => q.id)).toEqual([mine.id]);
});

test("the Agents panel shows the Boss check button from 3 things waiting, and a running boss disables it", () => {
  const card = (i: number) => ({ id: `q${i}`, key: `agent:${i}`, status: "open", kind: "open", prompt: "?", options: [], priority: 72, createdAt: "" }) as Question;
  const blocked = { id: "j1", kind: "action", name: "reply", title: "R", surface: "cmux", status: "blocked", tail: [], createdAt: "" } as Job;
  expect(renderToStaticMarkup(<AgentsPanel jobs={[]} cmux questions={[card(1), card(2)]} />)).not.toContain("Boss check");
  // A headless job can't be waiting in cmux: the server wouldn't count it, so neither does the button.
  expect(renderToStaticMarkup(<AgentsPanel jobs={[{ ...blocked, surface: "headless" }]} cmux questions={[card(1), card(2)]} />)).not.toContain("Boss check");
  const three = renderToStaticMarkup(<AgentsPanel jobs={[blocked]} cmux questions={[card(1), card(2)]} />);
  expect(three).toContain("3 agents say they need you");
  expect(three).toContain("Boss check: which are real?");
  const boss = { ...blocked, id: "j2", name: "boss", status: "running" } as Job;
  const busy = renderToStaticMarkup(<AgentsPanel jobs={[boss]} cmux questions={[]} />);
  expect(busy).toContain("Boss checking…");
  expect(busy).toContain("disabled");
});
