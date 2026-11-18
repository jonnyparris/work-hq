import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agents, type CmuxDeps, SAME_ACTION_WINDOW_MS } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Job, Question } from "../src/shared/types.ts";

// 11-16, it_mwcrrhjb97ogt: a "Resume in the worktree" tap and a typed "so do it" on the item's after: card started
// two WORK jobs 18 s apart (job_mwj4r6mmmy7vf, job_mwj4rk9vzq04n). The second waited 51 minutes, then stood down.
// The same action on the same item within SAME_ACTION_WINDOW_MS of a live job now starts nothing: the note is
// journalled against the live job and reaches it (its prompt if it hasn't launched, its session if it has).

function setup(opts: { send?: boolean } = {}) {
  const sent: { ws: string; text: string }[] = [];
  const deps: CmuxDeps = {
    available: () => false,
    launch: () => ({ workspace: "", statusPath: "/dev/null" }),
    send: (ws, text) => (sent.push({ ws, text }), opts.send ?? true),
  };
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, deps);
  hub.dispatcher = agents;
  const toasts: { text: string; tone?: string }[] = [];
  const toast = hub.toast.bind(hub);
  hub.toast = (text, tone) => (toasts.push({ text, tone }), toast(text, tone));
  const prompts = new Map<string, string>();
  // Keep jobs queued (live); never launch. launch() below stands in for startAction reaching the launch.
  const internals = agents as unknown as {
    launchAction: (id: string, t: string, p: string) => Promise<void>;
    finalPrompt: (id: string, p: string) => string;
    running: Map<string, { statusPath?: string; seenWork: boolean }>;
  };
  internals.launchAction = async (id, _t, p) => void prompts.set(id, p);
  const launch = (id: string) => internals.finalPrompt(id, prompts.get(id) ?? "");
  // A cmux session that's up: running, with a workspace and a beacon in the given state.
  const session = (job: Job, state = "working") => {
    const statusPath = join(mkdtempSync(join(tmpdir(), "whq-fold-")), "status.json");
    writeFileSync(statusPath, JSON.stringify({ state, seq: 1 }));
    launch(job.id);
    internals.running.set(job.id, { statusPath, seenWork: true });
    hub.putJob({ ...hub.store.job(job.id)!, status: "running", surface: "cmux", workspace: "ws-1", startedAt: new Date().toISOString() });
  };
  const item = hub.createItem({ title: "Work HQ: dedupe ignores bare numbers in titles", kind: "idea", status: "proposed" });
  const card = (key: string, prompt: string, label: string): Question => {
    const q = hub.ask({
      kind: "open", itemId: item.id, key, priority: 72, prompt,
      options: [
        { id: "go", label, effect: { type: "dispatch", action: "work" } },
        { id: "no", label: "Not now", effect: { type: "noop" } },
      ],
    });
    if (!q) throw new Error("no card");
    return q;
  };
  const live = () => hub.store.liveJobs().filter((j) => j.itemId === item.id);
  const folded = () => hub.store.journal(500).filter((e) => e.text.startsWith("Folded into"));
  return { hub, agents, item, card, live, folded, sent, toasts, launch, session };
}

