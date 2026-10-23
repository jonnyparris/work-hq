// Everything that runs pi. Three shapes:
//   sweep   — headless, read-only, scheduled (transcripts, calendar). Streams into the dashboard.
//   triage  — headless, no tools, fast. Turns the owner's words into state changes.
//   action  — interactive pi in a cmux workspace. Anything the owner dispatches. Highly visible.

import { type BulkRequest, deferHorizon } from "../shared/batch.ts";
import { claimsDispatch } from "../shared/dead-button.ts";
import { explainKey, sentences } from "../shared/detail.ts";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import type { ActionKind, AgentReport, Item, Job, JobKind, NoteDecision } from "../shared/types.ts";
import * as cmux from "./cmux.ts";
import { config } from "./config.ts";
import { newId, nowIso } from "./db.ts";
import { type DemoScript, demoActionScript, demoSweepScript, feedLine } from "./demo.ts";
import { type Dispatcher, type Hub, isCrash, queuedNote } from "./hub.ts";
import { GatewayToken } from "./gateway-token.ts";
import { backoffMs, isRateLimited, LaunchGate, RunCap } from "./launch-gate.ts";
import { overloaded } from "./load.ts";
import { assertShortArgs, PiPool, PiRpc, piStamp, type RunOutcome } from "./pi-rpc.ts";
import {
  actionPrompt, calendarPrompt, calendarSweepPrompt, explainPrompt, notePrompt, openUrl, postSweepPrompt, schedulePrompt, SITE_LINK, SITE_POSTS,
  transcriptSweepPrompt, triagePrompt, WIKI_DRAFTS,
} from "./prompts.ts";
import { cleanupWorktree, createWorktree, repoFor, type WorktreeResult } from "./worktrees.ts";

const modelArgs = () => (config.pi.model ? ["--model", config.pi.model] : []);
const backoff = () => backoffMs({ minSec: config.pi.rateLimitBackoffSec[0] ?? 60, maxSec: config.pi.rateLimitBackoffSec[1] ?? 90 });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Tool-less triage: no tools, no context files, skills or prompt templates, no session file. */
const TRIAGE_FLAGS = ["-nt", "-nc", "-ns", "-np", "--no-session"];
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
/** How long a cmux turn that ended on a model error gets to recover (new turn or report) before the job fails. */
export const ERROR_GRACE_MS = 180_000;
/** A cmux session only gets the shared gateway token if it has at least this long left (see GatewayToken.env). */
export const CMUX_TOKEN_TTL_MS = 24 * 3600_000;
const RESUME_NUDGE = "Your last request failed on a provider rate limit. Carry on from where you stopped.";

/** `slept`: ms the laptop slept mid-run (rpc runner). A failure after a sleep gets rerun, not counted as a stall. */
type RunResult = { ok: boolean; text: string; error?: string; session?: string; toolsRan?: boolean; slept?: number };

interface Running {
  statusPath?: string;
  seenWork: boolean;
  proc?: ReturnType<typeof spawn>;
  /** rpc runner: abort this run (and stop its process if it's not a shared worker). */
  cancel?: () => void;
  /** cmux: rate-limit nudges sent so far, and the pending one (if any). */
  rateRetries?: number;
  retry?: { at: number; seq: number; sent?: number };
  /** cmux: the turn ended on a model error at this beacon seq. pi keeps the session, so wait for it to recover or report. */
  errored?: { at: number; seq: number };
  /** cmux: last settled turn (beacon seq) already passed to noteGateway. */
  gatewaySeq?: number;
}

export interface TriageResult {
  reply?: string;
  items?: Array<Partial<Item> & { title: string }>;
  updates?: Array<{ id: string; note?: string } & Partial<Item>>;
  dispatch?: Array<{ id: string; action: ActionKind; note?: string }>;
  journal?: string[];
  question?: { prompt: string; options?: string[] } | null;
  calendar?: Array<{ id: string; start: string; durationMin?: number }>;
  bulk?: BulkRequest[];
}

interface PostIdea {
  id?: string;
  title: string;
  slug?: string;
  venue?: "wiki" | "site" | "both";
  why?: string;
  gap?: string;
  angle?: string;
  evidence?: string[];
  wikiDraft?: string;
  siteDraft?: string;
}


export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "post";
}

export function extractJson<T = any>(text: string): T | undefined {
  const tries = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) tries.push(fence[1]!.trim());
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      return JSON.parse(t) as T;
    } catch {}
  }
  return undefined;
}

/** The cmux seams, swappable in tests (a real ping/launch would reach the owner's cmux). */
export interface CmuxDeps {
  available(): boolean;
  launch: typeof cmux.launchInCmux;
}
const realCmux: CmuxDeps = { available: () => Boolean(config.cmux.bin) && cmux.cmuxAvailable(), launch: cmux.launchInCmux };

/** Prompt saved at dispatch, so a restart while the job waits on the launch gate can still launch it. */
const promptFile = (jobId: string) => resolve(cmux.jobDir(jobId), "prompt.md");
/** The owner's words for a triage job, so a restart mid-triage can still offer them back. */
const triageFile = (jobId: string) => resolve(cmux.jobDir(jobId), "triage.json");
type TriageMode = "chat" | "pineapple" | "review";

export class Agents implements Dispatcher {
  private running = new Map<string, Running>();
  /** Every pi launch goes through here, so bursts can't trip per-minute provider limits. */
  readonly gate = new LaunchGate(() => config.pi.launchSpacingSec * 1000);
  /** At most `pi.maxRunningJobs` action jobs working at once, none while load > `pi.maxLoad`; the rest wait as "queued". */
  readonly cap = new RunCap(
    () => config.pi.maxRunningJobs,
    () => this.runningActions(),
    () => overloaded(config.pi.maxLoad, this.readLoad),
  );
  /** os.loadavg, swappable in tests. */
  readLoad: () => number[] = loadavg;

  /** Action jobs holding a slot. A headless run waiting out a rate limit sits at "queued" with a startedAt: it keeps its slot for the retry. */
  runningActions() {
    return this.hub.store.liveJobs().filter((j) => j.kind === "action" && (j.status === "running" || (j.status === "queued" && j.startedAt))).length;
  }

  constructor(private hub: Hub, private cmuxDeps: CmuxDeps = realCmux) {
    hub.dispatcher = this;
    ensureSiteLink();
    // Pick up jobs that were live when the server restarted. Every live job, oldest first, so queued cmux
    // launches rejoin the cap queue in their old order (a recent-100 window could strand an old one).
    for (const job of hub.store.liveJobs().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (job.surface === "cmux" && job.status === "queued" && !job.workspace) {
        // Was waiting on the launch gate; never started, so it's safe to launch again.
        this.relaunchUnstarted(job);
      } else if (job.surface === "cmux" && ["running", "blocked", "queued"].includes(job.status)) {
        this.running.set(job.id, { statusPath: resolve(cmux.jobDir(job.id), "status.json"), seenWork: true });
      } else if (job.surface === "headless" && job.kind === "action" && ["running", "queued"].includes(job.status)) {
        // Same path as any stopped action: fail the job and, if the item is still on `doing`, ask where it stands.
        this.finishAction(job.id, { ok: false, text: "", error: "server restarted mid-run" });
      } else if (job.surface === "headless" && ["running", "queued"].includes(job.status)) {
        hub.putJob({ ...job, status: "failed", error: "server restarted mid-run", finishedAt: nowIso() });
        if (job.kind === "triage") this.reaskTriage(job.id, "server restarted mid-run");
      }
    }
  }

  /**
   * A cmux job a restart caught on the launch gate. Put it back on the gate with the prompt
   * saved at dispatch. If that can't work (no cmux, no saved prompt, item gone, demo), fail it
   * and hand the item back with a card to send it again — never leave the item stuck on `doing`.
   */
  private relaunchUnstarted(job: Job) {
    const item = job.itemId ? this.hub.store.item(job.itemId) : undefined;
    const prompt = existsSync(promptFile(job.id)) ? readFileSync(promptFile(job.id), "utf8") : undefined;
    if (item && prompt && job.kind === "action" && !config.demo && this.cmuxDeps.available()) {
      this.hub.putJob({ ...job, tail: [...job.tail, "▸ server restarted before launch — queued again"].slice(-12) });
      void this.launchAction(job.id, job.title, prompt, true);
      return;
    }
    this.hub.putJob({ ...job, status: "failed", error: "server restarted before launch", finishedAt: nowIso() });
    if (!item || job.kind !== "action") return;
    if (item.status === "doing") this.hub.updateItem(item.id, { status: "proposed" });
    const action = job.name as ActionKind;
    this.hub.ask({
      kind: "dispatch",
      itemId: item.id,
      key: `restart:${job.id}`,
      badge: "Didn't run",
      priority: 80,
      prompt: `Restart killed this before it ran: ${item.title}. Send it again?`,
      context: `The server restarted while "${ACTION_LABEL[action] ?? action}" was waiting to launch.`,
      options: [
        { id: "again", label: "Send it again", tone: "primary", effect: { type: "dispatch", action } },
        { id: "later", label: "Not now", tone: "quiet", effect: { type: "noop" } },
      ],
    });
  }

