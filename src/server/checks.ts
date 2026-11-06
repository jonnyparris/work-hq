// Morning checks: plain shell commands (no pi, no tokens) that run once per
// workday at the start of the day, so their findings are on the board before
// the morning plan is answered. A check with `everyMin` runs on that interval
// during work hours instead (e.g. agent runs that keep failing), and toasts
// only when it finds something new. A check prints an AgentReport-shaped JSON
// object on stdout — `{ "items": [{ "title", "kind", "source": { "key" } … }] }`.
//
// Every item needs a stable `source.key`. An item a check reported before and
// no longer reports is closed as done ("check no longer reports it"), so a
// fixed problem leaves the board on its own. Items the owner already closed
// stay closed, and an agent's Waiting or Done stands. An open item (Waiting included) still closes when the
// check stops reporting it, and only that close is undone when the check reports it again: the problem came
// back, so it's back in the inbox even if the owner had touched it (hub.ts quietStatus).
//
// A check may also send `questions` about its own items: point at one with
// `itemKey` (its source.key) and give a stable `key`; they're asked once.
//
// The exit code is ignored when stdout parses: "found something" commonly
// exits 1. No JSON on stdout is a failure, recorded in sync state as an error.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { AgentReport, Item } from "../shared/types.ts";
import { config } from "./config.ts";
import { nowIso } from "./db.ts";
import type { Hub } from "./hub.ts";
import { extractJson } from "./agents.ts";

export interface CheckConfig {
  /** Short name; shows as the item's source label. */
  name: string;
  /** Run with `sh -c` in workspace.dir. */
  command: string;
  timeoutSec?: number;
  /** Local "HH:MM": don't run before this time of day (e.g. "17:00" for an
   *  end-of-day check ahead of the nightly run). Default: from dayStart. */
  after?: string;
  /** Run every N minutes (after `after`, in work hours) instead of once a day. */
  everyMin?: number;
}

const syncName = (c: CheckConfig) => `check:${c.name}`;

/** Which of this check's open items the latest run no longer reports. */
export function staleCheckItems(items: Item[], checkName: string, report: AgentReport): Item[] {
  const keys = new Set((report.items ?? []).map((i) => i.source?.key).filter(Boolean));
  return items.filter(
    (i) =>
      i.source.type === "check" &&
      i.source.label === checkName &&
      !["done", "dropped"].includes(i.status) &&
      i.source.key &&
      !keys.has(i.source.key),
  );
}

/**
 * Daily check: true when it has not succeeded today (since `after`, if set) and has not been tried in the last hour.
 * With `everyMin`: true when it has not been tried in the last `everyMin` minutes (and it's past `after`).
 */
export function checkDue(state: { lastOkAt?: string; lastRunAt?: string }, now = new Date(), after?: string, everyMin?: number): boolean {
  const m = after?.match(/^(\d{1,2}):(\d{2})$/);
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), m ? +m[1] : 0, m ? +m[2] : 0);
  if (now < from) return false;
  if (everyMin && everyMin > 0) return !state.lastRunAt || now.getTime() - Date.parse(state.lastRunAt) >= everyMin * 60_000;
  if (state.lastOkAt && Date.parse(state.lastOkAt) >= from.getTime()) return false;
  return !state.lastRunAt || now.getTime() - Date.parse(state.lastRunAt) > 60 * 60_000;
}

export class Checks {
  private running = new Set<string>();

  constructor(private hub: Hub) {}

  /** Run every due check. Called from the scheduler's cadence during work hours. */
  async runDue(now = new Date()) {
    for (const c of config.checks) {
      if (checkDue(this.hub.store.syncState(syncName(c)), now, c.after, c.everyMin)) await this.run(c);
    }
  }

  /** Source keys of this check's open items. */
  private openKeys(name: string): string[] {
    return this.hub.store
      .items()
      .filter((i) => i.source.type === "check" && i.source.label === name && !["done", "dropped"].includes(i.status) && i.source.key)
      .map((i) => i.source.key!);
  }

  async run(c: CheckConfig) {
    if (this.running.has(c.name)) return;
    this.running.add(c.name);
    const name = syncName(c);
    this.hub.putSync({ ...this.hub.store.syncState(name), lastRunAt: nowIso() });
    try {
      const { stdout, stderr, code } = await exec(c.command, (c.timeoutSec ?? 120) * 1000);
      const report = extractJson<AgentReport>(stdout);
      if (!report || !Array.isArray(report.items)) {
        const error = `exit ${code}, no JSON report: ${(stderr || stdout).trim().slice(-200)}`;
        this.hub.putSync({ ...this.hub.store.syncState(name), error });
        console.error(`[check ${c.name}]`, error);
        return;
      }
      const items = report.items
        .filter((i) => i.source?.key)
        .map((i) => ({ ...i, source: { ...i.source, type: "check" as const, label: c.name } }));
      const questions = (report.questions ?? [])
        .filter((q) => q.itemKey && items.some((i) => i.source.key === q.itemKey))
        .map((q) => ({ ...q, key: `check:${c.name}:${q.key ?? q.itemKey}`, once: true }));
      const wasOpen = new Set(this.openKeys(c.name));
      this.hub.ingestReport({ items, questions });
      for (const it of staleCheckItems(this.hub.store.items(), c.name, { items })) {
        this.hub.setStatus(it.id, "done", `${c.name} no longer reports it`, "agent", false, { checkClosed: nowIso() });
      }
      this.hub.putSync({ ...this.hub.store.syncState(name), lastOkAt: nowIso(), error: undefined, cursor: `${items.length} open` });
      // Interval checks re-report the same items every few minutes: toast only what's new.
      const fresh = c.everyMin ? items.filter((i) => !wasOpen.has(i.source.key!)).length : items.length;
      if (fresh) this.hub.toast(`${c.name}: ${fresh} ${c.everyMin ? "new " : ""}to look at`, "warn");
    } finally {
      this.running.delete(c.name);
    }
  }
}

function exec(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  // launchd hands us a bare PATH; checks usually want bun, glab, brew tools.
  const extra = [dirname(process.execPath), `${homedir()}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"];
  const env = { ...process.env, PATH: [...extra, process.env.PATH ?? "/usr/bin:/bin"].join(":") };
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", command], { cwd: config.workspace.dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: String(e), code: null });
    });
  });
}
