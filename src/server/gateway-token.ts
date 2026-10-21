// One model-gateway token for every headless pi run.
//
// pi's provider key is often a shell command (`cloudflared access token -app=…`). Every run used to fork
// it, and a lapsed login surfaced as one failure per run. Here the server fetches the token once,
// hands it to pi through the env var the key command already prefers, and refreshes it
// shortly before the JWT expires or when a run reports an auth failure.

import { spawn } from "node:child_process";

export interface TokenSource {
  /** Env var pi's key command reads first, e.g. OPENCODE_CF_TOKEN. */
  env: string;
  /** Shell command that prints the token. */
  command: string;
}

const REFRESH_EARLY_MS = 5 * 60_000;
const FALLBACK_TTL_MS = 30 * 60_000;
const FAIL_BACKOFF_MS = 2 * 60_000;

/** `exp` from a JWT, in ms. Undefined if it isn't a JWT. */
export function jwtExpiry(token: string): number | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const exp = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")).exp;
    return typeof exp === "number" ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class GatewayToken {
  private token?: string;
  private until = 0;
  /** JWT expiry of the current token, if it is a JWT. */
  private exp?: number;
  private failedAt = Number.NEGATIVE_INFINITY;
  private inflight?: Promise<string | undefined>;
  lastError?: string;

  constructor(private src: TokenSource | undefined, private run = runCommand) {}

  /**
   * Env to merge into a pi run. Empty when unset or the command fails (pi falls back to its own command).
   * `minTtlMs`: also empty when the token expires sooner than that. pi's key command prefers the env var
   * over minting, so a long-lived session (cmux) handed a token near expiry would keep sending it after it
   * lapsed; with nothing passed it mints its own.
   */
  async env(now = Date.now(), minTtlMs = 0): Promise<Record<string, string>> {
    if (!this.src) return {};
    const t = await this.get(now);
    if (!t) return {};
    if (minTtlMs > 0 && this.exp !== undefined && this.exp - now < minTtlMs) return {};
    return { [this.src.env]: t };
  }

  async get(now = Date.now()): Promise<string | undefined> {
    if (!this.src) return undefined;
    if (this.token && now < this.until) return this.token;
    if (!this.token && now - this.failedAt < FAIL_BACKOFF_MS) return undefined;
    this.inflight ??= this.fetch(now).finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  /** A run hit an auth error: don't reuse this token. */
  invalidate() {
    this.token = undefined;
    this.until = 0;
    this.exp = undefined;
    this.failedAt = Number.NEGATIVE_INFINITY;
  }

  private async fetch(now: number) {
    const r = await this.run(this.src!.command);
    const t = r.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (r.code !== 0 || !t || /\s/.test(t)) {
      this.token = undefined;
      this.failedAt = now;
      this.lastError = (r.stderr.trim() || r.stdout.trim()).split("\n").pop() ?? `exit ${r.code}`;
      return undefined;
    }
    const exp = jwtExpiry(t);
    if (exp && exp - REFRESH_EARLY_MS <= now) {
      // Already (nearly) expired: pass nothing and let pi's own command surface the login problem.
      this.token = undefined;
      this.failedAt = now;
      this.lastError = "token expired";
      return undefined;
    }
    this.token = t;
    this.exp = exp;
    this.until = exp ? exp - REFRESH_EARLY_MS : now + FALLBACK_TTL_MS;
    this.lastError = undefined;
    return t;
  }
}

function runCommand(command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}` } });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => p.kill("SIGKILL"), 20_000);
    p.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    p.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    p.on("close", (code) => {
      clearTimeout(t);
      done({ code, stdout, stderr });
    });
    p.on("error", (e) => {
      clearTimeout(t);
      done({ code: -1, stdout, stderr: String(e) });
    });
  });
}