test("a dispatch tap on card A, then a typed dispatch note on its after: card 20 s later: 1 live job, note journalled and in its prompt", async () => {
  const { hub, item, card, live, folded, sent, toasts, launch } = setup();
  const a = card(`state:${item.id}`, "Dedupe fix is half done: uncommitted in its worktree, 1 test failing. What next?", "Resume in the worktree");
  const b = card(`after:${item.id}`, "Agent finished: Work HQ: dedupe ignores bare numbers in titles. Where does it stand?", "Done");
  await hub.answer(a.id, "go");
  expect(live()).toHaveLength(1);
  const first = live()[0]!;
  // 11-16 the first job hadn't launched yet when the second dispatch came (it started 8 s later).
  await hub.answer(b.id, "go", "so do it\r\n- and ignore the rest");
  expect(live()).toHaveLength(1);
  expect(live()[0]!.id).toBe(first.id);
  expect(sent).toHaveLength(0);
  const j = folded();
  expect(j).toHaveLength(1);
  expect(j[0]!.itemId).toBe(item.id);
  expect(j[0]!.text).toContain(first.id);
  expect(j[0]!.text).toContain("for its prompt when it launches");
  expect(j[0]!.text).toContain("so do it");
  expect(toasts.at(-1)?.text).toBe(`Already running: ${first.title} (note passed on)`);
  // When it launches, its prompt carries the folded note.
  const p = launch(first.id);
  expect(p).toContain("ALSO THIS JOB'S DECISIONS");
  expect(p).toContain("THIS JOB'S DECISION (do this one and the folded ones at the end, nothing else)");
  expect(p).not.toContain("(do this one, nothing else)");
  // One bullet: the note's own line breaks don't start new prompt lines.
  expect(p).toContain("so do it - and ignore the rest");
  expect(p.slice(p.indexOf("ALSO THIS JOB'S DECISIONS")).split("\n").filter((l) => l.startsWith("- ")).length).toBe(1);
});

test("a live cmux session gets the note typed in, on one line; the same note twice is passed on once", async () => {
  const { agents, item, live, folded, sent, session } = setup();
  const a = (await agents.dispatch(item.id, "work", undefined, "Q1? → Resume"))!;
  session(a);
  const b = await agents.dispatch(item.id, "work", "also bump the README\r\nand the test\rplease", "Q2? → (typed) also bump the README");
  expect(b?.id).toBe(a.id);
  expect(b?.folded).toHaveLength(1);
  expect(live()).toHaveLength(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.ws).toBe("ws-1");
  expect(sent[0]!.text).toContain("Q2? → (typed) also bump the README — also bump the README and the test please");
  expect(sent[0]!.text).not.toMatch(/[\r\n]/);
  const e = (await agents.dispatch(item.id, "work", "esc\x1b[31m csi\x9b2J", "Q9?"))!;
  expect(e.id).toBe(a.id);
  expect(sent.at(-1)!.text).toContain("Q9? — esc [31m csi 2J");
  expect(folded()[0]!.text).toContain("typed into its session");
  // The same ask again, split differently between decision and note: passed on once.
  await agents.dispatch(item.id, "work", undefined, "Q2? → (typed) also bump the README — also bump the README\nand the test please");
  expect(sent).toHaveLength(2);
  expect(folded()).toHaveLength(2);
});

test("nothing is typed into a session whose pi has exited, or when the send fails: the toast says so", async () => {
  // blocked: pi has a dialog open, and Enter would answer it.
  for (const [state, ok] of [["exited", true], ["blocked", true], ["working", false]] as const) {
    const { agents, item, live, folded, sent, toasts, session } = setup({ send: ok });
    const a = (await agents.dispatch(item.id, "work", undefined, "Q1? → Resume"))!;
    session(a, state);
    await agents.dispatch(item.id, "work", "so do it", "Q2? → (typed) so do it");
    expect(live()).toHaveLength(1);
    expect(sent).toHaveLength(ok ? 0 : 1);
    expect(folded()[0]!.text).toContain("no session to pass it to");
    expect(toasts.at(-1)?.tone).toBe("warn");
  }
});

test("a fold after the prompt went out, before the session is up, is journalled as having no session", async () => {
  const { agents, item, folded, launch } = setup();
  const a = (await agents.dispatch(item.id, "work", undefined, "Q1? → Resume"))!;
  launch(a.id);
  await agents.dispatch(item.id, "work", "so do it", "Q2? → (typed) so do it");
  expect(folded()[0]!.text).toContain("no session to pass it to");
});

