// Provider rate limits. Two defences:
//   1. LaunchGate — space pi launches out so a burst of dispatches can't trip a
//      per-minute provider limit (e.g. "Grammar compilation rate limit exceeded",
//      20/min per organisation) all at once.
//   2. isRateLimited + backoffMs — when a run dies on one of those errors anyway,
//      wait 60–90 s and try again, at most `maxRetries` times.
//
// pi already retries these errors itself, but with 2/4/8 s backoff — all inside the
// same minute, so a per-minute limit outlasts it. This is the slow outer loop.

/** Errors worth waiting out. Deliberately narrow: quota/billing exhaustion is not here. */
const RATE_LIMIT = new RegExp(
  [
    "grammar compilation rate limit",
    "rate.?limit(ed)? exceeded",
    "too many requests",
    "\\b429\\b",
    "\\b503\\b",
    "temporarily unavailable",
    "service.?unavailable",
    "overloaded",
  ].join("|"),
  "i",
);
const NOT_TRANSIENT = /insufficient_quota|quota exceeded|billing|out of budget|usage limit reached/i;

export function isRateLimited(text: string | undefined): boolean {
  if (!text) return false;
  return RATE_LIMIT.test(text) && !NOT_TRANSIENT.test(text);
}

/**
 * Network blips that end a turn: pi's "Request timed out." / "Connection error.", a cut stream. Not rate limits
 * (isRateLimited) and not auth. 10-19 and 10-22: 13 job sessions stalled on these until the owner typed "retry".
 */
const TRANSIENT = new RegExp(
  [
    "request timed out",
    "connection error",
    "^terminated\\.?$",
    "stream ended (before|without)",
    "socket hang up",
    "fetch failed",
    "\\bECONNRESET\\b",
    "\\bETIMEDOUT\\b",
    "\\bECONNREFUSED\\b",
  ].join("|"),
  "i",
);
const NOT_BLIP = /auth|api key|\b401\b|\b403\b|unauthori[sz]ed|quota|billing/i;

export function isTransient(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  return TRANSIENT.test(t) && !NOT_BLIP.test(t) && !isRateLimited(t);
}

/** 60–90 s by default, jittered so parallel retries don't land together again. */
export function backoffMs(o: { minSec: number; maxSec: number }, rand = Math.random) {
  const lo = Math.max(0, o.minSec);
  const hi = Math.max(lo, o.maxSec);
  return Math.round((lo + (hi - lo) * rand()) * 1000);
}

/**
 * Hands out launch slots at least `spacingMs` apart, in call order.
 * `acquire()` resolves when the caller may start its process.
 */
export class LaunchGate {
  private next = 0;
  constructor(
    private spacingMs: () => number,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Milliseconds the next caller would wait right now. */
  wait() {
    return Math.max(0, this.next - this.now());
  }

  async acquire(): Promise<number> {
    const t = this.now();
    const slot = Math.max(t, this.next);
    this.next = slot + Math.max(0, this.spacingMs());
    const delay = slot - t;
    if (delay > 0) await this.sleep(delay);
    return delay;
  }
}

/**
 * Caps how many action jobs run at once. LaunchGate only spaces launches out; on 10-21 a burst of
 * 35-57 dispatches an hour had 20-25 pi sessions working together (load average 255 on 12 cores),
 * and every test suite on the machine timed out. Launches past the cap wait here, first come first served.
 *
 * `running()` counts jobs already running (read from the store, so a restart keeps the count). A waiter
 * that is let through holds a reservation until it calls the release function `acquire` resolved with
 * (once its job is marked running, or failed to launch), so two waiters can't take the same free slot.
 * Call `pump()` whenever a job stops running; waiters whose job is gone (`wanted()` false) are dropped.
 * Admission only: a blocked session that the owner resumes counts again at once, so the count can sit
 * above the cap; new launches then wait until it drops below.
 *
 * `overloaded()` (pi.maxLoad) also holds launches while the machine's load is high, whatever the job
 * count: load is what actually hurts, the count is a proxy. It only holds while at least one job is
 * running or reserved, so load from outside Work HQ can't stall the queue with nothing of ours to finish.
 * Load falls without any job stopping, so the owner must also call `pump()` on a timer.
 */
export class RunCap {
  private queue: Array<{ wanted: () => boolean; go: (release: () => void) => void; drop: () => void }> = [];
  private reserved = 0;
  constructor(private max: () => number, private running: () => number, private overloaded: () => boolean = () => false) {}

  /** Why a launch now would wait: the job cap, high load, or neither. */
  blocker(): "cap" | "load" | undefined {
    const max = this.max();
    const busy = this.running() + this.reserved;
    if (max > 0 && busy >= max) return "cap";
    if (busy > 0 && this.overloaded()) return "load";
    return undefined;
  }

  /** Jobs waiting for a slot, cancelled ones included until the next pump. */
  get waiting() {
    return this.queue.length;
  }

  /** True when a launch now would have to wait. A max of 0 or less turns the job cap off; the load gate is separate. */
  full() {
    return this.queue.some((w) => w.wanted()) || this.blocker() !== undefined;
  }

  /**
   * Resolves with a release function once a slot is free, or with `undefined` if the job stopped
   * being wanted while it waited. Call the release function exactly once (extra calls are ignored).
   */
  acquire(wanted: () => boolean = () => true): Promise<(() => void) | undefined> {
    return new Promise((resolve) => {
      this.queue.push({ wanted, go: resolve, drop: () => resolve(undefined) });
      this.pump();
    });
  }

  pump() {
    while (this.queue.length) {
      const head = this.queue[0]!;
      if (!head.wanted()) {
        this.queue.shift();
        head.drop();
        continue;
      }
      if (this.blocker()) return;
      this.queue.shift();
      this.reserved++;
      let done = false;
      head.go(() => {
        if (done) return;
        done = true;
        this.reserved--;
        this.pump();
      });
    }
  }
}