  private newJob(kind: JobKind, name: string, title: string, surface: Job["surface"], itemId?: string, extra: Partial<Job> = {}): Job {
    return this.hub.putJob({ id: newId("job"), kind, name, title, surface, status: "queued", itemId, tail: [], createdAt: nowIso(), ...extra });
  }

  private patch(id: string, p: Partial<Job>) {
    const cur = this.hub.store.job(id);
    if (!cur) return;
    const out = this.hub.putJob({ ...cur, ...p });
    // A job left "running" (finished, failed, blocked, cancelled) or a waiter was cancelled: a queued launch may go now.
    if (p.status && p.status !== cur.status && (cur.status === "running" || cur.status === "queued")) this.cap.pump();
    return out;
  }

  private line(id: string, text: string) {
    const cur = this.hub.store.job(id);
    if (cur) this.hub.putJob({ ...cur, tail: [...cur.tail, text].slice(-12) });
  }

  // ── actions (cmux) ─────────────────────────────────────────────────────
  async dispatch(itemId: string, action: ActionKind, note?: string, decision?: string) {
    const item = this.hub.store.item(itemId);
    if (!item) return undefined;
    const title = `${ACTION_LABEL[action]} · ${item.title}`.slice(0, 80);
    // Other agents already on this item. The same action for the same answer is a double dispatch
    // (a double tap, a note read twice): hand back the job that's already going instead of a second one.
    const siblings = this.hub.store.liveJobs().filter((j) => j.kind === "action" && j.itemId === itemId);
    const same = siblings.find((j) => j.name === action && (j.decision ?? "") === (decision ?? "") && (j.note ?? "") === (note ?? ""));
    if (same) {
      this.hub.toast(`Already running: ${same.title}`, "info");
      return same;
    }
    const useCmux = this.cmuxDeps.available();
    const job = this.newJob("action", action, title, useCmux ? "cmux" : "headless", itemId, { decision, note });
    // Verifying doesn't change what the item *is*; everything else means someone's on it.
    if (action !== "verify") this.hub.updateItem(itemId, { status: "doing" });
    if (config.demo) {
      void this.launchDemoAction(job.id, title, demoActionScript(item, action, note), useCmux);
      return this.hub.store.job(job.id);
    }
    // Jobs on other items from the same source (a parent and its child item, one meeting doc): 10-22 a parent and
    // child item with the same source.url ran the same Dodo createAI work twice, because neither saw the other.
    const url = item.source.url;
    const related = url
      ? this.hub.store.liveJobs().filter((j) => j.kind === "action" && j.id !== job.id && j.itemId && j.itemId !== itemId && this.hub.store.item(j.itemId)?.source.url === url)
      : [];
    const prompt = actionPrompt(job.id, item, action, note, await this.worktreeFor(job.id, item, action), {
      decision,
      siblings: [
        ...siblings.map((j) => ({ id: j.id, action: j.name, decision: j.decision ?? j.note })),
        ...related.map((j) => ({ id: j.id, action: j.name, decision: j.decision ?? j.note, item: this.hub.store.item(j.itemId!)?.title ?? "" })),
      ],
    });
    if (useCmux) writeFileSync(promptFile(job.id), prompt);
    // Launch in the background: the gate may hold it for a while and callers shouldn't wait.
    void this.launchAction(job.id, title, prompt, useCmux);
    return this.hub.store.job(job.id);
  }

  /** Work on a shared repo (config `repos`) gets its own worktree before launch, so the agent can't commit in the main checkout. */
  private async worktreeFor(jobId: string, item: Item, action: ActionKind): Promise<WorktreeResult | undefined> {
    const rule = repoFor(item, action);
    if (!rule) return undefined;
    const wt = await createWorktree(rule, jobId);
    this.line(jobId, "error" in wt ? `⚠ worktree: ${wt.error}` : `▸ worktree ${wt.dir}`);
    return wt;
  }

  private async launchAction(jobId: string, title: string, prompt: string, useCmux: boolean) {
    const queued = () => this.hub.store.job(jobId)?.status === "queued";
    if (this.cap.full()) {
      const ahead = this.cap.waiting;
      if (this.cap.blocker() === "load") {
        const l1 = (this.readLoad()[0] ?? 0).toFixed(1);
        this.line(jobId, `⏳ holding: load ${l1} is above ${config.pi.maxLoad} (pi.maxLoad), ${ahead} ahead`);
        this.hub.toast(`Queued: ${title} — load ${l1}, holding launches above ${config.pi.maxLoad}`, "info");
      } else {
        const max = config.pi.maxRunningJobs;
        this.line(jobId, `⏳ waiting for a slot: ${max} agents running (cap ${max}), ${ahead} ahead`);
        this.hub.toast(`Queued: ${title} — ${max} agents already running`, "info");
      }
    }
    const release = await this.cap.acquire(queued);
    if (!release) return; // cancelled while waiting for a slot
    try {
      await this.startAction(jobId, title, prompt, useCmux);
    } catch (e) {
      this.finishAction(jobId, { ok: false, text: "", error: `launch failed: ${(e as Error).message}` });
    } finally {
      release();
    }
  }

  /** Resolves once the job is running (or has failed to launch); a headless run carries on in the background. */
  private async startAction(jobId: string, title: string, prompt: string, useCmux: boolean) {
    if (useCmux) {
      const wait = this.gate.wait();
      if (wait > 0) {
        this.line(jobId, `⏳ queued ${Math.ceil(wait / 1000)} s — spacing launches`);
        this.hub.toast(`Queued: ${title} — launching in ${Math.ceil(wait / 1000)} s`, "info");
      }
      await this.gate.acquire();
      if (this.hub.store.job(jobId)?.status !== "queued") return; // cancelled while waiting
      const launched = this.cmuxDeps.launch({
        jobId: jobId,
        title,
        prompt,
        cwd: config.workspace.dir,
        piArgs: [...modelArgs(), "-n", `work-hq: ${title}`],
        // The shared gateway token, as headless runs get it: no per-run key mint, and a lapsed login shows up
        // here as one auth error. Only a token with a day left — the session can stay open for hours.
        env: await this.token.env(Date.now(), CMUX_TOKEN_TTL_MS),
      });
      if (launched) {
        this.running.set(jobId, { statusPath: launched.statusPath, seenWork: false });
        this.hub.toast(`Dispatched to cmux: ${title}`, "good");
        return this.patch(jobId, { status: "running", workspace: launched.workspace, startedAt: nowIso(), tail: ["▸ launched in cmux · Work HQ group"] });
      }
      this.line(jobId, "cmux launch failed — falling back to headless");
    }
    // No cmux: run headless with full tools. Still visible in the dashboard feed.
    // Don't hold the reservation for the whole run: once runHeadless marks the job running, the store counts it.
    let settled = false;
    void this.runHeadless(jobId, prompt, { tools: true, thinking: "medium", perms: false, timeoutMin: 45 })
      .then((r) => this.finishAction(jobId, r))
      .catch((e) => this.finishAction(jobId, { ok: false, text: "", error: (e as Error).message }))
      .finally(() => (settled = true));
    while (!settled && this.hub.store.job(jobId)?.status === "queued") await sleep(100);
  }

  // ── demo mode: scripted runs that look real and reach nothing ───────────
  private async launchDemoAction(jobId: string, title: string, script: DemoScript, useCmux: boolean) {
    if (useCmux) {
      const dir = cmux.jobDir(jobId);
      const scriptPath = resolve(dir, "demo-script.json");
      writeFileSync(scriptPath, JSON.stringify({ ...script, title }));
      const launched = cmux.launchInCmux({
        jobId, title, prompt: `(demo) ${title}`, cwd: config.workspace.dir, piArgs: [],
        command: [process.execPath, resolve(import.meta.dir, "../cli/demo-agent.ts"), scriptPath],
        group: `${config.cmux.group} · demo`,
      });
      if (launched) {
        this.running.set(jobId, { statusPath: launched.statusPath, seenWork: false });
        this.hub.toast(`Dispatched to cmux: ${title}`, "good");
        this.patch(jobId, { status: "running", workspace: launched.workspace, startedAt: nowIso(), tail: ["▸ launched in cmux · Work HQ group"] });
        // Mirror the script into the dashboard feed so the Agents panel moves in step with the terminal.
        void this.playFeed(jobId, script, 600);
        return;
      }
      this.line(jobId, "cmux launch failed — running in the dashboard");
    }
    this.patch(jobId, { status: "running", startedAt: nowIso() });
    await this.playFeed(jobId, script, 0);
    this.hub.ingestReport({ ...script.report, jobId }, "agent");
    this.finishAction(jobId, { ok: true, text: "" });
  }

