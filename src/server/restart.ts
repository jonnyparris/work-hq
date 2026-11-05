// Restart on request, but not on top of a headless run.
//
// `whq land` used to kickstart the server straight away. A headless job (calendar/transcripts sweep, triage, work fallback) dies
// with the process, and the boot pass starts a fresh calendar sweep, so a burst of landings killed one sweep after
// another (10-21: five "server restarted mid-run" by 11:00, 90 boots in the log). Now land asks the server
// (POST /api/restart); the server runs its own repo's `restart` command once no headless job is live, holding new
// scheduled sweeps meanwhile. Several landings while it waits fold into one restart. cmux jobs survive a restart
// (the server picks them up again), so they don't hold it.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Job } from "../shared/types.ts";
import { config } from "./config.ts";

/** The checkout this server runs from. */
export const SERVER_ROOT = resolve(import.meta.dir, "../..");

/**
 * Restart anyway after this long: a stuck sweep shouldn't keep new code out forever. Sweeps time out at 20 min.
 * Headless work-fallback jobs can run 120 min; one still running at 25 min dies. Deliberate: new code beats it.
 */
export const MAX_HOLD_MS = 25 * 60_000;

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Headless jobs a restart would kill. `except`: the landing job itself, if it runs headless, mustn't wait on itself. */
export function blockers(live: Job[], except = new Set<string>()): Job[] {
  return live.filter((j) => j.surface === "headless" && ["queued", "running"].includes(j.status) && !except.has(j.id));
}

export interface RestartAnswer {
  /** now: restarting straight away. queued: waiting on `waitingFor`. */
  status: "now" | "queued";
  waitingFor: string[];
  pid: number;
}

export class RestartGate {
  pending?: { since: number; reasons: string[] };
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private o: {
      live: () => Job[];
      /** Runs the restart. Default: the matching repo rule's `restart` command, detached. */
      run?: (command: string) => void;
      command?: string | undefined;
      now?: () => number;
      pollMs?: number;
    },
  ) {}

  /** The restart command for this checkout, from config `repos` (the rule whose dir is SERVER_ROOT). */
  static commandFor(root = SERVER_ROOT, rules = config.repos) {
    const me = real(root);
    return rules.find((r) => real(r.dir) === me && r.restart)?.restart;
  }

  /** True when `repo` is this server's checkout and there's a restart command to run. */
  handles(repo: string) {
    return Boolean(this.command) && real(repo) === real(SERVER_ROOT);
  }

  get command() {
    return this.o.command;
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  request(reason: string): RestartAnswer {
    if (!this.pending) this.pending = { since: this.now(), reasons: [] };
    this.pending.reasons.push(reason);
    const waiting = blockers(this.o.live(), new Set(this.pending.reasons));
    if (!waiting.length) {
      this.fire("no headless jobs running");
      return { status: "now", waitingFor: [], pid: process.pid };
    }
    console.log(`[restart] held for ${waiting.length} headless job(s): ${waiting.map((j) => j.title).join(", ")}`);
    this.timer ??= setInterval(() => this.check(), this.o.pollMs ?? 5_000);
    return { status: "queued", waitingFor: waiting.map((j) => j.title), pid: process.pid };
  }

  /** Called on a timer while a restart is pending. Returns true once it fired. */
  check() {
    if (!this.pending) return false;
    const waiting = blockers(this.o.live(), new Set(this.pending.reasons));
    if (waiting.length && this.now() - this.pending.since < MAX_HOLD_MS) return false;
    this.fire(waiting.length ? `held ${Math.round(MAX_HOLD_MS / 60_000)} min, restarting anyway over ${waiting.map((j) => j.title).join(", ")}` : "headless jobs finished");
    return true;
  }

  private fire(why: string) {
    const p = this.pending;
    this.pending = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    console.log(`[restart] ${why}; restarting for ${p?.reasons.length ?? 0} landing(s): ${p?.reasons.join(", ") ?? ""}`);
    const command = this.command!;
    // Let the HTTP answer go out first.
    setTimeout(() => (this.o.run ?? runDetached)(command), 300);
  }
}

function runDetached(command: string) {
  const child = Bun.spawn(["bash", "-c", command], { cwd: SERVER_ROOT, stdio: ["ignore", "ignore", "inherit"] });
  child.unref();
}
