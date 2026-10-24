// 10-23: 13 "Agent asks" cards were open; 11 asked to merge Dodo PRs / incident-call-agent MRs that one job had
// merged hours before. That job never touched the items, so nothing closed the cards. The prompter already knows
// when an item's links have all landed; now it closes the agent cards on it and hands the item to the merged card.
import { beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { JiraStates } from "../src/server/jira-state.ts";
import { MrStates } from "../src/server/mr-state.ts";
import { type PrInfo, PrStates } from "../src/server/pr-state.ts";
import { followsMerge, type Landed, Prompter, settledByLanding } from "../src/server/prompter.ts";
import type { Question } from "../src/shared/types.ts";

const PR = (n: number) => `https://github.com/acme/dodo/pull/${n}`;
let prs: Record<string, PrInfo>;
let hub: Hub;
let p: Prompter;
let ghs: PrStates;

beforeEach(() => {
  prs = { [PR(150)]: { state: "merged", mergedAt: new Date(Date.now() + 60_000).toISOString() }, [PR(151)]: { state: "open" } };
  hub = new Hub(new Store(":memory:"));
  ghs = new PrStates(async (r) => prs[r.url] ?? { state: "unknown" });
  p = new Prompter(hub, new MrStates(async () => ({ state: "unknown" })), new JiraStates(async () => ({ state: "unknown" }), new Set()), ghs);
});

const run = async () => {
  p.tick(new Date());
  await ghs.settled();
  p.tick(new Date());
};
const agentAsk = (itemId: string, prompt: string, key = `agent:${itemId}:${prompt}`) =>
  hub.ask({ kind: "open", badge: "Agent asks", itemId, key, priority: 72, prompt, options: [{ id: "o0", label: "Merge + deploy", effect: { type: "dispatch", action: "work" } }] }) as Question;

test("an agent card on an item whose PRs all merged closes, and the item goes on the merged card", async () => {
  const it = hub.createItem({ title: "Dodo: mcp allowlist at connect time", status: "doing", links: [PR(150)] });
  const q = agentAsk(it.id, "Merge Dodo PR #150 (mcp: off at connect time)?");
  await run();
  const after = hub.store.question(q.id)!;
  expect(after.status).toBe("expired");
  expect(after.answer).toMatch(/^landed: dodo#150 merged \d\d-\d\d\.$/);
  expect(hub.store.item(it.id)!.status).toBe("waiting");
  const merged = hub.store.questions("open").find((x) => x.key === "wait:merged");
  expect(merged?.itemId).toBe(it.id);
  expect(hub.store.journal(20).some((j) => j.text.startsWith("Closed agent cards, everything it links landed: Dodo: mcp allowlist"))).toBe(true);
});

test("one link still open, or a lookup that failed: the card stays", async () => {
  const a = hub.createItem({ title: "A", status: "waiting", links: [PR(150), PR(151)] });
  const b = hub.createItem({ title: "B", status: "waiting", links: [PR(999)] });
  const qa = agentAsk(a.id, "Merge both?");
  const qb = agentAsk(b.id, "Merge #999?");
  await run();
  expect(hub.store.question(qa.id)!.status).toBe("open");
  expect(hub.store.question(qb.id)!.status).toBe("open");
});

test("a card that waits for the merge stays: the merge is what makes it actionable", async () => {
  const it = hub.createItem({ title: "Flip WORKERS_AI_VIA_BINDING", status: "waiting", links: [PR(150)] });
  const q = agentAsk(it.id, "When #150 merges, should an agent flip WORKERS_AI_VIA_BINDING in prod?");
  await run();
  expect(hub.store.question(q.id)!.status).toBe("open");
});

test("an agent still on the item, and the owner's own cards, are left alone", async () => {
  const it = hub.createItem({ title: "Busy", status: "doing", links: [PR(150)] });
  const q = agentAsk(it.id, "Merge #150?");
  hub.store.putJob({ id: "job_live", kind: "action", name: "work", title: "Work · Busy", surface: "cmux", status: "running", itemId: it.id, tail: [], createdAt: new Date().toISOString() });
  await run();
  expect(hub.store.question(q.id)!.status).toBe("open");
  expect(hub.store.item(it.id)!.status).toBe("doing");

  const mine = hub.createItem({ title: "Mine", status: "today", links: [PR(150)] });
  const own = hub.ask({ kind: "open", itemId: mine.id, key: "mine:1", priority: 50, prompt: "Merge #150?", options: [] })!;
  await run();
  expect(hub.store.question(own.id)!.status).toBe("open");
  expect(hub.store.item(mine.id)!.status).toBe("today");
});

test("a card asked after the last merge is about the next step, and stays", async () => {
  const it = hub.createItem({ title: "Deploy", status: "waiting", links: [PR(150)] });
  const q = agentAsk(it.id, "#150 merged. Deploy to prod now?");
  prs[PR(150)] = { state: "merged", mergedAt: new Date(Date.parse(q.createdAt) - 60_000).toISOString() };
  await run();
  expect(hub.store.question(q.id)!.status).toBe("open");
  // No merge date at all: can't tell, so it stays too.
  prs[PR(151)] = { state: "merged" };
  const b = hub.createItem({ title: "No date", status: "waiting", links: [PR(151)] });
  const qb = agentAsk(b.id, "Merge #151?");
  await run();
  expect(hub.store.question(qb.id)!.status).toBe("open");
});

test("a scheduled item keeps its slot when its agent cards close", async () => {
  const it = hub.createItem({ title: "Sched", status: "scheduled", scheduledFor: new Date(Date.now() + 86_400_000).toISOString(), links: [PR(150)] });
  const q = agentAsk(it.id, "Merge #150?");
  await run();
  expect(hub.store.question(q.id)!.status).toBe("expired");
  expect(hub.store.item(it.id)!.status).toBe("scheduled");
});

test("a card that asks for more than the merge stays: a deploy, or a ref that hasn't landed", async () => {
  const it = hub.createItem({ title: "X", status: "waiting", links: [PR(150)] });
  const deploy = agentAsk(it.id, "Merge Dodo PR #150 and deploy to prod?");
  const other = agentAsk(it.id, "Merge #151 too?");
  const fine = agentAsk(it.id, "Should the AI SDK 7 job keep going?");
  await run();
  expect(hub.store.question(deploy.id)!.status).toBe("open");
  expect(hub.store.question(other.id)!.status).toBe("open");
  expect(hub.store.question(fine.id)!.status).toBe("expired");
});

test("an item with a settled card and an open deploy card stays where it is", async () => {
  const it = hub.createItem({ title: "Y", status: "today", links: [PR(150)] });
  const settled = agentAsk(it.id, "After review, merge PR #150?");
  const deploy = agentAsk(it.id, "Merge #150 and deploy?");
  await run();
  expect(hub.store.question(settled.id)!.status).toBe("expired");
  expect(hub.store.question(deploy.id)!.status).toBe("open");
  expect(hub.store.item(it.id)!.status).toBe("today");
});

test("settledByLanding: work after the merge, or a ref that didn't land, isn't settled", () => {
  const l: Landed = { mrs: [{ url: "", host: "", project: "a/ica", iid: 20 }], prs: [{ url: "", owner: "o", repo: "dodo", number: 150 }], tickets: [{ ref: { key: "ETI-1075" } as any, status: "Done" }] };
  for (const p of ["Merge #150 and deploy?", "Merge #150, then release?", "Merge #150 and tag v2?", "Publish after #150?", "Flip the var with #150?", "Merge #150 and run the migration?", "Merge #150 to prod?", "Revert #150?", "Rebase !20?", "Notify the team about #150?", "Merge #150, rollback plan?", "Merge #150 or roll back?", "Merge #150, rolled back plan?", "Merge #150 and ship it?", "Merge #150 and cut over?", "Merge #150 then enable the flag?", "Merge #150 and roll it back?", "Merge #150 and roll the change back?", "Merge #150, set feature flags?", "Merge #150, feature-flag it?", "Merge #150 and do the cut-over?", "Merge #150, rolled-back plan?", "Merge #150 and roll-out?", "Merge #150 then back it out?"])
    expect(settledByLanding({ prompt: p }, l)).toBe(false);
  for (const p of ["Merge #151 too?", "Close eti-1076?", "Is PAY_X-3 done?"]) expect(settledByLanding({ prompt: p }, l)).toBe(false);
  for (const p of ["Merge #150?", "Mark !20 ready, or fold it in?", "Is eti-1075 still blocked?", "Keep Kumo blue?", "Merge #150, roll the backlog?"]) expect(settledByLanding({ prompt: p }, l)).toBe(true);
});

test("a card the moot pass closes frees its slot in the same tick", async () => {
  const it = hub.createItem({ title: "Z", status: "done" });
  const q = agentAsk(it.id, "Anything else?");
  p.tick(new Date());
  expect(hub.store.question(q.id)!.status).toBe("expired");
  expect((p as any).open.some((x: Question) => x.id === q.id)).toBe(false);
});

test("a JIRA-only item closes its agent cards once the ticket is done", async () => {
  const jira = new JiraStates(async () => ({ state: "done", status: "Done", doneAt: new Date(Date.now() + 60_000).toISOString() }), new Set(["jira.example.org"]));
  p = new Prompter(hub, new MrStates(async () => ({ state: "unknown" })), jira, ghs);
  const it = hub.createItem({ title: "T", status: "waiting", links: ["https://jira.example.org/browse/ETI-1075"] });
  const q = agentAsk(it.id, "Is ETI-1075 still blocked?");
  p.tick(new Date());
  await jira.settled();
  p.tick(new Date());
  expect(hub.store.question(q.id)!.status).toBe("expired");
});

test("a card asked in the same second as the merge (GitHub has no milliseconds) counts as after it", async () => {
  const it = hub.createItem({ title: "S", status: "waiting", links: [PR(150)] });
  const q = agentAsk(it.id, "Merge #150?");
  prs[PR(150)] = { state: "merged", mergedAt: `${q.createdAt.slice(0, 19)}Z` };
  await run();
  expect(hub.store.question(q.id)!.status).toBe("open");
});

test("followsMerge reads 'when/once/after … merges' as waiting for a merge, not asking for one", () => {
  expect(followsMerge({ prompt: "When #137 merges, should an agent finish #142 and flip WORKERS_AI_VIA_BINDING in prod?" })).toBe(true);
  expect(followsMerge({ prompt: "Once !16 lands, retarget !19 to main?" })).toBe(true);
  expect(followsMerge({ prompt: "After ETI-1075 is closed, delete the stub DO?" })).toBe(true);
  expect(followsMerge({ prompt: "Merge Dodo PR #148 (turn stall guard) and deploy to prod?" })).toBe(false);
  expect(followsMerge({ prompt: "After review, merge PR #150?" })).toBe(false);
  expect(followsMerge({ prompt: "When CI passes, land #150?" })).toBe(false);
  expect(followsMerge({ prompt: "PR #137 is reviewed, conflict-free and green. Land it (mark Ready, merge, deploy)?" })).toBe(false);
  expect(followsMerge({ prompt: "!20 is a draft stacked on !16 (ci/kickstart-move), and CI is green. Mark it ready, or fold it into !16 now?" })).toBe(false);
});