  /** Stream a demo script's steps into the job's tail, at the script's pace. */
  private async playFeed(jobId: string, script: DemoScript, startMs: number) {
    await sleep(startMs);
    for (const step of script.steps) {
      await sleep(step.ms);
      if (this.cancelled(jobId)) return;
      if (step.t !== "out") this.line(jobId, feedLine(step));
    }
  }

  private async demoSweep(name: "transcripts" | "calendar" | "posts") {
    const title = { transcripts: "Scan meeting transcripts", calendar: "Read today's calendar", posts: "Scout blog posts worth writing" }[name];
    const job = this.newJob("sweep", name, title, "headless");
    this.hub.putSync({ ...this.hub.store.syncState(name), lastRunAt: nowIso() });
    this.patch(job.id, { status: "running", startedAt: nowIso() });
    const script = demoSweepScript(name);
    await this.playFeed(job.id, script, 0);
    const { created } = this.hub.ingestReport({ ...script.report, jobId: job.id }, name === "calendar" ? "calendar" : name === "posts" ? "agent" : "transcript");
    this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: script.report.summary });
    this.hub.putSync({ ...this.hub.store.syncState(name), lastOkAt: nowIso(), error: undefined, cursor: "demo" });
    if (created.length) this.hub.toast(`${created.length} new from ${name}`, "good");
  }

  /** Poll cmux beacons. Called every few seconds by the scheduler. */
  pollCmux() {
    this.cap.pump(); // catches status changes that bypassed patch() (direct putJob, restarts)
    if (![...this.running.values()].some((r) => r.statusPath)) return;
    const live = cmux.liveWorkspaces();
    for (const [id, r] of this.running) {
      if (!r.statusPath) continue;
      const job = this.hub.store.job(id);
      if (!job) {
        this.running.delete(id);
        continue;
      }
      const b = cmux.readBeacon(r.statusPath);
      if (live && job.workspace && !live.has(job.workspace)) {
        this.running.delete(id);
        this.finishAction(id, { ok: job.reported ?? false, text: "", error: job.reported ? undefined : "workspace closed" });
        continue;
      }
      if (!b) continue;
      // A settled turn tells us about the model gateway too: an auth error raises the "Login expired" card
      // (and drops the shared token), a clean turn retires it. Once per turn.
      if (b.state === "idle" && b.seq >= 1 && b.seq !== r.gatewaySeq && (b.outcome === "error" || b.outcome === "completed")) {
        r.gatewaySeq = b.seq;
        const ok = b.outcome === "completed";
        this.noteGateway({ ok, text: "", error: ok ? undefined : b.detail });
        if (!ok && isAuthFailure(b.detail ?? "")) this.token.invalidate();
      }
      // Waiting out a provider rate limit. Any new turn (seq bump — ours or the owner's) ends the wait.
      if (r.retry && b.seq > r.retry.seq) {
        r.retry = undefined;
        r.seenWork = true;
      }
      if (r.retry && b.state === "idle") {
        if (!r.retry.sent && Date.now() >= r.retry.at && this.gate.wait() === 0) {
          void this.gate.acquire();
          if (job.workspace && cmux.sendLine(job.workspace, RESUME_NUDGE)) {
            r.retry.sent = Date.now();
            this.line(id, `↻ nudged after rate limit (${r.rateRetries}/${config.pi.rateLimitRetries})`);
          } else {
            this.running.delete(id);
            this.finishAction(id, { ok: false, text: "", error: `${b.detail ?? "rate limited"} (couldn't nudge the session)` });
          }
        } else if (r.retry.sent && Date.now() - r.retry.sent > 120_000) {
          this.running.delete(id);
          this.finishAction(id, { ok: false, text: "", error: `${b.detail ?? "rate limited"} (nudge didn't start a new turn)` });
        }
        continue;
      }
      if (b.state !== "idle" || (r.errored && b.seq !== r.errored.seq)) r.errored = undefined;
      if (b.state === "working" && job.status !== "running") {
        r.seenWork = true;
        this.patch(id, { status: "running" });
      } else if (b.state === "working") {
        r.seenWork = true;
      } else if (b.state === "blocked" && job.status !== "blocked") {
        this.patch(id, { status: "blocked", tail: [...job.tail, "⏸ waiting for you in cmux"].slice(-12) });
        this.hub.emit({ type: "notify", data: { title: "Agent needs you", body: job.title } });
        cmux.notify(job.workspace, "Work HQ", `Waiting for you: ${job.title}`);
      } else if (
        b.state === "idle" && b.seq >= 1 && (r.seenWork || job.status === "running") &&
        b.outcome === "error" && isRateLimited(b.detail) && (r.rateRetries ?? 0) < config.pi.rateLimitRetries && job.workspace
      ) {
        r.rateRetries = (r.rateRetries ?? 0) + 1;
        const ms = backoff();
        r.retry = { at: Date.now() + ms, seq: b.seq };
        this.patch(id, { status: "running", tail: [...job.tail, `⏳ rate limited — retrying in ${Math.round(ms / 1000)} s (${r.rateRetries}/${config.pi.rateLimitRetries})`].slice(-12) });
      } else if (b.state === "idle" && b.seq >= 1 && (r.seenWork || job.status === "running")) {
        // Turn settled. The session stays open for follow-ups; the job is done.
        // An errored turn isn't the end: pi keeps the session and the agent often recovers and reports.
        // A report wins; otherwise wait ERROR_GRACE_MS for a new turn before calling it stopped.
        if (b.outcome === "error" && !job.reported) {
          if (!r.errored) {
            r.errored = { at: Date.now(), seq: b.seq };
            this.line(id, `⚠ ${b.detail ?? "model error"} — giving the session ${Math.round(ERROR_GRACE_MS / 60_000)} min to recover`);
            continue;
          }
          if (Date.now() - r.errored.at < ERROR_GRACE_MS) continue;
        }
        this.running.delete(id);
        const failed = b.outcome === "error" && !job.reported;
        this.finishAction(id, { ok: !failed, text: "", error: failed ? b.detail ?? "model error" : undefined });
      } else if (b.state === "exited") {
        this.running.delete(id);
        this.finishAction(id, { ok: job.reported ?? false, text: "", error: job.reported ? undefined : `pi exited (${b.code ?? "?"})` });
      }
    }
  }

  /**
   * Close cmux workspaces whose session has sat idle past the threshold: `cmux.pruneDoneMinutes` (20) for a job
   * that finished cleanly with no open card on its item, `cmux.pruneIdleHours` (3) for the rest (failed, or
   * something still to answer, where you may want the session). 10-21: 31 finished sessions sat open, all under 3 h.
   */
  pruneCmux(now = Date.now()) {
    const hours = config.cmux.pruneIdleHours;
    const doneMin = config.cmux.pruneDoneMinutes;
    if (config.demo || !config.cmux.bin || !(hours > 0 || doneMin > 0)) return [];
    const all = cmux.jobWorkspaces();
    if (!all) return [];
    const open = this.hub.store.questions("open");
    const quick = (jobId: string) => doneMin > 0 && cmux.finishedCleanly(this.hub.store.job(jobId), open);
    const idleMsFor = (jobId: string) => (quick(jobId) ? doneMin * 60_000 : hours * 3600_000);
    const idle = cmux.pickIdle(all, { now, idleMs: hours * 3600_000, busy: new Set(this.running.keys()), idleSince: cmux.idleSince, idleMsFor });
    const closed = idle.filter((w) => cmux.closeWorkspace(w.id));
    for (const w of closed) {
      const job = this.hub.store.job(w.jobId);
      const after = quick(w.jobId) ? `${doneMin} min` : `${hours}h`;
      if (job?.workspace) this.patch(job.id, { workspace: undefined, tail: [...job.tail, `▸ cmux workspace closed after ${after} idle`].slice(-12) });
    }
    if (closed.length) console.log(`[cmux] closed ${closed.length} idle workspace(s): ${closed.map((w) => w.jobId).join(", ")}`);
    return closed;
  }

  private finishAction(jobId: string, r: { ok: boolean; text: string; error?: string }) {
    const job = this.hub.store.job(jobId);
    if (!job || ["done", "failed"].includes(job.status)) return;
    // Headless fallback: the final message may itself be the report.
    if (job.surface === "headless" && !job.reported) {
      const report = extractJson<AgentReport>(r.text);
      if (report) this.hub.ingestReport({ ...report, jobId }, "agent");
    }
    const after = this.hub.store.job(jobId)!;
    // An untouched worktree goes; one with commits or edits stays for the owner (and shows in the feed).
    void cleanupWorktree(jobId).then((r) => r === "kept" && this.line(jobId, "▸ worktree kept: unlanded commits or edits"));
    this.patch(jobId, {
      status: r.ok ? "done" : "failed",
      error: r.error,
      finishedAt: nowIso(),
      summary: after.summary ?? (r.ok ? "Finished" : undefined),
    });
    const item = job.itemId ? this.hub.store.item(job.itemId) : undefined;
    // If the agent didn't settle the item (and didn't ask its own question), ask the owner.
    const agentAsked = this.hub.store.questions("open").some((q) => q.itemId === item?.id && q.key.startsWith("agent:"));
    if (item && item.status === "doing" && !agentAsked) {
      this.hub.ask({
        kind: "state",
        itemId: item.id,
        key: `after:${jobId}`,
        badge: r.ok ? "Agent finished" : "Agent stopped",
        priority: 75,
        prompt: `${r.ok ? "Agent finished" : "Agent stopped"}: ${item.title}. Where does it stand?`,
        context: after.summary ?? r.error,
        options: [
          { id: "done", label: "Done", tone: "good", effect: { type: "status", status: "done" } },
          { id: "wait", label: "Waiting on someone", effect: { type: "status", status: "waiting" } },
          { id: "today", label: "Still mine today", tone: "primary", effect: { type: "status", status: "today" } },
          { id: "when", label: "Scheduled for…", hint: "say when", effect: { type: "when" } },
          ...(job.workspace ? [{ id: "look", label: "Show me the session", tone: "quiet" as const, effect: { type: "focusSession" as const, keep: true } }] : []),
        ],
      });
    }
    this.hub.emit({ type: "notify", data: { title: r.ok ? "Agent finished" : "Agent failed", body: job.title } });
  }

  // ── sweeps (headless) ──────────────────────────────────────────────────
  private sweeping = new Set<string>();

  /** `{ rerun: true }`: failed after the laptop slept mid-run; the scheduler runs it again on its next awake tick. */
  async sweep(name: "transcripts" | "calendar", opts: { since?: string } = {}): Promise<{ rerun?: boolean } | undefined> {
    if (this.sweeping.has(name)) return;
    if (config.demo) {
      this.sweeping.add(name);
      return this.demoSweep(name).then(() => undefined).finally(() => this.sweeping.delete(name));
    }
    this.sweeping.add(name);
    const state = this.hub.store.syncState(name);
    this.hub.putSync({ ...state, lastRunAt: nowIso() });
    try {
      const day = new Date();
      const dayStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const job = this.newJob("sweep", name, name === "transcripts" ? "Scan meeting transcripts" : "Read the calendar", "headless");
      let prompt: string;
      let through: string | undefined;
      if (name === "transcripts") {
        const midnight = new Date(day);
        midnight.setHours(0, 0, 0, 0);
        const since = opts.since ?? (state.cursor && state.cursor > midnight.toISOString() ? state.cursor : midnight.toISOString());
        const known = this.hub.store.items().filter((i) => i.source.type === "transcript" || i.status !== "dropped").map((i) => i.title);
        prompt = transcriptSweepPrompt(job.id, since, known);
      } else {
        through = deferHorizon(day);
        prompt = calendarSweepPrompt(job.id, dayStr, through);
      }
      const r = await this.runHeadless(job.id, prompt, { tools: true, thinking: config.pi.sweepThinking, perms: true, timeoutMin: 20 });
      const report = extractJson<AgentReport>(r.text);
      if (!r.ok || !report) {
        const error = r.error ?? "no JSON in final message";
        this.patch(job.id, { status: "failed", error, finishedAt: nowIso() });
        this.hub.putSync({ ...this.hub.store.syncState(name), error });
        if (r.slept && !this.cancelled(job.id)) {
          this.line(job.id, "\u21bb slept mid-run: rerunning on the next awake tick");
          return { rerun: true };
        }
        return;
      }
      const { created } = this.hub.ingestReport({ ...report, jobId: job.id, eventsThrough: through }, name === "transcripts" ? "transcript" : "calendar");
      if (name === "transcripts") this.hub.markScanned(scannedFrom(report, this.hub.store.items().filter((i) => created.includes(i.id))));
      this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: report.summary });
      this.hub.putSync({
        ...this.hub.store.syncState(name),
        lastOkAt: nowIso(),
        error: undefined,
        cursor: name === "transcripts" ? report.cursor ?? state.cursor : `${report.events?.length ?? 0} events`,
        through: name === "calendar" && report.events ? through : state.through,
      });
      if (created.length) this.hub.toast(`${created.length} new from transcripts`, "good");
    } finally {
      this.sweeping.delete(name);
    }
  }

  // ── triage (headless, no tools) ────────────────────────────────────────
  /**
   * A crash (pi died, signal, restart) gets one silent rerun: triage has no tools, so a rerun can't
   * repeat side effects. If it still fails, the words come back as a card with Retry / Drop —
   * a failed triage must never leave the ask only in the journal (10-15: lost for 35 hours).
   */
  async triage(utterance: string, mode: TriageMode = "chat"): Promise<TriageResult & { jobId: string }> {
    const job = this.newJob("triage", mode, mode === "pineapple" ? `🍍 ${utterance.slice(-60)}` : utterance.slice(0, 80), "headless");
    writeFileSync(triageFile(job.id), JSON.stringify({ text: utterance, mode }));
    const prompt = triagePrompt(utterance, { now: new Date(), items: this.hub.store.items(), events: this.hub.todayEvents(), questions: this.hub.store.questions("open") }, mode);
    const run = () => this.runHeadless(job.id, prompt, { tools: false, thinking: config.pi.triageThinking, perms: false, timeoutMin: 4 });
    let r = await run();
    if (!r.ok && !this.cancelled(job.id) && isCrash(r.error ?? "")) {
      this.line(job.id, `↻ pi crashed (${r.error}), retrying once`);
      this.hub.journal(`Triage crashed (${r.error}), retrying once`, { who: "hq" });
      r = await run();
    }
    const result = r.ok ? extractJson<TriageResult>(r.text) : undefined;
    if (!r.ok || !result) {
      const error = r.error ?? "couldn't parse triage output";
      this.patch(job.id, { status: "failed", error, finishedAt: nowIso() });
      if (this.cancelled(job.id)) return { jobId: job.id, reply: "Triage cancelled." };
      this.reaskTriage(job.id, error, { text: utterance, mode });
      return { jobId: job.id, reply: "Triage failed — your words are on a card to retry." };
    }
    const missed = await this.applyTriage(result, mode, utterance);
    // The reply was written before anything ran. If it promised an agent that never started, say so:
    // either a dispatch that failed (missed), or a reply that claims one with dispatch[] empty.
    const unbacked = !result.dispatch?.length && claimsDispatch(result.reply);
    if (unbacked) this.hub.journal(`Triage reply claimed a dispatch but dispatch[] was empty (heuristic, check it): "${result.reply}"`, { who: "hq" });
    const reply = missed
      ? `${result.reply ?? ""} (No agent started for ${missed} of those: item not found.)`.trim()
      : unbacked
        ? `${result.reply} (No agent started.)`
        : result.reply;
    // reply-safe: applyTriage ran first; the prompt words dispatches as handed off; failed or missing dispatches get a suffix.
    this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: reply });
    return { ...result, reply, jobId: job.id };
  }

  /** Put a failed triage's words back in front of the owner: Retry runs triage again, Drop lets them go. */
  private reaskTriage(jobId: string, error: string, saved?: { text: string; mode: TriageMode }) {
    if (!saved) {
      try {
        saved = JSON.parse(readFileSync(triageFile(jobId), "utf8"));
      } catch {
        return; // triage from before words were saved: nothing to offer back
      }
    }
    const text = saved?.text?.trim();
    if (!text) return;
    const mode = saved!.mode ?? "chat";
    const quote = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    this.hub.ask({
      kind: "open",
      key: `triage-failed:${jobId}`,
      badge: "Triage failed",
      priority: 85,
      prompt: `Couldn't triage: "${quote}"`,
      context: `${mode === "pineapple" ? "🍍 capture" : mode === "review" ? "Review note" : "Command bar"} · ${error}. Your words are in the journal; nothing was acted on.`,
      options: [
        { id: "retry", label: "Retry", tone: "primary", effect: { type: "triage", text, mode } },
        { id: "drop", label: "Drop", tone: "quiet", effect: { type: "noop" } },
      ],
    });
  }

  /** Returns how many requested dispatches didn't start (unknown id, bad 'new:' index). */
  private async applyTriage(t: TriageResult, mode: TriageMode, utterance: string): Promise<number> {
    let missed = 0;
    const created: Item[] = [];
    for (const raw of t.items ?? []) {
      created.push(
        this.hub.createItem({
          ...raw,
          status: raw.status ?? "inbox",
          source: { type: mode === "pineapple" ? "pineapple" : "voice", ...(raw.source ?? {}) },
        }),
      );
    }
    for (const u of t.updates ?? []) {
      if (!this.hub.store.item(u.id)) continue;
      const { id, note, ...patch } = u;
      if (patch.scheduledFor && !patch.status) patch.status = "scheduled";
      if (patch.status) this.hub.setStatus(id, patch.status, note);
      const { status: _s, ...rest } = patch;
      if (Object.keys(rest).length) this.hub.updateItem(id, { ...rest, confirmedAt: nowIso() });
    }
    for (const line of t.journal ?? []) this.hub.journal(line, { who: "hq" });
    for (const b of t.bulk ?? []) {
      if (!b?.op || !(b.group || b.kind || b.ids?.length)) continue;
      try {
        await this.hub.bulk(b);
      } catch (e) {
        this.hub.toast(`Batch ${b.op}: ${(e as Error).message}`, "warn");
      }
    }
    // A follow-up tap goes back through triage with the original words plus the answer, so
    // "Yes, dispatch" dispatches. Until 10-17 every option was a noop: the tap wrote a journal
    // line and the work was silently dropped (3 times in a week).
    if (t.question?.prompt) {
      const prompt = t.question.prompt;
      this.hub.ask({
        kind: "open",
        key: `triage:${Date.now()}`,
        priority: 80,
        prompt,
        options: (t.question.options?.length ? t.question.options : ["Yes", "No"]).map((l, i) => ({
          id: `o${i}`,
          label: l,
          tone: i === 0 ? "primary" : "quiet",
          effect: {
            type: "multi",
            effects: [
              { type: "noop" }, // keeps the "prompt → answer" journal line
              { type: "triage", text: `${utterance}\n\nYou asked: ${prompt}\nThey answered: ${l}`, mode },
            ],
          },
        })),
      });
    }
    for (const d of t.dispatch ?? []) {
      const id = d.id?.startsWith("new:") ? created[Number(d.id.slice(4))]?.id : d.id;
      if (!(id && (await this.dispatch(id, d.action, d.note)))) missed++;
    }
    for (const c of t.calendar ?? []) {
      const id = c.id.startsWith("new:") ? created[Number(c.id.slice(4))]?.id : c.id;
      const item = id ? this.hub.store.item(id) : undefined;
      if (!item || !c.start || Number.isNaN(Date.parse(c.start))) continue;
      if (item.scheduledFor !== c.start) this.hub.schedule(item.id, c.start, item.when ?? new Date(c.start).toLocaleString());
      void this.calendarBlock(item.id, c.start, c.durationMin ?? 30);
    }
    return missed;
  }

  // ── a note typed on a question: what does it mean? ─────────────────────
  /** Throws when the run fails or its output won't parse: a crash must never read as "context only". Undefined = the question is gone. */
  async readNote(questionId: string, text: string): Promise<NoteDecision | undefined> {
    const q = this.hub.store.question(questionId);
    if (!q) return undefined;
    const item = q.itemId ? this.hub.store.item(q.itemId) : undefined;
    const job = this.newJob("triage", "note", `Note: ${item?.title ?? q.prompt}`.slice(0, 80), "headless", item?.id);
    const r = await this.runHeadless(job.id, notePrompt(q, item, text, { now: new Date() }), {
      tools: false, thinking: config.pi.triageThinking, perms: false, timeoutMin: 3,
    });
    const out = extractJson<NoteDecision>(r.text);
    if (!r.ok || !out) {
      const error = r.error ?? "couldn't parse note reader output";
      this.patch(job.id, { status: "failed", error, finishedAt: nowIso() });
      throw new Error(error);
    }
    // Summary before applyNote runs anything: fixed words when the note only starts work (10-16: "Asking Maryna in chat").
    // reply-safe: queuedNote covers every queued path; out.reply only shows when the change is synchronous.
    this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: queuedNote(q, out, item?.title) ?? out.reply ?? "Read the note" });
    return out;
  }

  // ── "Explain simply" — a plain-English read of an item ─────────────────────
  private explaining = new Map<string, Promise<Item>>();

  /** Writes `item.explain` and returns the item. One run per item at a time; a second click waits on the first. Throws on failure. */
  explainItem(itemId: string): Promise<Item> {
    const running = this.explaining.get(itemId);
    if (running) return running;
    const p = this.runExplain(itemId).finally(() => this.explaining.delete(itemId));
    this.explaining.set(itemId, p);
    return p;
  }

  private async runExplain(itemId: string): Promise<Item> {
    const item = this.hub.store.item(itemId);
    if (!item) throw new Error("no such item");
    const key = explainKey(item);
    if (config.demo) {
      const what = item.detail ? sentences(item.detail)[0] ?? item.title : item.title;
      return this.hub.updateItem(itemId, { explain: { at: nowIso(), for: key, what, why: "Demo mode: this is the first sentence of the detail, not a model's read." } });
    }
    const job = this.newJob("triage", "explain", `Explain: ${item.title}`.slice(0, 80), "headless", itemId);
    const r = await this.runHeadless(job.id, explainPrompt(item, { now: new Date() }), { tools: false, thinking: config.pi.triageThinking, perms: false, timeoutMin: 3 });
    const out = extractJson<{ what?: string; why?: string; done?: string; terms?: Array<{ term?: string; meaning?: string }> }>(r.text);
    if (!r.ok || !out?.what?.trim()) {
      const error = r.error ?? "couldn't parse the explanation";
      this.patch(job.id, { status: "failed", error, finishedAt: nowIso() });
      throw new Error(error);
    }
    const clean = (s?: string) => s?.trim() || undefined;
    const terms = (out.terms ?? []).filter((t) => t.term?.trim() && t.meaning?.trim()).slice(0, 4).map((t) => ({ term: t.term!.trim(), meaning: t.meaning!.trim() }));
    this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: out.what.trim() });
    return this.hub.updateItem(itemId, {
      explain: { at: nowIso(), for: key, what: out.what.trim(), why: clean(out.why), done: clean(out.done), ...(terms.length ? { terms } : {}) },
    });
  }

  // ── "Scheduled for…" — the owner says when, in words ──────────────────────
  async scheduleFromWords(itemId: string, words: string) {
    const item = this.hub.store.item(itemId);
    if (!item) return;
    const job = this.newJob("triage", "when", `When: ${item.title}`.slice(0, 80), "headless", itemId);
    const r = await this.runHeadless(job.id, schedulePrompt(item, words, { now: new Date(), events: this.hub.todayEvents() }), {
      tools: false, thinking: config.pi.triageThinking, perms: false, timeoutMin: 3,
    });
    const out = extractJson<{ at?: string | null; label?: string; calendar?: "create" | "exists" | "none"; durationMin?: number; reply?: string }>(r.text);
    const at = out?.at && !Number.isNaN(Date.parse(out.at)) ? out.at : undefined;
    if (!r.ok || !out || !at) {
      this.patch(job.id, { status: "failed", error: r.error ?? "no time in that", finishedAt: nowIso() });
      this.hub.journal(`Tried to schedule "${item.title}" from: “${words}” — couldn't tell when`, { itemId });
      // reply-safe: failure path, the reply asks when.
      this.hub.toast(out?.reply ?? "Couldn't tell when. Asking again.", "warn");
      this.hub.ask({
        kind: "when", itemId, key: `when-retry:${itemId}:${Date.now()}`, badge: "When?", priority: 92,
        prompt: `When for: ${item.title}?`, context: `I heard “${words}” and couldn't find a time in it.`,
        options: [
          { id: "when", label: "Scheduled for…", tone: "primary", hint: "say when", effect: { type: "when" } },
          { id: "today", label: "Today, no fixed time", effect: { type: "status", status: "today" } },
        ],
      });
      return;
    }
    const label = out.label ?? new Date(at).toLocaleString();
    this.hub.schedule(itemId, at, label);
    this.hub.journal(`${out.calendar === "exists" ? "Already booked" : "Will do"} ${label}: ${item.title} — “${words}”`, { itemId });
    // 10-16 20:55Z: the model's reply said "Booked a 30-min 1-1 with Kevin" and the calendar write failed 16s later.
    // The write hasn't run yet here, and it only ever makes a private block. calendarBlock toasts the real outcome.
    if (out.calendar === "create") {
      const msg = `Scheduled ${label} — adding a private block to your calendar`;
      this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: msg });
      this.hub.toast(msg, "good");
      void this.calendarBlock(itemId, at, out.durationMin ?? 30);
      return;
    }
    // reply-safe: schedule() already ran and there's no calendar write left (create returned above with fixed words).
    this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: out.reply ?? `Scheduled ${label}` });
    const cal = out.calendar === "exists" ? " — I'll remind you then" : " — I'll remind you";
    this.hub.toast(`${out.reply ?? `Scheduled ${label}`}${out.reply ? "" : cal}`, "good");
  }

  /** A private block in the owner's own calendar. No attendees, no invites. */
  async calendarBlock(itemId: string, start: string, durationMin: number) {
    const item = this.hub.store.item(itemId);
    if (!item) return;
    if (config.demo) {
      this.hub.journal(`In calendar ${new Date(start).toLocaleString()}: ${item.title}`, { itemId, who: "hq" });
      this.hub.toast(`In your calendar: ${item.title}`, "good");
      return;
    }
    const end = new Date(Date.parse(start) + Math.max(15, Math.min(240, durationMin)) * 60_000).toISOString();
    const job = this.newJob("sweep", "calendar-write", `Calendar: ${item.title}`.slice(0, 80), "headless", itemId);
    const r = await this.runHeadless(job.id, calendarPrompt(job.id, item, start, end), { tools: true, thinking: "low", perms: true, timeoutMin: 6 });
    const out = extractJson<{ summary?: string; status?: string; eventId?: string; eventUrl?: string }>(r.text);
    if (!r.ok || !out || out.status === "failed" || !(out.eventId || out.eventUrl)) {
      const error = r.error ?? out?.summary ?? "calendar write failed";
      this.patch(job.id, { status: "failed", error, finishedAt: nowIso() });
      this.hub.toast(`Couldn't add it to your calendar: ${error}. The in-app reminder still stands.`, "warn");
      return;
    }
    const cur = this.hub.store.item(itemId)!;
    if (out.eventUrl) this.hub.updateItem(itemId, { links: [...new Set([...(cur.links ?? []), out.eventUrl])] });
    this.hub.journal(`In calendar ${new Date(start).toLocaleString()}: ${cur.title}`, { itemId, who: "hq" });
    this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: out.summary ?? "Event created" });
    this.hub.toast(`In your calendar: ${cur.title}`, "good");
    void this.sweep("calendar");
  }

  // ── writing scout (weekly, headless) ───────────────────────────────────
  async postSweep() {
    if (this.sweeping.has("posts")) return;
    if (config.demo) {
      this.sweeping.add("posts");
      return this.demoSweep("posts").finally(() => this.sweeping.delete("posts"));
    }
    this.sweeping.add("posts");
    const state = this.hub.store.syncState("posts");
    this.hub.putSync({ ...state, lastRunAt: nowIso() });
    try {
      const today = localDay(new Date());
      const known = this.hub.store.items().filter((i) => i.kind === "post" && i.status !== "dropped");
      const inFlight = listDrafts();
      const job = this.newJob("sweep", "posts", "Scout blog posts worth writing", "headless");
      const r = await this.runHeadless(job.id, postSweepPrompt(job.id, known, today, inFlight), {
        tools: true, thinking: config.pi.sweepThinking, perms: true, timeoutMin: 25,
      });
      const out = extractJson<{ summary?: string; ideas?: PostIdea[] }>(r.text);
      if (!r.ok || !out?.ideas) {
        const error = r.error ?? "no JSON in final message";
        this.patch(job.id, { status: "failed", error, finishedAt: nowIso() });
        this.hub.putSync({ ...this.hub.store.syncState("posts"), error });
        return;
      }
      let drafted = 0;
      for (const idea of out.ideas) if (this.savePostIdea(idea, today)) drafted++;
      this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: out.summary });
      this.hub.putSync({ ...this.hub.store.syncState("posts"), lastOkAt: nowIso(), error: undefined, cursor: `${out.ideas.length} ideas · ${drafted} drafted` });
      if (out.ideas.length) this.hub.toast(`${out.ideas.length} post ideas, ${drafted} drafted`, "good");
    } finally {
      this.sweeping.delete("posts");
    }
  }

  /** Writes drafts to disk (never overwrites) and upserts the item. Returns true if a draft was written. */
  savePostIdea(idea: PostIdea, today: string): boolean {
    if (!idea.title?.trim()) return false;
    const slug = slugify(idea.slug ?? idea.title);
    const existing = idea.id ? this.hub.store.item(idea.id) : this.hub.store.itemBySourceKey(`post:${slug}`);
    const post = { ...(existing?.post ?? {}), venue: idea.venue ?? existing?.post?.venue ?? "wiki", why: idea.why ?? existing?.post?.why, gap: idea.gap ?? existing?.post?.gap };
    let wrote = false;
    if (idea.wikiDraft && !post.wikiDraft) {
      mkdirSync(WIKI_DRAFTS, { recursive: true });
      const path = `${WIKI_DRAFTS}/${today}-${slug}.md`;
      if (!existsSync(path)) {
        writeFileSync(path, idea.wikiDraft.endsWith("\n") ? idea.wikiDraft : `${idea.wikiDraft}\n`);
        post.wikiDraft = path;
        wrote = true;
      }
    }
    if (idea.siteDraft && !post.siteDraft && SITE_POSTS && existsSync(SITE_POSTS)) {
      const path = `${SITE_POSTS}/${slug}.md`;
      if (!existsSync(path)) {
        const body = /^---\n[\s\S]*?draft:\s*true/.test(idea.siteDraft) ? idea.siteDraft : idea.siteDraft.replace(/^---\n/, "---\ndraft: true\n");
        writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`);
        post.siteDraft = path;
        wrote = true;
      }
    }
    if (post.siteDraft) ensureSiteLink();
    const links = [post.wikiDraft, post.siteDraft].filter(Boolean).map((p) => openUrl(p!));
    const detail = [idea.angle, idea.evidence?.length ? `Evidence: ${idea.evidence.join(" · ")}` : ""].filter(Boolean).join("\n\n") || existing?.detail;
    if (existing) {
      this.hub.updateItem(existing.id, { post, detail, links: [...new Set([...(existing.links ?? []), ...links])] }, { quiet: true });
    } else {
      this.hub.createItem({
        title: idea.title.trim(), kind: "post", status: "proposed", detail, post, links,
        source: { type: "agent", label: "Writing scout", key: `post:${slug}` },
      });
    }
    return wrote;
  }

  // ── the one place pi gets spawned headless ─────────────────────────────
  /**
   * Tool runs are spaced by the launch gate. If the run dies on a provider rate limit, wait 60–90 s and
   * try again (up to pi.rateLimitRetries). Tool runs resume their own session so finished
   * tool calls aren't repeated; tool-less runs have no side effects and simply rerun.
   */
  private async runHeadless(
    jobId: string,
    prompt: string,
    o: { tools: boolean; thinking: string; perms: boolean; timeoutMin: number },
  ): Promise<RunResult> {
    let resume: string | undefined;
    for (let attempt = 0; ; attempt++) {
      // Tool-less triage stays instant: no tool schemas, nothing to compile, and the owner is waiting on it.
      if (o.tools) {
        const wait = this.gate.wait();
        if (wait > 0) this.line(jobId, `⏳ queued ${Math.ceil(wait / 1000)} s — spacing launches`);
        await this.gate.acquire();
      }
      if (this.cancelled(jobId)) return { ok: false, text: "", error: "cancelled" };
      const r = await this.runHeadlessOnce(jobId, prompt, o, resume);
      this.noteGateway(r);
      if (r.ok || this.cancelled(jobId) || attempt >= config.pi.rateLimitRetries) return r;
      if (!isRateLimited(`${r.error ?? ""}\n${r.text}`)) return r;
      // A tool run that already did things must resume, not restart. No session → give up.
      if (o.tools && r.toolsRan && !r.session) return r;
      resume = o.tools ? r.session ?? resume : undefined;
      const ms = backoff();
      this.line(jobId, `⏳ rate limited — retrying in ${Math.round(ms / 1000)} s (${attempt + 1}/${config.pi.rateLimitRetries})`);
      this.patch(jobId, { status: "queued" });
      await sleep(ms);
      if (this.cancelled(jobId)) return { ok: false, text: "", error: "cancelled" };
    }
  }

  // ── model gateway auth ─────────────────────────────────────────────────
  // pi reaches the model through the provider in pi.model. Some providers get their key from a shell
  // command (e.g. `cloudflared access token -app=…` for a gateway behind Cloudflare Access). When that
  // login lapses, a headless pi can't open a browser to renew it, so every sweep fails until someone
  // logs in. Ask once, offer the login, and stop burning sweeps meanwhile.
  private gateway: { down?: string; app?: string; lastTry?: number } = {};

  /** True while the gateway login is known to be broken (sweeps hold off; one retry every 30 min). */
  gatewayBlocked(now = Date.now()) {
    if (!this.gateway.down) return false;
    if (now - (this.gateway.lastTry ?? 0) > 30 * 60_000) {
      this.gateway.lastTry = now;
      return false;
    }
    return true;
  }

  private noteGateway(r: RunResult) {
    const text = `${r.error ?? ""}\n${r.ok ? "" : r.text}`;
    if (r.ok) {
      if (this.gateway.down) {
        this.gateway = {};
        this.hub.toast("Model gateway is back. Sweeps resume.", "good");
        for (const q of this.hub.store.questions("open").filter((q) => q.key.startsWith("gateway-auth:"))) this.hub.expireQuestion(q.id, "gateway back");
      }
      return;
    }
    const auth = gatewayAuthError(text);
    if (!auth) return;
    const first = !this.gateway.down;
    this.gateway = { down: this.gateway.down ?? nowIso(), app: auth.app ?? this.gateway.app, lastTry: Date.now() };
    if (first) this.hub.journal(`Model gateway login lapsed (${auth.provider}); sweeps paused until it's back`, { who: "hq" });
    this.hub.ask({
      kind: "open",
      key: `gateway-auth:${new Date().toDateString()}`,
      badge: "Login expired",
      priority: 93,
      prompt: `pi can't reach the model: your Cloudflare Access login for ${auth.app ? new URL(auth.app).host : auth.provider} lapsed`,
      context: `Sweeps, agents and the note reader fail until you log in. Headless pi can't open the browser itself. Provider \`${auth.provider}\` is the one pi uses for the model.`,
      options: [
        ...(auth.app ? [{ id: "login", label: "Log in now (opens one tab)", tone: "primary" as const, effect: { type: "gatewayLogin" as const, app: auth.app } }] : []),
        { id: "later", label: "Later", tone: "quiet" as const, effect: { type: "noop" as const } },
      ],
    });
  }

  async gatewayLogin(app: string) {
    if (!/^https:\/\/[a-z0-9.-]+\/?$/i.test(app)) return;
    const bin = existsSync("/opt/homebrew/bin/cloudflared") ? "/opt/homebrew/bin/cloudflared" : "cloudflared";
    this.hub.toast("Opening the Access login in your browser…", "info");
    const ok = await new Promise<boolean>((done) => {
      const p = spawn(bin, ["access", "login", app], { stdio: "ignore" });
      const t = setTimeout(() => { p.kill(); done(false); }, 5 * 60_000);
      p.on("exit", (code) => { clearTimeout(t); done(code === 0); });
      p.on("error", () => { clearTimeout(t); done(false); });
    });
    if (!ok) {
      this.hub.toast("Login didn't finish. Run `cloudflared access login " + app + "` yourself.", "warn");
      return;
    }
    this.gateway = {};
    this.hub.journal(`Model gateway login renewed (${new URL(app).host})`, { who: "hq" });
    this.hub.toast("Logged in. Sweeps resume.", "good");
    void this.sweep("transcripts");
  }

  private cancelled(jobId: string) {
    return this.hub.store.job(jobId)?.error === "cancelled";
  }

  private async runHeadlessOnce(
    jobId: string,
    prompt: string,
    o: { tools: boolean; thinking: string; perms: boolean; timeoutMin: number },
    resume?: string,
  ): Promise<RunResult> {
    // Belt and braces: demo mode never gives pi tools (sweeps and actions are scripted above).
    if (config.demo && o.tools) return { ok: false, text: "", error: "demo mode: no tool runs" };
    const promptPath = resolve(cmux.jobDir(jobId), "prompt.md");
    writeFileSync(promptPath, prompt); // the print runner reads it; the rpc runner keeps it for debugging
    const env = await this.headlessEnv(jobId, o.perms);
    this.patch(jobId, { status: "running", startedAt: nowIso() });
    let r: RunResult;
    try {
      r = config.pi.runner === "print" ? await this.runPrint(jobId, promptPath, o, env, resume) : await this.runRpc(jobId, prompt, o, env, resume);
    } catch (e) {
      r = { ok: false, text: "", error: (e as Error).message };
    }
    this.running.delete(jobId);
    if (r.session) this.patch(jobId, { session: r.session });
    if (!r.ok && isAuthFailure(`${r.error ?? ""}\n${r.text}`)) this.token.invalidate();
    return r;
  }

  // ── env shared by every headless run ─────────────────────────────────────
  readonly token = new GatewayToken(config.pi.gatewayToken);

  private async headlessEnv(jobId: string | undefined, perms: boolean) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...cmux.tlsEnv(),
      PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
      WORK_HQ_URL: `http://127.0.0.1:${config.port}`,
      // Not a terminal: cmux hooks mustn't treat this pi as the surface the server happened to start in.
      CMUX_PI_HOOKS_DISABLED: "1",
      ...(await this.token.env()),
    };
    for (const k of ["CMUX_SURFACE_ID", "CMUX_WORKSPACE_ID", "CMUX_PANEL_ID", "CMUX_PANE_ID", "CMUX_TAB_ID"]) delete env[k];
    if (jobId) env.WORK_HQ_JOB = jobId;
    if (perms) Object.assign(env, config.pi.headlessEnv);
    return env;
  }

  // ── rpc runner: prompt over stdin, warm workers for triage ────────────────
  private pool?: PiPool;
  private poolEnv: Record<string, string> = {};

  private triagePool() {
    this.pool ??= new PiPool({
      size: config.pi.triageWorkers,
      make: () => new PiRpc({ bin: config.pi.bin, args: [...modelArgs(), "--thinking", config.pi.triageThinking, ...TRIAGE_FLAGS], cwd: config.workspace.dir, env: this.poolEnv }),
      // A pi/extension update or a new gateway token retires the warm workers.
      stamp: () => `${piStamp(config.pi.bin)}:${config.pi.gatewayToken ? (this.poolEnv[config.pi.gatewayToken.env] ?? "").slice(-16) : ""}`,
    });
    return this.pool;
  }

  /** Start the warm triage workers so the first question of the day doesn't wait on pi starting. */
  async warm() {
    if (config.pi.runner !== "rpc" || config.pi.triageWorkers <= 0 || config.demo) return;
    this.poolEnv = await this.headlessEnv(undefined, false);
    this.triagePool().warm();
  }

  async stop() {
    await this.pool?.stop();
  }

  private async runRpc(
    jobId: string,
    prompt: string,
    o: { tools: boolean; thinking: string; perms: boolean; timeoutMin: number },
    env: Record<string, string>,
    resume?: string,
  ): Promise<RunResult> {
    const onEvent = (ev: any) => {
      if (ev.type === "tool_execution_start") this.line(jobId, `▸ ${describeTool(ev.toolName, ev.args)}`);
      else if (ev.type === "extension_ui_request" && DIALOG_METHODS.has(ev.method)) {
        this.line(jobId, `⊘ declined a prompt nobody can answer: ${String(ev.title ?? ev.message ?? ev.method).slice(0, 80)}`);
      }
    };
    const timeoutMs = o.timeoutMin * 60_000;
    let out: RunOutcome;
    if (!o.tools && o.thinking === config.pi.triageThinking) {
      // Shared workers carry no job id and no perms env: tool-less triage needs neither.
      this.poolEnv = (({ WORK_HQ_JOB, ...rest }) => rest)(env);
      out = await this.triagePool().run(prompt, { timeoutMs, onEvent, onStart: (cancel) => this.running.set(jobId, { seenWork: true, cancel }) });
    } else {
      const job = this.hub.store.job(jobId)!;
      const args = [...modelArgs(), "--thinking", o.thinking];
      if (o.tools) args.push("-a", "-n", `work-hq: ${job.title}`.slice(0, 120), "-xt", config.pi.headlessDenyTools);
      else args.push(...TRIAGE_FLAGS);
      if (resume) args.push("--session", resume);
      // Every record pi sends or gets, type and time only: says how far a stalled run got.
      const logPath = resolve(cmux.jobDir(jobId), "rpc.jsonl");
      const rpc = new PiRpc({ bin: config.pi.bin, args, cwd: config.workspace.dir, env, logPath });
      this.running.set(jobId, { seenWork: true, cancel: () => void rpc.stop() });
      try {
        rpc.start();
        const idleMs = o.tools && config.pi.stallMin > 0 ? config.pi.stallMin * 60_000 : undefined;
        out = await rpc.run(resume ? RESUME_NUDGE : prompt, { timeoutMs, idleMs, onEvent });
      } finally {
        await rpc.stop();
      }
    }
    const session = out.session ?? resume;
    const toolsRan = out.toolsRan || Boolean(resume);
    const slept = out.sleptMs;
    if (slept) this.line(jobId, `☾ machine slept ${Math.round(slept / 60_000)} min mid-run, not counted against the deadline`);
    if (out.ok) return { ok: true, text: out.text, session, toolsRan, slept };
    const lastStderr = out.stderr.trim().split("\n").pop() ?? "";
    if ((out.timedOut || out.stalled) && lastStderr) this.line(jobId, `stderr: ${lastStderr}`);
    return { ok: false, text: out.text, session, toolsRan, slept, error: rpcError(out, o.timeoutMin, config.pi.stallMin) };
  }

  // ── print runner (`pi -p`): the old path, kept behind pi.runner = "print" ──
  private runPrint(
    jobId: string,
    promptPath: string,
    o: { tools: boolean; thinking: string; perms: boolean; timeoutMin: number },
    env: Record<string, string>,
    resume?: string,
  ): Promise<RunResult> {
    const job = this.hub.store.job(jobId)!;
    const args = ["-p", "--mode", "json", ...modelArgs(), "--thinking", o.thinking];
    if (o.tools) args.push("-a", "-n", `work-hq: ${job.title}`, "-xt", config.pi.headlessDenyTools);
    else args.push(...TRIAGE_FLAGS);
    if (resume) args.push("--session", resume);
    // Without tools pi can't read the file itself, so attach it with @file. Never put the prompt in argv.
    if (o.tools) args.push(resume ? RESUME_NUDGE : `Read ${promptPath} and follow the instructions in it exactly.`);
    else args.push(`@${promptPath}`, "Follow the instructions in the attached file exactly.");
    assertShortArgs(args);

    return new Promise((done) => {
      const proc = spawn(config.pi.bin, args, { cwd: config.workspace.dir, env, stdio: ["ignore", "pipe", "pipe"] });
      this.running.set(jobId, { seenWork: true, proc });
      let buf = "";
      let lastText = "";
      let lastError: string | undefined;
      let toolsRan = Boolean(resume);
      let stderr = "";
      let session: string | undefined = resume;
      // Our own kill: say so. Otherwise the error is "pi exited 143" plus whatever stderr said last.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
      }, o.timeoutMin * 60_000);
      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === "session") session = ev.id;
          else if (ev.type === "tool_execution_start") {
            toolsRan = true;
            this.line(jobId, `▸ ${describeTool(ev.toolName, ev.args)}`);
          } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
            const text = (ev.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
            if (text) lastText = text;
            lastError = ev.message.stopReason === "error" ? ev.message.errorMessage : undefined;
          }
        }
      });
      proc.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        const base = { text: lastText, session, toolsRan };
        if (code === 0 && !lastError) return done({ ok: true, ...base });
        const lastStderr = stderr.trim().split("\n").pop() ?? "";
        if (timedOut && lastStderr) this.line(jobId, `stderr: ${lastStderr}`); // keep it in the tail, not the label
        done({ ok: false, ...base, error: runError({ code, signal, timedOut, timeoutMin: o.timeoutMin, lastError, stderr }) });
      });
      proc.on("error", (e) => {
        clearTimeout(timer);
        done({ ok: false, text: "", error: String(e) });
      });
    });
  }

  cancel(jobId: string) {
    const r = this.running.get(jobId);
    r?.proc?.kill("SIGTERM");
    r?.cancel?.();
    const job = this.hub.store.job(jobId);
    if (job?.workspace) cmux.closeWorkspace(job.workspace);
    this.running.delete(jobId);
    if (job && !["done", "failed"].includes(job.status)) this.patch(jobId, { status: "failed", error: "cancelled", finishedAt: nowIso() });
  }

  focus(jobId: string) {
    const job = this.hub.store.job(jobId);
    return job?.workspace ? cmux.focusWorkspace(job.workspace) : false;
  }
}

