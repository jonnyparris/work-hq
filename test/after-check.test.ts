import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { stoppedJobNote, transcriptSearch } from "../src/server/prompts.ts";
import type { Item, Job } from "../src/shared/types.ts";

// 10-29: "Agent stopped" cards asked the owner where it stood, with no way to tell once the session was pruned.
// They now offer "Check for me": a verify agent pointed at the job's transcript, job folder and worktree branch.

const noCmux: CmuxDeps = { available: () => false, launch: () => undefined, bootWaitMs: 10, bootRetryMs: 5 };

function setup(id: string, status: Job["status"]) {
  const hub = new Hub(new Store(":memory:"));
  const item: Item = { id: `it_${id}`, kind: "idea", status: "doing", title: "Fix the thing", source: { type: "manual" }, createdAt: "", updatedAt: "" };
  hub.store.putItem(item);
  const job: Job = { id: `job_${id}`, kind: "action", name: "work", title: "Work · Fix the thing", surface: "headless", status, itemId: item.id, tail: [], createdAt: new Date().toISOString() };
  hub.store.putJob(job);
  return { hub, item, job };
}

test("a stopped job's after-card offers a verify agent that knows where to look", () => {
  const { hub, job } = setup("a", "running");
  new Agents(hub, noCmux); // boot fails the headless job mid-run and asks where it stands
  const q = hub.store.questions("open").find((x) => x.key === `after:${job.id}`)!;
  const check = q.options.find((o) => o.id === "check")!;
  expect(check.label).toBe("Check for me");
  expect(check.effect.type).toBe("dispatch");
  if (check.effect.type !== "dispatch") return;
  expect(check.effect.action).toBe("verify");
  expect(check.effect.note).toContain(transcriptSearch(job.id));
  expect(check.effect.note).toContain(`jobs/${job.id}`);
  expect(check.effect.note).toContain("server restarted mid-run");
  expect(q.options.some((o) => o.id === "look")).toBe(false); // headless: no session to show
});

test("the transcript search finds the stopped job's session, not later ones naming it, in an awkward dir", () => {
  const root = mkdtempSync(resolve(tmpdir(), "whq-"));
  const sessions = resolve(root, "it's pi agent", "sessions");
  mkdirSync(resolve(sessions, "--a--"), { recursive: true });
  mkdirSync(resolve(sessions, "--b--"), { recursive: true });
  const stopped = resolve(sessions, "--b--", "2026-10-29T10-00-00-000Z_aaa.jsonl");
  writeFileSync(stopped, "Read /s/jobs/job_a/prompt.md and follow the instructions\n");
  writeFileSync(resolve(sessions, "--a--", "2026-10-29T09-00-00-000Z_old.jsonl"), "an older session about job_b\n");
  // Two later verify sessions quote the command, one in another cwd folder. Both newer by mtime too.
  writeFileSync(resolve(sessions, "--a--", "2026-10-29T11-00-00-000Z_bbb.jsonl"), "grep -rlF 'jobs/job_a/prompt.md and follow'\n");
  writeFileSync(resolve(sessions, "--b--", "2026-10-29T12-00-00-000Z_ccc.jsonl"), "grep -rlF 'jobs/job_a/prompt.md and follow'\n");
  utimesSync(stopped, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const out = Bun.spawnSync(["bash", "-c", transcriptSearch("job_a", sessions)]);
  expect(out.stderr.toString()).toBe("");
  expect(out.stdout.toString().trim()).toBe(stopped);
  // No sessions dir yet: empty, and quiet.
  const none = Bun.spawnSync(["bash", "-c", transcriptSearch("job_a", resolve(root, "nope"))]);
  expect(none.stdout.toString() + none.stderr.toString()).toBe("");
}, 30_000);

test("a headless job's recorded session is named outright, no search", () => {
  const note = stoppedJobNote({ id: "job_h", title: "T", status: "failed", session: "/x/sessions/--c--/2026-10-29T10-00-00-000Z_h.jsonl" });
  expect(note).toContain("transcript: /x/sessions/--c--/2026-10-29T10-00-00-000Z_h.jsonl");
  expect(note).not.toContain("grep -rlF");
  // The print runner records a uuid, not a path: search instead.
  expect(stoppedJobNote({ id: "job_p", title: "T", status: "failed", session: "0199-uuid" })).toContain(transcriptSearch("job_p"));
});

test("the transcript search honours PI_CODING_AGENT_DIR", () => {
  const was = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/pi agent";
  try {
    const note = stoppedJobNote({ id: "job_x", title: "T", status: "failed" });
    expect(note).toContain(transcriptSearch("job_x", "/tmp/pi agent/sessions"));
  } finally {
    if (was === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = was;
  }
});

test("tapping Check for me sends verify with the note and closes the card", async () => {
  const { hub, item, job } = setup("c", "running");
  new Agents(hub, noCmux);
  const sent: Array<{ itemId: string; action: string; note?: string }> = [];
  hub.dispatcher = { dispatch: async (itemId, action, note) => (sent.push({ itemId, action, note }), undefined), scheduleFromWords: async () => {} };
  const q = hub.store.questions("open").find((x) => x.key === `after:${job.id}`)!;
  await hub.answer(q.id, "check");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.itemId).toBe(item.id);
  expect(sent[0]!.action).toBe("verify");
  expect(sent[0]!.note).toContain(job.id);
  expect(hub.store.question(q.id)!.status).not.toBe("open");
});

test("an after-card drawn before the option existed gets it at boot, before Show me the session, once", () => {
  const { hub, item, job } = setup("b", "failed");
  hub.ask({
    kind: "state",
    itemId: item.id,
    key: `after:${job.id}`,
    priority: 75,
    prompt: "Agent stopped: Fix the thing. Where does it stand?",
    options: [
      { id: "done", label: "Done", effect: { type: "status", status: "done" } },
      { id: "look", label: "Show me the session", effect: { type: "focusSession", keep: true } },
    ],
  });
  new Agents(hub, noCmux);
  new Agents(hub, noCmux);
  const q = hub.store.questions("open").find((x) => x.key === `after:${job.id}`)!;
  expect(q.options.map((o) => o.id)).toEqual(["done", "check", "look"]);
});
