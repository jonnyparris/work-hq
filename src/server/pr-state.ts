// GitHub PR state for items that link a PR, so they reach the same "merged" cards as GitLab MRs and JIRA
// tickets (10-20: it_mvf98j7ouzp8x waited on agent-memory-mcp PRs #19/#20 and nothing looked them up).
//
// One `gh api repos/<o>/<r>/pulls/<n>` per PR, through RefCache. gh not installed, logged out, or rate-limited
// → "unknown", which keeps the item off the card, never closes it.

import type { Item } from "../shared/types.ts";
import { RefCache, runCli } from "./ref-cache.ts";

export type PrState = "open" | "merged" | "closed" | "unknown";
export interface PrInfo {
  state: PrState;
  mergedAt?: string;
}
export interface PrRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

/** "https://github.com/o/r/pull/12/files#r3" → ref. Only github.com; anything else → undefined. */
export function parsePrRef(u: string): PrRef | undefined {
  try {
    const url = new URL(u);
    if (url.host !== "github.com" && url.host !== "www.github.com") return undefined;
    const m = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/(?:files|commits|checks)?)?\/?$/.exec(url.pathname);
    if (!m) return undefined;
    return { url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
  } catch {
    return undefined;
  }
}

/** The item's PR refs: its links, then its source URL. Deduped. */
export function prRefs(it: Pick<Item, "links" | "source">): PrRef[] {
  const out = new Map<string, PrRef>();
  for (const u of [...(it.links ?? []), it.source.url ?? ""]) {
    const r = parsePrRef(u);
    if (r && !out.has(r.url)) out.set(r.url, r);
  }
  return [...out.values()];
}

/** "pending" while a lookup is in flight; every PR merged → refs + latest mergedAt; otherwise undefined. */
export type PrVerdict = "pending" | { merged: true; mergedAt?: string; refs: PrRef[] } | undefined;

type Fetch = (ref: PrRef) => Promise<PrInfo>;

const OPEN_TTL = 30 * 60_000;
const FAIL_TTL = 10 * 60_000;

export class PrStates {
  private cache: RefCache<PrRef, PrInfo>;

  constructor(fetch: Fetch = ghFetch) {
    // Closed PRs can be reopened, but rarely; a restart re-reads them.
    const ttl = (i: PrInfo) => (i.state === "merged" || i.state === "closed" ? Infinity : i.state === "unknown" ? FAIL_TTL : OPEN_TTL);
    this.cache = new RefCache(fetch, ttl, { state: "unknown" });
  }

  verdict(it: Pick<Item, "links" | "source">): PrVerdict {
    const now = Date.now();
    const refs = prRefs(it);
    if (!refs.length) return undefined;
    const infos = refs.map((r) => this.cache.get(r, now));
    if (infos.some((i) => i === undefined)) return "pending";
    if (!infos.every((i) => i!.state === "merged")) return undefined;
    const mergedAt = infos.map((i) => i!.mergedAt ?? "").sort().pop() || undefined;
    return { merged: true, mergedAt, refs };
  }

  /** Forget what's cached for these items' refs: the next verdict looks them up again. */
  forget(items: Array<Pick<Item, "links" | "source">>) {
    this.cache.forget(items.flatMap((it) => prRefs(it).map((r) => r.url)));
  }

  /** The item's PRs the cache says closed without merging (no lookup). */
  closed(it: Pick<Item, "links" | "source">): string[] {
    return prRefs(it).filter((r) => this.cache.peek(r.url)?.state === "closed").map((r) => r.url);
  }

  /** How many of the item's refs the last lookup couldn't read (glab / gh / Access failed). */
  failed(it: Pick<Item, "links" | "source">) {
    return prRefs(it).filter((r) => this.cache.peek(r.url)?.state === "unknown").length;
  }

  settled() {
    return this.cache.settled();
  }
}

/** Parse a REST pulls/<n> response. merged_at set → merged; closed without it → closed; anything else → unknown. */
export function parsePull(body: string): PrInfo {
  try {
    const j = JSON.parse(body) as { state?: string; merged_at?: string | null; number?: number };
    if (typeof j.number !== "number") return { state: "unknown" };
    if (j.merged_at) return { state: "merged", mergedAt: j.merged_at };
    return { state: j.state === "open" ? "open" : j.state === "closed" ? "closed" : "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

/** One `gh api` call. Never throws: a failure is "unknown". */
export async function ghFetch(ref: PrRef): Promise<PrInfo> {
  return parsePull(await runCli("gh", ["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`], 20_000, true));
}
