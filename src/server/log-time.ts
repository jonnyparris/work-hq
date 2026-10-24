// Timestamps on every server log line. launchd writes stdout/stderr straight to
// ~/Library/Logs/work-hq.log, so without these a log line can't be tied to a job
// (10-23: couldn't prove why job_mvk4yyv2kw6e6 failed at boot).

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
const STAMPED = Symbol.for("work-hq.stamped-console");

/** Prefix each console line with an ISO time. Leading newlines stay in front, so blank spacer lines still work. */
export function stampConsole(c: Console = console, now: () => Date = () => new Date()) {
  const marked = c as Console & { [STAMPED]?: true };
  if (marked[STAMPED]) return; // bun --hot re-runs index.ts: don't stamp twice
  marked[STAMPED] = true;
  for (const m of METHODS) {
    const orig = c[m].bind(c);
    c[m] = (...args: unknown[]) => {
      const stamp = `[${now().toISOString()}]`;
      if (typeof args[0] !== "string") return orig(stamp, ...args);
      const [, lead, rest] = /^(\n*)([\s\S]*)$/.exec(args[0])!;
      return orig(`${lead}${stamp} ${rest}`, ...args.slice(1));
    };
  }
}