const ACTION_LABEL: Record<ActionKind, string> = {
  ticket: "Ticket",
  reply: "Reply",
  email: "Email",
  prep: "Prep",
  work: "Work",
  verify: "Verify",
  draft: "Draft",
  publish: "Publish",
};

/** Why a pi run failed, in words that point at the real cause. A timeout is ours, not pi's last stderr line. */
export function runError(r: { code: number | null; signal?: string | null; timedOut: boolean; timeoutMin: number; lastError?: string; stderr: string }): string {
  if (r.timedOut) return `timed out after ${r.timeoutMin} min`;
  if (r.code === null && r.signal === "SIGKILL") return "pi killed by SIGKILL (not us; endpoint security? check `log stream` for sentineld)";
  if (r.code === null && r.signal) return `pi killed by ${r.signal}`;
  return r.lastError ?? `pi exited ${r.code}: ${r.stderr.trim().split("\n").pop() ?? ""}`;
}

/** Why an rpc run failed. Our own deadlines first, then a dead process, then the model's error. */
export function rpcError(r: RunOutcome, timeoutMin: number, stallMin: number): string {
  // Awake time alone ran out, but a sleep in between likely broke pi's in-flight request. Say so: it's not a hang.
  const slept = r.sleptMs && (r.timedOut || r.stalled) ? `machine slept mid-run (${Math.round(r.sleptMs / 60_000)} min), then ` : "";
  if (r.timedOut) return `${slept}timed out after ${timeoutMin} min`;
  if (r.stalled) return `${slept}stalled: no activity for ${stallMin} min (${r.lastEvent ? `last event: ${r.lastEvent.type} at ${new Date(r.lastEvent.at).toISOString().slice(11, 19)}Z` : "no events from pi"})`;
  if (r.exit) return runError({ code: r.exit.code, signal: r.exit.signal, timedOut: false, timeoutMin, lastError: r.lastError, stderr: r.stderr });
  if (r.lastError) return r.lastError;
  return r.aborted ? "aborted" : "pi run failed";
}

