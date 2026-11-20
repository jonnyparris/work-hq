// Agents working on this machine that Work HQ didn't launch: pi (or opencode, claude) sessions the owner
// opened in cmux himself, mr-workflow authors, nightly-reflect. RunCap used to count only Work HQ's own jobs,
// so with 6 of ours running and nothing else open, 16 jobs sat queued for an hour while load was 11 of 24
// (11-20). `pi.maxAgents` is a budget for every agent on the machine: Work HQ gets what the others leave.
//
// Source: cmux's hook records (~/.cmuxterm/<agent>-hook-sessions.json). cmux writes one per agent process
// (subagents too, under their parent's surface) with `agentLifecycle` "running" from UserPromptSubmit to
// Stop. It reads them without the socket, so a busy cmux can't stall a launch. A record counts while its
// pid is alive and, when cmux recorded it, started when the record says (a session killed mid-turn never writes
// Stop, and its pid can be reused), and it was updated within STALE_MS (3 h: records don't update mid-turn).
// The count refreshes in the background (OtherAgents): RunCap reads the last one and never waits on a file or `ps`.

import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface HookRecord {
  agentLifecycle?: string;
  pid?: number;
  surfaceId?: string;
  workspaceId?: string;
  /** Unix seconds. */
  updatedAt?: number;
  /** When the pid's process started, unix seconds (cmux records it). */
  pidStartSeconds?: number;
}

/** The fields we use, type-checked; undefined for a record missing one. A non-number start = not recorded. */
function toRecord(v: unknown): HookRecord | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  if (!(typeof r.pid === "number" && typeof r.updatedAt === "number" && typeof r.agentLifecycle === "string" && typeof r.surfaceId === "string")) return undefined;
  return {
    pid: r.pid,
    updatedAt: r.updatedAt,
    agentLifecycle: r.agentLifecycle,
    surfaceId: r.surfaceId,
    workspaceId: typeof r.workspaceId === "string" ? r.workspaceId : undefined,
    pidStartSeconds: typeof r.pidStartSeconds === "number" ? r.pidStartSeconds : undefined,
  };
}

/** A pid `ps -p` and `kill` can take: macOS ps rejects the whole list over one above 99999 (its pids stop at 99998), and kill(-1) means every process. */
const validPid = (p: number) => Number.isInteger(p) && p > 0 && p <= 0x7fffffff && (process.platform !== "darwin" || p < 100_000);

/**
 * A "running" record this old no longer counts: a turn whose Stop hook never came. cmux updates a record only on
 * prompt submit and Stop, not per tool call, so a working turn's record ages the whole turn: 11-20, five live
 * sessions mid-turn had records 50-58 min old. A dead or reused pid is caught by the start-time check instead.
 * Two costs: a live session whose Stop was lost holds one share of `pi.maxAgents` this long, and a real turn longer
 * than this stops counting (Work HQ may run one more than the budget per such turn; pi.maxLoad still applies). The floor
 * holds either way.
 */
export const STALE_MS = 3 * 3600_000;

/** Elapsed seconds from `ps -o etime` ([[dd-]hh:]mm:ss), or undefined. */
export function parseEtime(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return undefined;
  const [, d = "0", h = "0", min, sec] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}

/**
 * Start time (unix seconds, to the second) of each of `pids` still running, from one `ps` call. Undefined when `ps`
 * itself failed: callers fall back to bare liveness rather than read every agent as gone.
 */
export function processStarts(pids: number[], clock: () => number = Date.now): Promise<Map<number, number> | undefined> {
  const ok = pids.filter(validPid);
  if (!ok.length) return Promise.resolve(new Map());
  return new Promise((done) => {
    // ps exits 1 with nothing on stderr when none of the pids is running: that's an answer (all gone), not a failure.
    execFile("ps", ["-o", "pid=,etime=", "-p", ok.join(",")], { timeout: 5_000 }, (err, stdout, stderr) => {
      if (err && !((err as { code?: unknown }).code === 1 && !String(stderr).trim())) return done(undefined);
      // etime is measured when ps ran, so the clock is read here, not when the call was queued.
      const now = clock();
      const out = new Map<number, number>();
      for (const line of String(stdout).split("\n")) {
        const [pid, etime] = line.trim().split(/\s+/);
        const elapsed = parseEtime(etime ?? "");
        if (pid && elapsed !== undefined) out.set(Number(pid), Math.floor(now / 1000) - elapsed);
      }
      done(out);
    });
  });
}

/** Liveness alone, for when `ps` failed. */
function aliveStarts(pids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of pids.filter(validPid)) {
    try {
      process.kill(p, 0);
      out.set(p, Number.NaN); // alive, start unknown
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "EPERM") out.set(p, Number.NaN);
    }
  }
  return out;
}

/** `ps` rounds to the second and runs a moment after `now`: a pid started within this of the record's start is the same process. */
const START_SLACK_S = 5;

/** Each pid's newest record, kept when it says "running", is fresh and isn't in `exclude` (Work HQ's own job workspaces). */
export function runningRecords(records: Iterable<HookRecord>, exclude: Set<string>, now = Date.now()): HookRecord[] {
  const newest = new Map<number, HookRecord>();
  for (const r of records) {
    if (!r.pid) continue;
    const prev = newest.get(r.pid);
    if (!prev || (r.updatedAt ?? 0) > (prev.updatedAt ?? 0)) newest.set(r.pid, r);
  }
  return [...newest.values()].filter(
    (r) => r.agentLifecycle === "running" && r.surfaceId && !(r.workspaceId && exclude.has(r.workspaceId)) && now - (r.updatedAt ?? 0) * 1000 <= STALE_MS,
  );
}

