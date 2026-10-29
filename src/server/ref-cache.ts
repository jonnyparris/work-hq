// The cache behind MrStates, JiraStates and PrStates. tick() is synchronous and runs every 30s; glab, gh and
// JIRA are not. So get() returns what's cached and starts a background fetch when the entry is missing or older
// than its TTL. A failed fetch is cached as `failed` (never as landed), so a stale token can't close an item.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";

export class RefCache<Ref extends { url: string }, Info> {
  private cache = new Map<string, Info & { checkedAt: number }>();
  private inflight = new Map<string, Promise<void>>();
  /** Lookups running now, and the ones queued for a slot. A recheck starts ~100 at once: 100 glabs, or 30
   *  cloudflared + JIRA calls, and a third of the JIRA ones came back unknown. */
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(
    private fetch: (ref: Ref) => Promise<Info>,
    /** How long a cached answer holds, by its content. */
    private ttl: (info: Info) => number,
    /** What a thrown fetch is cached as. */
    private failed: Info,
    private maxActive = 6,
  ) {}

  /** Cached info (stale-but-present entries too), starting a refresh if missing or stale. */
  get(ref: Ref, now = Date.now()): Info | undefined {
    const hit = this.cache.get(ref.url);
    if ((!hit || now - hit.checkedAt > this.ttl(hit)) && !this.inflight.has(ref.url)) {
      const p = this.limited(ref)
        .catch(() => this.failed)
        .then((info) => void this.cache.set(ref.url, { ...info, checkedAt: Date.now() }))
        .finally(() => this.inflight.delete(ref.url));
      this.inflight.set(ref.url, p);
    }
    return hit;
  }

  /** The cached answer, without starting a lookup. */
  peek(url: string): Info | undefined {
    return this.cache.get(url);
  }

  /** Drop cached answers, so the next get() looks again ("Recheck"). Lookups in flight carry on. */
  forget(urls: Iterable<string>) {
    for (const u of urls) this.cache.delete(u);
  }

  /** At most maxActive fetches at once. A finished one hands its slot straight to the next in line. */
  private async limited(ref: Ref): Promise<Info> {
    if (this.active >= this.maxActive) await new Promise<void>((r) => this.queue.push(r));
    else this.active++;
    try {
      return await this.fetch(ref);
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }

  /** Resolves when every lookup started so far has landed. For tests and the CLI. */
  async settled() {
    while (this.inflight.size) await Promise.all(this.inflight.values());
  }
}

/** Run a CLI (glab, gh) and return stdout, "" on failure or timeout. launchd hands us a bare PATH, so widen it. */
export function runCli(cmd: string, args: string[], timeoutMs: number, okOnly = false): Promise<string> {
  const extra = [dirname(process.execPath), `${homedir()}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"];
  const env = { ...process.env, PATH: [...extra, process.env.PATH ?? "/usr/bin:/bin"].join(":") };
  return new Promise((resolve) => {
    let stdout = "";
    const proc = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.on("data", (d) => (stdout += d));
    const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);
    proc.on("close", (code) => (clearTimeout(timer), resolve(okOnly && code !== 0 ? "" : stdout)));
    proc.on("error", () => (clearTimeout(timer), resolve("")));
  });
}
