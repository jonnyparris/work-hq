// Headless pi over its RPC mode: JSONL commands on stdin, responses and events on stdout.
//
// Why not `pi -p "<prompt>"`: endpoint security (SentinelOne) SIGKILLs any exec whose argv holds a
// string over ~1 KB ("path too long to check"). Over stdin, prompt size doesn't matter. RPC also gives
// a clean abort (the run settles, the session is saved), live events, and a process we can keep warm.
//
// Two shapes:
//   PiRpc  — one pi process. Tool runs get their own (own env, kill to cancel, crash stays contained).
//   PiPool — warm, tool-less workers for triage, each with a fresh session armed for the next request.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Anything longer goes over stdin or into a file. Well under the ~1 KB that gets a process killed. */
export const MAX_ARG_BYTES = 512;

export function assertShortArgs(args: string[]) {
  for (const a of args) {
    const n = Buffer.byteLength(a);
    if (n > MAX_ARG_BYTES) {
      throw new Error(`argv string of ${n} bytes (> ${MAX_ARG_BYTES}): endpoint security kills execs like this. Send it over stdin or in a file.`);
    }
  }
}

export interface PiRpcOptions {
  bin: string;
  /** CLI args after `--mode rpc` (model, thinking, tool flags, --session…). */
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface RunOptions {
  /** Whole-run deadline. */
  timeoutMs: number;
  /** Abort if no event arrives for this long (a stalled run, not a busy one). */
  idleMs?: number;
  onEvent?: (ev: any) => void;
  /** After the deadline's abort, how long to wait for it to settle before SIGKILL. */
  killAfterMs?: number;
}

export interface RunOutcome {
  ok: boolean;
  text: string;
  /** The model's own error message, if the last turn stopped on one. */
  lastError?: string;
  session?: string;
  toolsRan: boolean;
  timedOut?: boolean;
  stalled?: boolean;
  aborted?: boolean;
  /** Set when the process died mid-run. */
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  stderr: string;
}

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export class PiRpc {
  private proc?: ChildProcess;
  private buf = "";
  private decoder = new StringDecoder("utf8");
  private seq = 0;
  private pending = new Map<string, { resolve: (d: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(ev: any) => void>();
  private exitWaiters: Array<() => void> = [];
  stderr = "";
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  runs = 0;
  lastUsed = Date.now();
  readonly startedAt = Date.now();

  constructor(readonly opts: PiRpcOptions) {}

  get alive() {
    return Boolean(this.proc) && !this.exit;
  }

  start() {
    const args = ["--mode", "rpc", ...this.opts.args];
    assertShortArgs(args);
    const proc = spawn(this.opts.bin, args, { cwd: this.opts.cwd, env: this.opts.env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr!.on("data", (c: Buffer) => (this.stderr = (this.stderr + c.toString()).slice(-4000)));
    proc.stdin!.on("error", () => {}); // EPIPE after the child died; the exit handler reports it
    const died = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exit) return;
      this.exit = { code, signal };
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`pi exited (${signal ?? code})`));
      }
      this.pending.clear();
      this.emit({ type: "__exit", code, signal });
      for (const w of this.exitWaiters.splice(0)) w();
    };
    proc.on("exit", died);
    proc.on("error", (e) => {
      this.stderr += `\n${String(e)}`;
      died(null, null);
    });
  }

