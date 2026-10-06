// Morning checks: plain shell commands (no pi, no tokens) that run once per
// workday at the start of the day, so their findings are on the board before
// the morning plan is answered. A check prints an AgentReport-shaped JSON
// object on stdout — `{ "items": [{ "title", "kind", "source": { "key" } … }] }`.
//
// Every item needs a stable `source.key`. An item a check reported before and
// no longer reports is closed as done ("check no longer reports it"), so a
// fixed problem leaves the board on its own. Items the owner already closed
// stay closed: re-imports never clobber a confirmed status (see Hub.updateItem).
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

/** True when the check has not succeeded today and has not been tried in the last hour. */
export function checkDue(state: { lastOkAt?: string; lastRunAt?: string }, now = new Date()): boolean {
  const today = now.toDateString();
  if (state.lastOkAt && new Date(state.lastOkAt).toDateString() === today) return false;
  return !state.lastRunAt || now.getTime() - Date.parse(state.lastRunAt) > 60 * 60_000;
}

export class Checks {
  private running = new Set<string>();

  constructor(private hub: Hub) {}

  /** Run every due check. Called from the scheduler's cadence during work hours. */
  async runDue(now = new Date()) {
    for (const c of config.checks) {
      if (checkDue(this.hub.store.syncState(syncName(c)), now)) await this.run(c);
    }
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
      this.hub.ingestReport({ items });
      for (const it of staleCheckItems(this.hub.store.items(), c.name, { items })) {
        this.hub.setStatus(it.id, "done", `${c.name} no longer reports it`, "agent");
      }
      this.hub.putSync({ ...this.hub.store.syncState(name), lastOkAt: nowIso(), error: undefined, cursor: `${items.length} open` });
      if (items.length) this.hub.toast(`${c.name}: ${items.length} to look at`, "warn");
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