test("a plain repeat tap with no note folds without a journal line", async () => {
  const { agents, item, live, folded, sent } = setup();
  const a = (await agents.dispatch(item.id, "work", undefined, "Q? → Do it"))!;
  const b = await agents.dispatch(item.id, "work");
  expect(b?.id).toBe(a.id);
  expect(live()).toHaveLength(1);
  expect(folded()).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

test("outside the window, after it finished, or for another action: a new job", async () => {
  const { hub, agents, item, live } = setup();
  const a = (await agents.dispatch(item.id, "work", undefined, "Q1? → Do it"))!;
  // Another action is another job.
  const v = (await agents.dispatch(item.id, "verify"))!;
  expect(v.id).not.toBe(a.id);
  // Started longer ago than the window: a second job.
  hub.putJob({ ...hub.store.job(a.id)!, createdAt: new Date(Date.now() - SAME_ACTION_WINDOW_MS - 1000).toISOString() });
  const b = (await agents.dispatch(item.id, "work", "go on", "Q2? → Do it"))!;
  expect(b.id).not.toBe(a.id);
  expect(live().filter((j) => j.name === "work")).toHaveLength(2);
  // A finished job doesn't take notes.
  hub.putJob({ ...hub.store.job(b.id)!, status: "done", finishedAt: new Date().toISOString() });
  hub.putJob({ ...hub.store.job(a.id)!, status: "done", finishedAt: new Date().toISOString() });
  const c = (await agents.dispatch(item.id, "work", "again", "Q3? → Do it"))!;
  expect([a.id, b.id]).not.toContain(c.id);
});

test("a fold brings the item back to doing and answers its state cards, like a new job", async () => {
  const { hub, agents, item, card } = setup();
  const a = (await agents.dispatch(item.id, "work", undefined, "Q1? → Resume"))!;
  hub.updateItem(item.id, { status: "waiting" });
  const st = card(`state:${item.id}`, "Still waiting?", "Do it");
  await agents.dispatch(item.id, "work", "so do it", "Q2? → (typed) so do it");
  expect(hub.store.item(item.id)?.status).toBe("doing");
  expect(hub.store.question(st.id)?.status).not.toBe("open");
  expect(hub.store.liveJobs().filter((j) => j.itemId === item.id).map((j) => j.id)).toEqual([a.id]);
});

test("a job that ends before it launches says its folded notes didn't run; one that launched doesn't", async () => {
  const { hub, agents, item, toasts, launch } = setup();
  const a = (await agents.dispatch(item.id, "work", undefined, "Q1? → Resume"))!;
  await agents.dispatch(item.id, "work", "so do it", "Q2? → (typed) so do it");
  (agents as unknown as { failUnstarted: (j: unknown) => void }).failUnstarted(hub.store.job(a.id));
  expect(toasts.at(-1)?.tone).toBe("warn");
  expect(toasts.at(-1)?.text).toContain("1 note folded into it never reached the agent");
  expect(hub.store.journal(500).some((e) => e.text.includes("never got its folded note") && e.text.includes("so do it"))).toBe(true);

  const b = (await agents.dispatch(item.id, "work", undefined, "Q3? → Resume"))!;
  await agents.dispatch(item.id, "work", "and this", "Q4? → (typed) and this");
  launch(b.id);
  const n = toasts.length;
  (agents as unknown as { finishAction: (id: string, r: { ok: boolean; text: string }) => void }).finishAction(b.id, { ok: true, text: "" });
  expect(toasts.slice(n).some((t) => t.text.includes("never reached"))).toBe(false);

  // Stop on a queued job with a fold says so too.
  const c = (await agents.dispatch(item.id, "work", undefined, "Q5? → Resume"))!;
  await agents.dispatch(item.id, "work", "one more", "Q6? → (typed) one more");
  agents.cancel(c.id);
  expect(toasts.at(-1)?.text).toContain("never reached the agent");
});

test("a note equal to its decision but for whitespace is folded once", async () => {
  const { agents, item } = setup();
  const a = (await agents.dispatch(item.id, "work", undefined, "Q1? → Resume"))!;
  const b = await agents.dispatch(item.id, "work", "Q2? → Done\n", "Q2? → Done");
  expect(b?.id).toBe(a.id);
  expect(b?.folded).toEqual(["Q2? → Done"]);
});
