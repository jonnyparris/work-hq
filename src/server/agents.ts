// Everything that runs pi. Three shapes:
//   sweep   — headless, read-only, scheduled (transcripts, calendar). Streams into the dashboard.
//   triage  — headless, no tools, fast. Turns the owner's words into state changes.
//   action  — interactive pi in a cmux workspace. Anything the owner dispatches. Highly visible.

import { type BulkRequest, deferHorizon } from "../shared/batch.ts";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ActionKind, AgentReport, Item, Job, JobKind } from "../shared/types.ts";
import * as cmux from "./cmux.ts";
import { config } from "./config.ts";
import { newId, nowIso } from "./db.ts";
import { type DemoScript, demoActionScript, demoSweepScript, feedLine } from "./demo.ts";
import type { Dispatcher, Hub } from "./hub.ts";
import { backoffMs, isRateLimited, LaunchGate } from "./launch-gate.ts";
import {
  actionPrompt, calendarPrompt, calendarSweepPrompt, openUrl, postSweepPrompt, schedulePrompt, SITE_LINK, SITE_POSTS,
  transcriptSweepPrompt, triagePrompt, WIKI_DRAFTS,
} from "./prompts.ts";

const modelArgs = () => (config.pi.model ? ["--model", config.pi.model] : []);
const backoff = () => backoffMs({ minSec: config.pi.rateLimitBackoffSec[0] ?? 60, maxSec: config.pi.rateLimitBackoffSec[1] ?? 90 });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RESUME_NUDGE = "Your last request failed on a provider rate limit. Carry on from where you stopped.";

type RunResult = { ok: boolean; text: string; error?: string; session?: string; toolsRan?: boolean };

interface Running {
  statusPath?: string;
  seenWork: boolean;
  proc?: ReturnType<typeof spawn>;
  /** cmux: rate-limit nudges sent so far, and the pending one (if any). */
  rateRetries?: number;
  retry?: { at: number; seq: number; sent?: number };
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

export class Agents implements Dispatcher {
  private running = new Map<string, Running>();
  /** Every pi launch goes through here, so bursts can't trip per-minute provider limits. */
  readonly gate = new LaunchGate(() => config.pi.launchSpacingSec * 1000);

  constructor(private hub: Hub) {
    hub.dispatcher = this;
    ensureSiteLink();
    // Pick up cmux jobs that were running when the server restarted.
    for (const job of hub.store.jobs(100)) {
      if (job.surface === "cmux" && job.status === "queued" && !job.workspace) {
        // Was waiting on the launch gate; never started.
        hub.putJob({ ...job, status: "failed", error: "server restarted before launch", finishedAt: nowIso() });
      } else if (job.surface === "cmux" && ["running", "blocked", "queued"].includes(job.status)) {
        this.running.set(job.id, { statusPath: resolve(cmux.jobDir(job.id), "status.json"), seenWork: true });
      } else if (job.surface === "headless" && ["running", "queued"].includes(job.status)) {
        hub.putJob({ ...job, status: "failed", error: "server restarted mid-run", finishedAt: nowIso() });
      }
    }
  }

  private newJob(kind: JobKind, name: string, title: string, surface: Job["surface"], itemId?: string): Job {
    return this.hub.putJob({ id: newId("job"), kind, name, title, surface, status: "queued", itemId, tail: [], createdAt: nowIso() });
  }

  private patch(id: string, p: Partial<Job>) {
    const cur = this.hub.store.job(id);
    if (cur) return this.hub.putJob({ ...cur, ...p });
  }

  private line(id: string, text: string) {
    const cur = this.hub.store.job(id);
    if (cur) this.hub.putJob({ ...cur, tail: [...cur.tail, text].slice(-12) });
  }

  // ── actions (cmux) ─────────────────────────────────────────────────────
  async dispatch(itemId: string, action: ActionKind, note?: string) {
    const item = this.hub.store.item(itemId);
    if (!item) return undefined;
    const title = `${ACTION_LABEL[action]} · ${item.title}`.slice(0, 80);
    const useCmux = Boolean(config.cmux.bin) && cmux.cmuxAvailable();
    const job = this.newJob("action", action, title, useCmux ? "cmux" : "headless", itemId);
    // Verifying doesn't change what the item *is*; everything else means someone's on it.
    if (action !== "verify") this.hub.updateItem(itemId, { status: "doing" });
    if (config.demo) {
      void this.launchDemoAction(job.id, title, demoActionScript(item, action, note), useCmux);
      return this.hub.store.job(job.id);
    }
    const prompt = actionPrompt(job.id, item, action, note);
    // Launch in the background: the gate may hold it for a while and callers shouldn't wait.
    void this.launchAction(job.id, title, prompt, useCmux);
    return this.hub.store.job(job.id);
  }

