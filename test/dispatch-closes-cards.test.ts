import { expect, spyOn, test } from "bun:test";
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

// r3 leftovers of 0506138: a reader that fails after an agent was sent, a throw while handling it, a build that throws.

test("a reader that fails after a dispatch doesn't park the card or promise it back: it closes as 'agent sent'", async () => {
  const { hub, agents, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  let fail!: (e: Error) => void;
  (agents as any).readNote = () => new Promise((_, rej) => (fail = rej));
  const toasts: string[] = [];
  hub.subscribe((e: any) => e.type === "toast" && toasts.push(e.data.text));
  await hub.note(wait.id, "hang on, checking with Ravi");
  await agents.dispatch(item.id, "reply", undefined, "other card → Chase");
  fail(new Error("bad json"));
  await tick();
  expect(status(wait)).toBe("expired");
  expect(hub.store.question(wait.id)!.answer).toBe("agent sent");
  expect(toasts.some((t) => t.includes("Card back in 15 min"))).toBe(false);
  expect(toasts.some((t) => t.includes("Couldn't read that note (bad json). It's kept on the item; an agent is already on it, so the card is closed."))).toBe(true);
  expect(hub.store.journal().some((j: any) => j.text.includes("an agent is already on it, card closed"))).toBe(true);
  expect(JSON.stringify(hub.store.item(item.id)!.notes)).toContain("checking with Ravi");
});

test("a throw while handling a failed read still ends the read: the held close happens", async () => {
  const { hub, agents, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  let fail!: (e: Error) => void;
  (agents as any).readNote = () => new Promise((_, rej) => (fail = rej));
  await hub.note(wait.id, "hang on, checking with Ravi");
  await agents.dispatch(item.id, "reply", undefined, "other card → Chase");
  const toast = hub.toast.bind(hub);
  const logged = spyOn(console, "error").mockImplementation(() => {});
  let logs = 0;
  let calls: string[] = [];
  try {
    (hub as any).toast = () => {
      throw new Error("toast broke");
    };
    fail(new Error("bad json"));
    await tick();
    logs = logged.mock.calls.length;
    calls = logged.mock.calls.map((c) => String(c[0]));
  } finally {
    (hub as any).toast = toast;
    logged.mockRestore();
  }
  expect(status(wait)).toBe("expired");
  expect((hub as any).reading.size).toBe(0);
  expect(logs).toBeGreaterThan(0);
  expect(calls.some((c) => c.includes(`note read on ${wait.id}`))).toBe(true);
  expect(hub.store.journal().some((j: any) => j.text.includes("Couldn't act on note (toast broke)"))).toBe(true);
});

test("a read that returns no decision after a dispatch still ends: the held close happens", async () => {
  const { hub, agents, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  let finish!: (d: any) => void;
  (agents as any).readNote = () => new Promise((r) => (finish = r));
  await hub.note(wait.id, "hang on, checking with Ravi");
  await agents.dispatch(item.id, "reply", undefined, "other card → Chase");
  finish(undefined);
  await tick();
  expect(status(wait)).toBe("expired");
  expect(hub.store.question(wait.id)!.answer).toBe("agent sent");
  expect((hub as any).reading.size).toBe(0);
});

test("a build that throws fails the job and gives the item back, so a retry dispatches again", async () => {
  const { hub, agents, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  const build = (agents as any).worktreeFor.bind(agents);
  (agents as any).worktreeFor = async () => {
    throw new Error("git worktree add failed");
  };
  await expect(agents.dispatch(item.id, "work")).rejects.toThrow("git worktree add failed");
  const failed = hub.store.jobs().filter((j) => j.itemId === item.id);
  expect(failed.map((j) => j.status)).toEqual(["failed"]);
  expect(failed[0]!.error).toContain("git worktree add failed");
  expect(hub.store.item(item.id)!.status).toBe("waiting");
  expect(status(wait)).toBe("open");
  (agents as any).worktreeFor = build;
  const again = await agents.dispatch(item.id, "work");
  expect(again!.id).not.toBe(failed[0]!.id);
  expect(again!.status).toBe("queued");
});

test("a build that throws while another agent is on the item leaves the item in doing", async () => {
  const { hub, agents, item } = setup();
  await agents.dispatch(item.id, "reply", undefined, "first → Chase");
  (agents as any).worktreeFor = async () => {
    throw new Error("git worktree add failed");
  };
  await expect(agents.dispatch(item.id, "work", undefined, "second → Do it")).rejects.toThrow("git worktree add failed");
  expect(hub.store.item(item.id)!.status).toBe("doing");
});

test("a build that throws with only a verify live gives the item back", async () => {
  const { hub, agents, item } = setup();
  await agents.dispatch(item.id, "verify");
  (agents as any).worktreeFor = async () => {
    throw new Error("git worktree add failed");
  };
  await expect(agents.dispatch(item.id, "work")).rejects.toThrow("git worktree add failed");
  expect(hub.store.item(item.id)!.status).toBe("waiting");
});

test("stopped while it builds: stays cancelled, cards stay open, item given back, nothing launches", async () => {
  const { hub, agents, item, card, status } = setup();
  const wait = card(`wait:${item.id}`);
  let build!: () => void;
  (agents as any).worktreeFor = () => new Promise<undefined>((r) => (build = () => r(undefined)));
  let launched = false;
  (agents as any).launchAction = async () => {
    launched = true;
  };
  const p = agents.dispatch(item.id, "work");
  await tick();
  const job = hub.store.jobs().find((j) => j.itemId === item.id)!;
  agents.cancel(job.id);
  build();
  await p;
  expect(hub.store.job(job.id)!.error).toBe("cancelled");
  expect(status(wait)).toBe("open");
  expect(hub.store.item(item.id)!.status).toBe("waiting");
  expect(launched).toBe(false);
});

test("stopped while it builds, then the build throws: the job keeps 'cancelled'", async () => {
  const { hub, agents, item } = setup();
  let fail!: (e: Error) => void;
  (agents as any).worktreeFor = () => new Promise((_, rej) => (fail = rej));
  const p = agents.dispatch(item.id, "work");
  await tick();
  const job = hub.store.jobs().find((j) => j.itemId === item.id)!;
  agents.cancel(job.id);
  fail(new Error("git worktree add failed"));
  await expect(p).rejects.toThrow("git worktree add failed");
  expect(hub.store.job(job.id)!.error).toBe("cancelled");
});
