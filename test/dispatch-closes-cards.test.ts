import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { AGENT_ASKS } from "../src/shared/boss.ts";
import type { Question } from "../src/shared/types.ts";

// 11-05 15:06: "just do it" from the drawer sent an agent (Dodo PR #118) and its "Still waiting" card
// (q_mw3n8nbta8evy) stayed open. Sending an agent answers the item's waiting/state cards; agent cards stay.

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };

function setup() {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  hub.dispatcher = agents;
  // Keep the job queued; never launch.
  (agents as any).launchAction = async () => {};
  const item = hub.createItem({ title: "Dodo PR #118", kind: "task", status: "waiting" });
  const card = (key: string, kind: Question["kind"] = "state", itemId = item.id) =>
    hub.ask({
      kind, itemId, key, priority: 50, prompt: key,
      options: [
        { id: "go", label: "Chase them", effect: { type: "dispatch", action: "reply" } },
        { id: "done", label: "Resolved", effect: { type: "status", status: "done" } },
      ],
    }) as Question;
  const status = (q: Question) => hub.store.question(q.id)!.status;
  return { hub, agents, item, card, status };
}

test("a drawer dispatch expires the item's waiting/state cards and moves it to doing", async () => {
  const { hub, agents, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  const state = card(`state:${item.id}`);
  const kill = card(`kill:${item.id}:2026-11-06`);
  const due = card(`due:${item.id}:2026-11-05T15:00:00.000Z`, "when");
  const inbox = card(`inbox:${item.id}`, "confirm");
  const doing = card(`doing:${item.id}`);
  const proposal = card(`proposal:${item.id}`, "dispatch");
  const when = card(`when-retry:${item.id}:1`, "when");
  await agents.dispatch(item.id, "work");
  for (const q of [wait, state, kill, due, inbox, doing, proposal, when]) {
    expect(status(q)).toBe("expired");
    expect(hub.store.question(q.id)!.answer).toBe("agent sent");
  }
  expect(hub.store.item(item.id)!.status).toBe("doing");
});

test("agent cards, other items' cards and other kinds stay open", async () => {
  const { hub, agents, item, card, status } = setup();
  const other = hub.createItem({ title: "Something else", kind: "task", status: "waiting" });
  const keep = [
    card(`agent:job_1:q1`, "open"),
    card(`after:job_1`, "open"),
    card(`restart:job_2`, "dispatch"),
    card(`post:${item.id}:idea`, "post"),
    card(`wait:${other.id}`, "state", other.id),
  ];
  await agents.dispatch(item.id, "work");
  for (const q of keep) expect(status(q)).toBe("open");
});

test("an agent's own question on a state-like key stays open", async () => {
  const { hub, agents, item, status } = setup();
  const q = hub.ask({
    kind: "open", itemId: item.id, key: `state:deploy-check`, badge: AGENT_ASKS, priority: 70, prompt: "Deploy now?",
    options: [{ id: "go", label: "Deploy", effect: { type: "dispatch", action: "work" } }],
  }) as Question;
  await agents.dispatch(item.id, "work");
  expect(status(q)).toBe("open");
});

test("a launch that throws before it starts leaves the cards open", async () => {
  const { agents, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  (agents as any).worktreeFor = async () => {
    throw new Error("git worktree add failed");
  };
  await expect(agents.dispatch(item.id, "work")).rejects.toThrow("git worktree add failed");
  expect(status(wait)).toBe("open");
});

const tick = () => new Promise((r) => setTimeout(r, 10));

test("a card whose note the reader is still reading stays open until the read is done, then closes", async () => {
  const { hub, agents, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  const other = card(`state:${item.id}`);
  let finish!: (d: any) => void;
  (agents as any).readNote = () => new Promise((r) => (finish = r));
  await hub.note(wait.id, "hang on, checking with Ravi");
  await agents.dispatch(item.id, "reply", undefined, "other card → Chase");
  expect(status(wait)).toBe("open");
  expect(status(other)).toBe("expired");
  // Background: the reader parks the card. The agent was sent meanwhile, so it closes now.
  finish({});
  await tick();
  expect(status(wait)).toBe("expired");
  expect(hub.store.question(wait.id)!.answer).toBe("agent sent");
});

test("two notes read at once on one card: it stays open until both are done", async () => {
  const { hub, agents, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  const finish: ((d: any) => void)[] = [];
  (agents as any).readNote = () => new Promise((r) => finish.push(r));
  await hub.note(wait.id, "hang on, checking with Ravi");
  await hub.note(wait.id, "and with Maryna");
  await agents.dispatch(item.id, "reply", undefined, "other card → Chase");
  finish[0]!({});
  await tick();
  expect(status(wait)).toBe("open");
  finish[1]!({});
  await tick();
  expect(status(wait)).toBe("expired");
});

test("verify doesn't close anything: it doesn't change what the item is", async () => {
  const { agents, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  await agents.dispatch(item.id, "verify");
  expect(status(wait)).toBe("open");
});

test("answering one card with a dispatch closes the item's other state cards, keeps the answer", async () => {
  const { hub, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  const state = card(`state:${item.id}`);
  await hub.answer(wait.id, "go");
  expect(status(wait)).toBe("answered");
  expect(hub.store.question(wait.id)!.answer).toBe("Chase them");
  expect(status(state)).toBe("expired");
});