  private async launchAction(jobId: string, title: string, prompt: string, useCmux: boolean) {
    if (useCmux) {
      const wait = this.gate.wait();
      if (wait > 0) {
        this.line(jobId, `⏳ queued ${Math.ceil(wait / 1000)} s — spacing launches`);
        this.hub.toast(`Queued: ${title} — launching in ${Math.ceil(wait / 1000)} s`, "info");
      }
      await this.gate.acquire();
      if (this.hub.store.job(jobId)?.status !== "queued") return; // cancelled while waiting
      const launched = cmux.launchInCmux({
        jobId: jobId,
        title,
        prompt,
        cwd: config.workspace.dir,
        piArgs: [...modelArgs(), "-n", `work-hq: ${title}`],
      });
      if (launched) {
        this.running.set(jobId, { statusPath: launched.statusPath, seenWork: false });
        this.hub.toast(`Dispatched to cmux: ${title}`, "good");
        return this.patch(jobId, { status: "running", workspace: launched.workspace, startedAt: nowIso(), tail: ["▸ launched in cmux · Work HQ group"] });
      }
      this.line(jobId, "cmux launch failed — falling back to headless");
    }
    // No cmux: run headless with full tools. Still visible in the dashboard feed.
    const r = await this.runHeadless(jobId, prompt, { tools: true, thinking: "medium", perms: false, timeoutMin: 45 });
    this.finishAction(jobId, r);
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
        this.running.delete(id);
        this.finishAction(id, { ok: b.outcome !== "error", text: "", error: b.outcome === "error" ? b.detail ?? "model error" : undefined });
      } else if (b.state === "exited") {
        this.running.delete(id);
        this.finishAction(id, { ok: job.reported ?? false, text: "", error: job.reported ? undefined : `pi exited (${b.code ?? "?"})` });
      }
    }
  }

  /** Close cmux workspaces whose job finished and whose session has sat idle past the threshold. */
  pruneCmux(now = Date.now()) {
    const hours = config.cmux.pruneIdleHours;
    if (config.demo || !config.cmux.bin || !(hours > 0)) return [];
    const all = cmux.jobWorkspaces();
    if (!all) return [];
    const idle = cmux.pickIdle(all, { now, idleMs: hours * 3600_000, busy: new Set(this.running.keys()), idleSince: cmux.idleSince });
    const closed = idle.filter((w) => cmux.closeWorkspace(w.id));
    for (const w of closed) {
      const job = this.hub.store.job(w.jobId);
      if (job?.workspace) this.patch(job.id, { workspace: undefined, tail: [...job.tail, `▸ cmux workspace closed after ${hours}h idle`].slice(-12) });
    }
    if (closed.length) console.log(`[cmux] closed ${closed.length} idle workspace(s) (> ${hours}h): ${closed.map((w) => w.jobId).join(", ")}`);
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
          ...(job.workspace ? [{ id: "look", label: "Show me the session", tone: "quiet" as const, effect: { type: "noop" as const } }] : []),
        ],
      });
    }
    this.hub.emit({ type: "notify", data: { title: r.ok ? "Agent finished" : "Agent failed", body: job.title } });
  }

  // ── sweeps (headless) ──────────────────────────────────────────────────
  private sweeping = new Set<string>();

  async sweep(name: "transcripts" | "calendar", opts: { since?: string } = {}) {
    if (this.sweeping.has(name)) return;
    if (config.demo) {
      this.sweeping.add(name);
      return this.demoSweep(name).finally(() => this.sweeping.delete(name));
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
        return;
      }
      const { created } = this.hub.ingestReport({ ...report, jobId: job.id, eventsThrough: through }, name === "transcripts" ? "transcript" : "calendar");
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
  async triage(utterance: string, mode: "chat" | "pineapple" | "review" = "chat"): Promise<TriageResult & { jobId: string }> {
    const job = this.newJob("triage", mode, mode === "pineapple" ? `🍍 ${utterance.slice(-60)}` : utterance.slice(0, 80), "headless");
    const prompt = triagePrompt(utterance, { now: new Date(), items: this.hub.store.items(), events: this.hub.todayEvents(), questions: this.hub.store.questions("open") }, mode);
    const r = await this.runHeadless(job.id, prompt, { tools: false, thinking: config.pi.triageThinking, perms: false, timeoutMin: 4 });
    const result = extractJson<TriageResult>(r.text);
    if (!r.ok || !result) {
      this.patch(job.id, { status: "failed", error: r.error ?? "couldn't parse triage output", finishedAt: nowIso() });
      return { jobId: job.id, reply: "Triage failed — kept your words in the journal." };
    }
    await this.applyTriage(result, mode);
    this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: result.reply });
    return { ...result, jobId: job.id };
  }

  private async applyTriage(t: TriageResult, mode: string) {
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
    if (t.question?.prompt) {
      this.hub.ask({
        kind: "open",
        key: `triage:${Date.now()}`,
        priority: 80,
        prompt: t.question.prompt,
        options: (t.question.options?.length ? t.question.options : ["Yes", "No"]).map((l, i) => ({
          id: `o${i}`,
          label: l,
          tone: i === 0 ? "primary" : "quiet",
          effect: { type: "noop" },
        })),
      });
    }
    for (const d of t.dispatch ?? []) {
      const id = d.id.startsWith("new:") ? created[Number(d.id.slice(4))]?.id : d.id;
      if (id) await this.dispatch(id, d.action, d.note);
    }
    for (const c of t.calendar ?? []) {
      const id = c.id.startsWith("new:") ? created[Number(c.id.slice(4))]?.id : c.id;
      const item = id ? this.hub.store.item(id) : undefined;
      if (!item || !c.start || Number.isNaN(Date.parse(c.start))) continue;
      if (item.scheduledFor !== c.start) this.hub.schedule(item.id, c.start, item.when ?? new Date(c.start).toLocaleString());
      void this.calendarBlock(item.id, c.start, c.durationMin ?? 30);
    }
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
    this.patch(job.id, { status: "done", finishedAt: nowIso(), summary: out.reply ?? `Scheduled ${label}` });
    const cal = out.calendar === "create" ? " — adding it to your calendar" : out.calendar === "exists" ? " — I'll remind you then" : " — I'll remind you";
    this.hub.toast(`${out.reply ?? `Scheduled ${label}`}${out.reply ? "" : cal}`, "good");
    if (out.calendar === "create") void this.calendarBlock(itemId, at, out.durationMin ?? 30);
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

  private cancelled(jobId: string) {
    return this.hub.store.job(jobId)?.error === "cancelled";
  }

  private runHeadlessOnce(
    jobId: string,
    prompt: string,
    o: { tools: boolean; thinking: string; perms: boolean; timeoutMin: number },
    resume?: string,
  ): Promise<RunResult> {
    // Belt and braces: demo mode never gives pi tools (sweeps and actions are scripted above).
    if (config.demo && o.tools) return Promise.resolve({ ok: false, text: "", error: "demo mode: no tool runs" });
    const job = this.hub.store.job(jobId)!;
    const args = ["-p", "--mode", "json", ...modelArgs(), "--thinking", o.thinking];
    if (o.tools) args.push("-a", "-n", `work-hq: ${job.title}`, "-xt", config.pi.headlessDenyTools);
    else args.push("-nt", "-nc", "-ns", "-np", "--no-session");
    if (resume) args.push("--session", resume);
    const promptPath = resolve(cmux.jobDir(jobId), "prompt.md");
    writeFileSync(promptPath, prompt);
    args.push(resume ? RESUME_NUDGE : `Read ${promptPath} and follow the instructions in it exactly.`);
    if (!o.tools) args[args.length - 1] = prompt; // no read tool without tools

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...cmux.tlsEnv(),
      PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
      WORK_HQ_JOB: jobId,
      WORK_HQ_URL: `http://127.0.0.1:${config.port}`,
    };
    if (o.perms) Object.assign(env, config.pi.headlessEnv);

    this.patch(jobId, { status: "running", startedAt: nowIso() });
    return new Promise((done) => {
      const proc = spawn(config.pi.bin, args, { cwd: config.workspace.dir, env, stdio: ["ignore", "pipe", "pipe"] });
      this.running.set(jobId, { seenWork: true, proc });
      let buf = "";
      let lastText = "";
      let lastError: string | undefined;
      let toolsRan = Boolean(resume);
      let stderr = "";
      let session: string | undefined = resume;
      const timer = setTimeout(() => proc.kill("SIGTERM"), o.timeoutMin * 60_000);
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
      proc.on("close", (code) => {
        clearTimeout(timer);
        this.running.delete(jobId);
        if (session) this.patch(jobId, { session });
        const base = { text: lastText, session, toolsRan };
        if (code === 0 && !lastError) done({ ok: true, ...base });
        else done({ ok: false, ...base, error: lastError ?? `pi exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}` });
      });
      proc.on("error", (e) => {
        clearTimeout(timer);
        this.running.delete(jobId);
        done({ ok: false, text: "", error: String(e) });
      });
    });
  }

  cancel(jobId: string) {
    const r = this.running.get(jobId);
    r?.proc?.kill("SIGTERM");
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
  if (name === "mcp" || name.startsWith("mcp")) {
    const code: string = args?.args?.code ?? args?.code ?? "";
    const calls = [...code.matchAll(/codemode\.([a-z_]+)/g)].map((m) => m[1]!.replace(/^[a-z]+(?:_[a-z]+)*?_(?:mcp_server|mcp)_/, ""));
    const tool = String(args?.tool ?? "").replace(/^.*__/, "");
    return `mcp ${tool} ${calls.length ? calls.join(", ") : ""}`.slice(0, 100);
  }
  return name;
}