/** The gateway rejected the token (or couldn't get one): drop the cached token. */
export function isAuthFailure(text: string) {
  return Boolean(gatewayAuthError(text)) || /\b401\b|unauthori[sz]ed|invalid (api )?key|token (is )?expired/i.test(text);
}

/** "API key auth failed for provider X: … access token -app='https://…'" → which provider, which Access app. */
export function gatewayAuthError(text: string): { provider: string; app?: string } | undefined {
  const m = /API key auth failed for provider "?([\w.-]+)"?|Failed to resolve API key for provider "([\w.-]+)"/.exec(text);
  if (!m) return undefined;
  const app = /-app='?(https:\/\/[a-z0-9.-]+)\/?'?/i.exec(text)?.[1];
  return { provider: (m[1] ?? m[2])!, app };
}

/** Meetings a transcript sweep read: what it says it read, plus the meeting named on each item it made ("Delta Weekly 15:00"). */
export function scannedFrom(report: AgentReport, created: Item[]): Array<{ title: string; start?: string }> {
  const out: Array<{ title: string; start?: string }> = [...(report.meetings ?? [])];
  for (const i of created) {
    const m = /^(.*\S)\s+(\d{1,2}):(\d{2})$/.exec(i.source.label ?? "");
    if (!m) continue;
    const d = new Date();
    d.setHours(Number(m[2]), Number(m[3]), 0, 0);
    if (d.getTime() > Date.now()) continue; // a later time today = some other day's meeting; can't place it
    out.push({ title: m[1]!, start: d.toISOString() });
  }
  return out;
}

