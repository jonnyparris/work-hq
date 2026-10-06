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
