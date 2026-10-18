import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { jobDir } from "../src/server/cmux.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Job } from "../src/shared/types.ts";

// 10-15 09:50Z: a command-bar ask hit a pi crash. The reply said "kept your words in the journal",
// nothing retried, and the ask sat unseen for 35 hours. Crashes get one rerun; failures get a card.

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };
const ok = (text: string) => ({ ok: true, text });
const crash = { ok: false, text: "", error: "pi exited null" };
const GOOD = JSON.stringify({ reply: "Added.", items: [{ title: "Chase the vendor" }] });

function setup(runs: Array<{ ok: boolean; text: string; error?: string }>) {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  const calls = { run: 0, apply: 0 };
  const a = agents as any;
  a.runHeadless = async () => runs[calls.run++] ?? crash;
  const apply = a.applyTriage.bind(agents);
  a.applyTriage = async (...args: unknown[]) => {
    calls.apply++;
    return apply(...args);
  };
  return { hub, agents, calls };
}

test("pi crashes once, then answers: rerun once, apply once, no card", async () => {
  const { hub, agents, calls } = setup([crash, ok(GOOD)]);
  const r = await agents.triage("remind me to chase the vendor");
  expect(calls.run).toBe(2);
  expect(calls.apply).toBe(1);
  expect(r.reply).toBe("Added.");
  expect(hub.store.job(r.jobId)!.status).toBe("done");
  expect(hub.store.items().map((i) => i.title)).toContain("Chase the vendor");
  expect(hub.store.questions("open")).toHaveLength(0);
});

test("crashes twice: no third run, words come back on a Retry / Drop card", async () => {
  const words = "x".repeat(100);
  const { hub, agents, calls } = setup([crash, crash]);
  const r = await agents.triage(words, "pineapple");
  expect(calls.run).toBe(2);
  expect(calls.apply).toBe(0);
  expect(hub.store.job(r.jobId)!.status).toBe("failed");
  const [q] = hub.store.questions("open");
  expect(q?.kind).toBe("open");
  expect(q?.prompt).toContain(`"${"x".repeat(80)}…"`);
  expect(q?.options.map((o) => o.label)).toEqual(["Retry", "Drop"]);
  expect(q?.options[0]?.effect).toEqual({ type: "triage", text: words, mode: "pineapple" });
});

test("non-crash failure (timeout, bad JSON) isn't rerun but still gets the card", async () => {
  const { hub, agents, calls } = setup([ok("not json at all")]);
  await agents.triage("book the room");
  expect(calls.run).toBe(1);
  expect(hub.store.questions("open")[0]?.options[0]?.effect).toEqual({ type: "triage", text: "book the room", mode: "chat" });
});

test("Retry on the card runs triage again with the same words", async () => {
  const { hub, agents, calls } = setup([crash, crash, ok(GOOD)]);
  await agents.triage("remind me to chase the vendor");
  const [q] = hub.store.questions("open");
  await hub.applyEffect(q!.options[0]!.effect, q, q!.options[0]);
  for (let i = 0; i < 50 && !calls.apply; i++) await Bun.sleep(5);
  expect(calls.run).toBe(3);
  expect(calls.apply).toBe(1);
});

test("restart caught a triage mid-run: its words come back on a card", () => {
  const store = new Store(":memory:");
  const job: Job = { id: "job_tri_restart", kind: "triage", name: "chat", title: "do the thing", surface: "headless", status: "running", tail: [], createdAt: new Date().toISOString() };
  store.putJob(job);
  writeFileSync(resolve(jobDir(job.id), "triage.json"), JSON.stringify({ text: "do the thing after lunch", mode: "chat" }));
  const hub = new Hub(store);
  new Agents(hub, noCmux);
  expect(hub.store.job(job.id)!.status).toBe("failed");
  const [q] = hub.store.questions("open");
  expect(q?.key).toBe(`triage-failed:${job.id}`);
  expect(q?.context).toContain("server restarted mid-run");
  expect(q?.options[0]?.effect).toEqual({ type: "triage", text: "do the thing after lunch", mode: "chat" });
});

// 10-13, 10-14, 10-17: triage asked a follow-up ("Send an agent?"), the owner tapped "Yes", and
// nothing happened: every option was a noop. A tap now re-runs triage with the words + the answer.
test("follow-up question from triage: tapping an option re-runs triage with the answer", async () => {
  const ASK = JSON.stringify({ reply: "Want me to?", question: { prompt: "Send an agent?", options: ["Yes", "No"] } });
  const { hub, agents, calls } = setup([ok(ASK), ok(GOOD)]);
  const seen: Array<[string, string]> = [];
  const a = agents as any;
  const triage = a.triage.bind(agents);
  a.triage = (text: string, mode: string) => (seen.push([text, mode]), triage(text, mode));
  await triage("pull last quarter's usage report", "chat");
  const [q] = hub.store.questions("open");
  expect(q?.options.map((o) => o.label)).toEqual(["Yes", "No"]);
  await hub.answer(q!.id, "o0", "only Q3");
  for (let i = 0; i < 50 && calls.apply < 2; i++) await Bun.sleep(5);
  expect(seen).toHaveLength(1);
  expect(seen[0]![1]).toBe("chat");
  expect(seen[0]![0]).toBe("pull last quarter's usage report\n\nYou asked: Send an agent?\nThey answered: Yes\nThey added: only Q3");
  expect(calls.apply).toBe(2);
  expect(hub.store.items().map((i) => i.title)).toContain("Chase the vendor");
  expect(hub.store.journal().some((j) => j.text === "Send an agent? → Yes — only Q3")).toBe(true);
});