/**
 * Surfaces with an agent process mid-turn, given each live pid's start (`starts`; NaN = alive, start unknown).
 * One per surface: a session's subagents share its surface, and a subagent still running counts even if its
 * parent's turn ended. RunCap counts Work HQ's own jobs from the store, so `runningRecords` leaves those out.
 */
export function workingSurfaces(running: HookRecord[], starts: Map<number, number>): Set<string> {
  const out = new Set<string>();
  for (const r of running) {
    const at = starts.get(r.pid!);
    if (at === undefined) continue; // gone
    const known = Number.isFinite(at) && r.pidStartSeconds !== undefined && Number.isFinite(r.pidStartSeconds);
    if (known && Math.abs(at - r.pidStartSeconds!) > START_SLACK_S) continue; // pid reused
    out.add(r.surfaceId!);
  }
  return out;
}

/** Every record in the hook-session files under `dir`. A file mid-write or unreadable is skipped. */
export async function readHookRecords(dir = resolve(homedir(), ".cmuxterm")): Promise<HookRecord[]> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith("-hook-sessions.json"));
  } catch {
    return [];
  }
  const files = await Promise.all(names.map((n) => readFile(resolve(dir, n), "utf8").catch(() => "")));
  return files.flatMap((text) => {
    try {
      const sessions = JSON.parse(text)?.sessions;
      return sessions && typeof sessions === "object" ? Object.values(sessions).flatMap((v) => toRecord(v) ?? []) : [];
    } catch {
      return [];
    }
  });
}

/** A refresh past this is given up: `ps` has its own 5 s timeout, this bounds everything else. */
export const REFRESH_TIMEOUT_MS = 15_000;

/**
 * How many other agents are working now. `working()` returns the last count at once (undefined before the first
 * one) and, when it's older than `ttlMs`, starts a refresh in the background: RunCap asks while launches wait, the
 * scheduler every 15 s, both from the event loop, and `ps` can be slow under load. Files are read async and re-parsed only when an mtime changed; the
 * synchronous steps (directory listings, a stat per file, the JSON.parse of the ~4 MB pi file, the store's live jobs,
 * the filtering) take ~30-90 ms. A refresh that hasn't settled in REFRESH_TIMEOUT_MS is given up (last count kept, and
 * nothing it finds later is written) so it can't block the next.
 * `onChange` runs when the count changes, so held launches go without waiting for the scheduler's next pump.
 */
export class OtherAgents {
  private at = Number.NEGATIVE_INFINITY;
  private count?: number;
  private stamp = "";
  private records: HookRecord[] = [];
  private inflight?: Promise<number | undefined>;
  /** Bumped per refresh and on its timeout: only the latest refresh may write, so a late one can't undo a newer count. */
  private gen = 0;
  onChange?: () => void;
  constructor(
    private exclude: () => Set<string>,
    // WORK_HQ_CMUX_HOOKS_DIR: tests point it at an empty dir so nothing reads the real cmux records.
    private dir = process.env.WORK_HQ_CMUX_HOOKS_DIR || resolve(homedir(), ".cmuxterm"),
    private ttlMs = 10_000,
    private starts: (pids: number[]) => Promise<Map<number, number> | undefined> = (p) => processStarts(p),
  ) {}

  working(now = Date.now()): number | undefined {
    if (now - this.at >= this.ttlMs) void this.refresh(now);
    return this.count;
  }

  /** Re-count now (one at a time: a call during a refresh gets that refresh). Resolves with the new count. */
  refresh(now = Date.now()): Promise<number | undefined> {
    if (!this.inflight) {
      this.at = now;
      const gen = ++this.gen;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<number | undefined>((done) => {
        timer = setTimeout(() => {
          if (this.gen === gen) this.gen++; // abandoned: whatever it finds later is stale
          done(this.count);
        }, REFRESH_TIMEOUT_MS);
      });
      this.inflight = Promise.race([this.recount(now, gen), timeout]).finally(() => {
        clearTimeout(timer);
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async recount(now: number, gen: number): Promise<number | undefined> {
    const before = this.count;
    const current = () => this.gen === gen;
    try {
      const stamp = this.mtimes();
      let records = this.records;
      if (stamp !== this.stamp) {
        records = await readHookRecords(this.dir);
        if (!current()) return this.count;
        this.records = records;
        this.stamp = stamp;
      }
      const running = runningRecords(records, this.exclude(), now);
      const pids = running.map((r) => r.pid!);
      const starts = (await this.starts(pids).catch(() => undefined)) ?? aliveStarts(pids);
      if (!current()) return this.count;
      this.count = workingSurfaces(running, starts).size;
    } catch {
      // keep the last count; the next working() past the ttl tries again
    }
    if (current() && this.count !== before) {
      try {
        this.onChange?.();
      } catch {}
    }
    return this.count;
  }

  private mtimes() {
    try {
      return readdirSync(this.dir)
        .filter((n) => n.endsWith("-hook-sessions.json"))
        .map((n) => `${n}:${statSync(resolve(this.dir, n)).mtimeMs}`)
        .join("|");
    } catch {
      return "";
    }
  }
}
