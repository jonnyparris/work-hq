// GitLab MR state for items whose ref is an MR, so "where does this stand?"
// cards don't ask about work that already merged (10-17: two items marked
// "Waiting" on MRs merged three days earlier).
//
// tick() is synchronous and runs every 30s; glab is not. So lookups read a
// cache and start a fetch in the background when the entry is missing or old.
// The prompter holds the card until the first answer lands (one tick), and
// asks as before if glab fails.

import type { Item } from "../shared/types.ts";
import { RefCache, runCli } from "./ref-cache.ts";

export type MrState = "opened" | "merged" | "closed" | "locked" | "unknown";
export interface MrInfo {
  state: MrState;
  mergedAt?: string;
}
export interface MrRef {
  url: string;
  host: string;
  project: string;
  iid: number;
}

/** "https://gitlab.x/group/repo/-/merge_requests/12#note_3" → ref. Anything else → undefined. */
export function parseMrRef(u: string): MrRef | undefined {
  try {
    const url = new URL(u);
    const m = /^\/(.+?)\/-\/merge_requests\/(\d+)\/?$/.exec(url.pathname);
    if (!m) return undefined;
    return { url: `${url.origin}/${m[1]}/-/merge_requests/${m[2]}`, host: url.host, project: m[1]!, iid: Number(m[2]) };
  } catch {
    return undefined;
  }
}

/** The item's MR refs: its links, then its source URL. Deduped, anchors (#note_…) ignored. */
export function mrRefs(it: Pick<Item, "links" | "source">): MrRef[] {
  const out = new Map<string, MrRef>();
  for (const u of [...(it.links ?? []), it.source.url ?? ""]) {
    const r = parseMrRef(u);
    if (r && !out.has(r.url)) out.set(r.url, r);
  }
  return [...out.values()];
}

/**
 * What the MRs say about the item: "pending" while a lookup is in flight, "merged" when every MR merged
 * (mergedAt = the latest), otherwise undefined (no MRs, any still open/closed, or glab failed — ask as before).
 */
export type MrVerdict = "pending" | { merged: true; mergedAt?: string; refs: MrRef[] } | undefined;

type Fetch = (ref: MrRef) => Promise<MrInfo>;

const OPEN_TTL = 30 * 60_000;
const FAIL_TTL = 10 * 60_000;

export class MrStates {
  private cache: RefCache<MrRef, MrInfo>;

  constructor(fetch: Fetch = glabFetch) {
    const ttl = (i: MrInfo) => (i.state === "merged" || i.state === "closed" ? Infinity : i.state === "unknown" ? FAIL_TTL : OPEN_TTL);
    this.cache = new RefCache(fetch, ttl, { state: "unknown" });
  }

  verdict(it: Pick<Item, "links" | "source">): MrVerdict {
    const now = Date.now();
    const refs = mrRefs(it);
    if (!refs.length) return undefined;
    const infos = refs.map((r) => this.cache.get(r, now));
    if (infos.some((i) => i === undefined)) return "pending";
    if (!infos.every((i) => i!.state === "merged")) return undefined;
    const mergedAt = infos.map((i) => i!.mergedAt ?? "").sort().pop() || undefined;
    return { merged: true, mergedAt, refs };
  }

  /** Forget what's cached for these items' refs: the next verdict looks them up again. */
  forget(items: Array<Pick<Item, "links" | "source">>) {
    this.cache.forget(items.flatMap((it) => mrRefs(it).map((r) => r.url)));
  }

  /** How many of the item's refs the last lookup couldn't read (glab / gh / Access failed). */
  failed(it: Pick<Item, "links" | "source">) {
    return mrRefs(it).filter((r) => this.cache.peek(r.url)?.state === "unknown").length;
  }

  /** Resolves when every lookup started so far has landed. For tests and the CLI. */
  settled() {
    return this.cache.settled();
  }
}

/** One `glab api` call. Never throws: a failure is state "unknown". */
export async function glabFetch(ref: MrRef): Promise<MrInfo> {
  const path = `projects/${encodeURIComponent(ref.project)}/merge_requests/${ref.iid}`;
  const out = await runCli("glab", ["api", "--hostname", ref.host, path], 20_000);
  try {
    const j = JSON.parse(out) as { state?: string; merged_at?: string | null };
    const state = (["opened", "merged", "closed", "locked"].includes(j.state ?? "") ? j.state : "unknown") as MrState;
    return { state, mergedAt: j.merged_at ?? undefined };
  } catch {
    return { state: "unknown" };
  }
}