  // ── framing: split on LF only (readline would also split on U+2028/2029 inside JSON strings) ──
  private onData(chunk: Buffer) {
    this.buf += this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      this.onRecord(rec);
    }
  }

  private onRecord(rec: any) {
    if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
      const p = this.pending.get(rec.id)!;
      this.pending.delete(rec.id);
      clearTimeout(p.timer);
      if (rec.success === false) p.reject(new Error(rec.error ?? `${rec.command} failed`));
      else p.resolve(rec.data);
      return;
    }
    // Nobody is there to answer a dialog (permission asks, questions). Decline, like print mode does.
    if (rec.type === "extension_ui_request" && DIALOGS.has(rec.method)) this.send({ type: "extension_ui_response", id: rec.id, cancelled: true });
    this.emit(rec);
  }

  private emit(ev: any) {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {}
    }
  }

  subscribe(fn: (ev: any) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private send(obj: unknown) {
    if (!this.alive) return;
    this.proc!.stdin!.write(`${JSON.stringify(obj)}\n`);
  }

  request<T = any>(type: string, extra: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error(`pi not running${this.exit ? ` (exited ${this.exit.signal ?? this.exit.code})` : ""}`));
    const id = `r${++this.seq}`;
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`pi didn't answer ${type} in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.send({ id, type, ...extra });
    });
  }

  /** Send one prompt and wait until pi won't continue on its own (`agent_settled`), dies, or a deadline hits. */
  async run(message: string, o: RunOptions): Promise<RunOutcome> {
    this.runs++;
    this.lastUsed = Date.now();
    let text = "";
    let lastError: string | undefined;
    let toolsRan = false;
    let timedOut = false;
    let stalled = false;
    let lastEvent = Date.now();
    let abortedAt: number | undefined;

    let off = () => false as boolean;
    const settled = new Promise<{ aborted?: boolean; exit?: RunOutcome["exit"] }>((done) => {
      off = this.subscribe((ev) => {
        lastEvent = Date.now();
        if (ev.type === "__exit") {
          off();
          return done({ exit: { code: ev.code, signal: ev.signal } });
        }
        if (ev.type === "tool_execution_start") toolsRan = true;
        else if (ev.type === "message_end" && ev.message?.role === "assistant") {
          const t = (ev.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          if (t) text = t;
          lastError = ev.message.stopReason === "error" ? ev.message.errorMessage : undefined;
        } else if (ev.type === "agent_settled") {
          off();
          return done({ aborted: Boolean(ev.aborted) });
        }
        o.onEvent?.(ev);
      });
    });

    const watchdog = setInterval(() => {
      const now = Date.now();
      if (!timedOut && !stalled && now - this.lastUsed > o.timeoutMs) timedOut = true;
      else if (!timedOut && !stalled && o.idleMs && now - lastEvent > o.idleMs) stalled = true;
      else return;
      abortedAt = now;
      // Ask nicely first; if it won't settle, the race below kills the process.
      void this.request("abort", {}, 10_000).catch(() => this.kill());
    }, Math.min(1000, o.timeoutMs, o.idleMs ?? Infinity));

    let fin: { aborted?: boolean; exit?: RunOutcome["exit"] };
    try {
      const accepted = await this.request<{ disposition?: string }>("prompt", { message }, 60_000);
      if (accepted?.disposition === "handled") {
        clearInterval(watchdog);
        off();
        return { ok: false, text: "", toolsRan, stderr: this.stderr, lastError: "prompt was consumed by an extension; no run started" };
      }
      fin = await Promise.race([
        settled,
        // Belt and braces: abort was sent at the deadline; if nothing settles 15 s later, give up on this process.
        new Promise<typeof fin>((done) => {
          const t = setInterval(() => {
            // checked every 200 ms so short test deadlines work too
            if ((timedOut || stalled) && Date.now() - (abortedAt ?? Infinity) > (o.killAfterMs ?? 15_000)) {
              clearInterval(t);
              this.kill();
              done({ aborted: true });
            }
          }, 200);
          void settled.then(() => clearInterval(t));
        }),
      ]);
    } catch (e) {
      fin = this.exit ? { exit: this.exit } : { aborted: true };
      if (!this.exit) lastError ??= (e as Error).message;
    } finally {
      clearInterval(watchdog);
      off();
      this.lastUsed = Date.now();
    }

    let session: string | undefined;
    if (this.alive) {
      try {
        const st = await this.request<{ sessionFile?: string; sessionId?: string }>("get_state", {}, 5_000);
        session = st?.sessionFile ?? st?.sessionId;
      } catch {}
    }
    const ok = !fin.exit && !fin.aborted && !timedOut && !stalled && !lastError;
    return { ok, text, lastError, session, toolsRan, timedOut, stalled, aborted: fin.aborted, exit: fin.exit, stderr: this.stderr };
  }

  private kill() {
    try {
      this.proc?.kill("SIGKILL");
    } catch {}
  }

  private waitExit(ms: number) {
    if (!this.alive) return Promise.resolve(true);
    return new Promise<boolean>((done) => {
      const t = setTimeout(() => done(false), ms);
      this.exitWaiters.push(() => {
        clearTimeout(t);
        done(true);
      });
    });
  }

  /** Close stdin (pi shuts down cleanly), then SIGTERM, then SIGKILL. */
  async stop(graceMs = 3000) {
    if (!this.alive) return;
    try {
      this.proc!.stdin!.end();
    } catch {}
    if (await this.waitExit(graceMs)) return;
    try {
      this.proc!.kill("SIGTERM");
    } catch {}
    if (await this.waitExit(2000)) return;
    this.kill();
    await this.waitExit(2000);
  }
}

// ── warm pool for tool-less triage ────────────────────────────────────────

export interface PoolOptions {
  /** Warm workers kept around. Extra concurrent requests get a one-off worker. */
  size: number;
  make: () => PiRpc;
  maxRuns?: number;
  maxIdleMs?: number;
  maxAgeMs?: number;
  /** Changes when pi or its extensions are updated; a worker started under an older stamp is retired. */
  stamp?: () => string;
}

export class PiPool {
  private idle: Array<{ w: PiRpc; stamp: string }> = [];
  private busy = new Set<PiRpc>();
  /** Workers re-arming a session after a run; a request waits for one rather than starting a process. */
  private arming = new Set<Promise<void>>();
  private stopped = false;

  constructor(private o: PoolOptions) {}

  private fresh(w: PiRpc, stamp: string) {
    const now = Date.now();
    return (
      w.alive &&
      w.runs < (this.o.maxRuns ?? 50) &&
      now - w.lastUsed < (this.o.maxIdleMs ?? 30 * 60_000) &&
      now - w.startedAt < (this.o.maxAgeMs ?? 2 * 3600_000) &&
      stamp === (this.o.stamp?.() ?? "")
    );
  }

  private async take(): Promise<{ w: PiRpc; pooled: boolean; stamp: string }> {
    if (!this.idle.length && this.arming.size) {
      await Promise.race([Promise.race(this.arming), new Promise((r) => setTimeout(r, 5000))]);
    }
    while (this.idle.length) {
      const e = this.idle.pop()!;
      if (this.fresh(e.w, e.stamp)) {
        this.busy.add(e.w);
        return { ...e, pooled: true };
      }
      void e.w.stop();
    }
    const stamp = this.o.stamp?.() ?? "";
    const w = this.o.make();
    w.start();
    const pooled = this.busy.size + this.arming.size < this.o.size;
    if (pooled) this.busy.add(w);
    return { w, pooled, stamp };
  }

  /** Run one prompt. `onStart` hands back a cancel function for this run. */
  async run(message: string, o: RunOptions & { onStart?: (cancel: () => void) => void }): Promise<RunOutcome> {
    const { w, pooled, stamp } = await this.take();
    o.onStart?.(() => void w.request("abort", {}, 10_000).catch(() => w.stop()));
    let r: RunOutcome | undefined;
    try {
      r = await w.run(message, o);
      return r;
    } finally {
      this.busy.delete(w);
      const p = this.release(w, pooled, stamp, r).finally(() => this.arming.delete(p));
      this.arming.add(p);
    }
  }

  private async release(w: PiRpc, pooled: boolean, stamp: string, r?: RunOutcome): Promise<void> {
    const bad = !r || r.exit || r.timedOut || r.stalled;
    if (this.stopped || !pooled || bad || !this.fresh(w, stamp) || this.idle.length >= this.o.size) return w.stop();
    // Arm a clean session now, off the critical path, so the next request starts straight away.
    try {
      const res = await w.request<{ cancelled?: boolean }>("new_session", {}, 30_000);
      if (res?.cancelled) return w.stop();
      if (this.stopped) return w.stop();
      this.idle.push({ w, stamp });
    } catch {
      void w.stop();
    }
  }

  /** Start the warm workers ahead of the first request. */
  warm() {
    while (!this.stopped && this.idle.length + this.busy.size < this.o.size) {
      const stamp = this.o.stamp?.() ?? "";
      const w = this.o.make();
      w.start();
      this.idle.push({ w, stamp });
    }
  }

  get stats() {
    return { idle: this.idle.length, busy: this.busy.size };
  }

  async stop() {
    this.stopped = true;
    const all = [...this.idle.map((e) => e.w), ...this.busy];
    this.idle = [];
    await Promise.all(all.map((w) => w.stop(1000)));
  }
}

/** mtime of the pi install and of the agent's npm packages (extensions). Changes on update. */
export function piStamp(bin: string, agentDir = process.env.PI_CODING_AGENT_DIR ?? resolve(process.env.HOME ?? "", ".pi/agent")) {
  const m = (p: string) => {
    try {
      return existsSync(p) ? String(statSync(realpathSync(p)).mtimeMs) : "";
    } catch {
      return "";
    }
  };
  return [m(bin), m(resolve(agentDir, "npm/node_modules/.package-lock.json")), m(resolve(agentDir, "settings.json"))].join(":");
}