function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ensureSiteLink() {
  if (!SITE_POSTS || !config.workspace.obsidianVault) return;
  try {
    lstatSync(SITE_LINK);
  } catch {
    try {
      mkdirSync(WIKI_DRAFTS, { recursive: true });
      symlinkSync(SITE_POSTS, SITE_LINK);
    } catch {}
  }
}

/** Blog drafts already on disk: scratch + wiki drafts + unpublished site posts. */
function listDrafts(): string[] {
  const out: string[] = [];
  const scratch = config.workspace.scratchDir;
  for (const dir of [scratch, WIKI_DRAFTS]) {
    try {
      for (const f of readdirSync(dir)) if (f.endsWith(".md") && (dir === WIKI_DRAFTS || /blog/i.test(f))) out.push(`${dir}/${f}`);
    } catch {}
  }
  if (SITE_POSTS) try {
    for (const f of readdirSync(SITE_POSTS)) {
      if (!f.endsWith(".md")) continue;
      const head = readFileSync(`${SITE_POSTS}/${f}`, "utf8").slice(0, 600);
      if (/^draft:\s*true/m.test(head)) out.push(`${SITE_POSTS}/${f}`);
    }
  } catch {}
  return out;
}

function describeTool(name: string, args: any): string {
  if (name === "bash") return `$ ${String(args?.command ?? "").split("\n")[0]!.slice(0, 90)}`;
  if (name === "read") return `read ${String(args?.path ?? "").replace(process.env.HOME ?? "", "~")}`;
  // pi built-in MCP: `codemode` scripts call tools.mcp__<server>__<tool>(...); direct tools are mcp__<server>__<tool>.
  if (name === "codemode") {
    const code = String(args?.code ?? "");
    const calls = [...new Set([...code.matchAll(/tools\.mcp__[a-z0-9_]+?__([a-z0-9_]+)/gi)].map((m) => m[1]!))];
    return `codemode ${calls.join(", ")}`.trim().slice(0, 100);
  }
  if (name === "mcp" || name.startsWith("mcp")) {
    const code: string = args?.args?.code ?? args?.code ?? "";
    const calls = [...code.matchAll(/codemode\.([a-z_]+)/g)].map((m) => m[1]!.replace(/^[a-z]+(?:_[a-z]+)*?_(?:mcp_server|mcp)_/, ""));
    const tool = String(args?.tool ?? (name.startsWith("mcp__") ? name : "")).replace(/^.*__/, "");
    return `mcp ${tool} ${calls.length ? calls.join(", ") : ""}`.slice(0, 100);
  }
  return name;
}
