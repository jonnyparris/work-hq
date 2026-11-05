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

/** "merged-not-landed": GitLab says Merged, but the code isn't on the target branch (a no-op merge of a branch
 *  behind its target on a fast-forward project: api-worker !1691, !1723). Never counts as landed. */
export type MrState = "opened" | "merged" | "merged-not-landed" | "closed" | "locked" | "unknown";
export interface MrInfo {
  state: MrState;
  mergedAt?: string;
  /** Why "merged-not-landed" (or a landing lookup that failed): one line for a card. */
  landing?: string;
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
 * and landed (mergedAt = the latest), otherwise undefined (no MRs, any still open/closed, merged but not on its
 * target, or glab failed — ask as before).
 */
export type MrVerdict = "pending" | { merged: true; mergedAt?: string; refs: MrRef[] } | undefined;

type Fetch = (ref: MrRef) => Promise<MrInfo>;

const OPEN_TTL = 30 * 60_000;
const FAIL_TTL = 10 * 60_000;
/** A merge that didn't land is usually relanded within days: look again every 30 min. */
const NOT_LANDED_TTL = 30 * 60_000;

export class MrStates {
  private cache: RefCache<MrRef, MrInfo>;

  constructor(fetch: Fetch = glabFetch) {
    const ttl = (i: MrInfo) =>
      i.state === "merged" || i.state === "closed" ? Infinity : i.state === "unknown" ? FAIL_TTL : i.state === "merged-not-landed" ? NOT_LANDED_TTL : OPEN_TTL;
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

  /** The item's MRs GitLab calls merged whose code isn't on the target branch, from the cache (no lookup). */
  notLanded(it: Pick<Item, "links" | "source">): Array<MrRef & { landing?: string }> {
    return mrRefs(it).flatMap((r) => {
      const i = this.cache.peek(r.url);
      return i?.state === "merged-not-landed" ? [{ ...r, landing: i.landing }] : [];
    });
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

/** A GitLab REST GET: parsed JSON, or undefined when the call failed. Tests pass a stub. */
export type GitLabGet = (ref: MrRef, path: string) => Promise<unknown>;

const glabGet: GitLabGet = async (ref, path) => {
  const out = await runCli("glab", ["api", "--hostname", ref.host, path], 20_000, true);
  try {
    return out ? JSON.parse(out) : undefined;
  } catch {
    return undefined;
  }
};

/** glab lookups. Never throws: a failure is state "unknown". */
export function glabFetch(ref: MrRef): Promise<MrInfo> {
  return fetchMr(ref, glabGet);
}

interface RestMr {
  state?: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  sha?: string | null;
  target_branch?: string;
}
interface RestCommit {
  id: string;
  title: string;
  authored_date?: string;
  parent_ids?: string[];
}

/** Target commits this close to merged_at are the merge itself (rebase on merge rewrites SHAs, keeps titles). */
const MERGE_WINDOW_MS = 15 * 60_000;
/** Bound on target-branch pages (100 commits each) read per landing check. */
const MAX_TARGET_PAGES = 20;
/** Bound on MR commit pages (100 each). */
const MAX_MR_PAGES = 5;
/** A landing check holds one of RefCache's lookup slots: give up (unknown, retried in 10 min) after this long. */
const LANDING_BUDGET_MS = 90_000;

/**
 * The MR's state, and for a merge, whether its code reached the target. GitLab's "Merged" isn't proof: on a
 * fast-forward project a merge of a branch that's behind its target can push nothing (n=0) and still read Merged.
 * Null merge/squash SHAs aren't proof the other way: rebase-on-merge leaves both null on every good merge too
 * (77 of 100 api-worker merges). So, like the MR workflow's verify-landing script (stricter: author date must match):
 *  1. a merge or squash commit → landed (GitLab only records one it pushed);
 *  2. the head SHA reachable from the target → landed;
 *  3. a non-default target → landed: a stacked MR ships through its parent MR, which carries the check;
 *  4. every non-merge MR commit on the target, matched by title and author date (rebase and cherry-pick keep both),
 *     looked for around merged_at (rebased on merge), then before it (already there: a "merge main into staging"
 *     MR whose commits reached staging first), then after it (relanded) → landed;
 *  5. otherwise "merged-not-landed". Any failed lookup, or running out of time, → "unknown", never landed.
 * The head-SHA check (2) failing isn't an error: a rebased head is on no branch, and a GC'd one 404s.
 */
export async function fetchMr(ref: MrRef, get: GitLabGet, budgetMs = LANDING_BUDGET_MS): Promise<MrInfo> {
  const project = `projects/${encodeURIComponent(ref.project)}`;
  const j = (await get(ref, `${project}/merge_requests/${ref.iid}`)) as RestMr | undefined;
  if (!j || typeof j !== "object") return { state: "unknown" };
  const state = (["opened", "merged", "closed", "locked"].includes(j.state ?? "") ? j.state : "unknown") as MrState;
  const mergedAt = j.merged_at ?? undefined;
  if (state !== "merged" || j.merge_commit_sha || j.squash_commit_sha) return { state, mergedAt };
  const failed = (why: string): MrInfo => ({ state: "unknown", mergedAt, landing: `landing check failed: ${why}` });
  const target = j.target_branch;
  const mergedMs = Date.parse(mergedAt ?? "");
  if (!target || !Number.isFinite(mergedMs)) return failed("no target branch or merged_at");
  // Every call after this one checks the budget first: a landing check holds one of RefCache's lookup slots.
  const deadline = Date.now() + budgetMs;
  let calls = 0;
  const call = async (path: string) => {
    if (Date.now() > deadline) throw new OutOfTime(`out of time after ${calls} landing lookups`);
    calls++;
    return get(ref, path);
  };
  try {
    return await checkLanding();
  } catch (e) {
    if (e instanceof OutOfTime) return failed(e.message);
    throw e;
  }

  async function checkLanding(): Promise<MrInfo> {
    if (j!.sha) {
      const refs = [j!.sha, target!].map((v) => `refs%5B%5D=${encodeURIComponent(v)}`).join("&");
      const base = (await call(`${project}/repository/merge_base?${refs}`)) as { id?: string } | undefined;
      if (base?.id === j!.sha) return { state, mergedAt };
    }

    const proj = (await call(project)) as { default_branch?: string } | undefined;
    if (!proj?.default_branch) return failed("project default branch");
    if (proj.default_branch !== target) return { state, mergedAt }; // stacked

    const commits: RestCommit[] = [];
    for (let page = 1; ; page++) {
      if (page > MAX_MR_PAGES) return failed(`MR has ${MAX_MR_PAGES * 100}+ commits`);
      const batch = (await call(`${project}/merge_requests/${ref.iid}/commits?per_page=100&page=${page}`)) as RestCommit[] | undefined;
      if (!Array.isArray(batch)) return failed("MR commits");
      commits.push(...batch);
      if (batch.length < 100) break;
    }
    if (!commits.length) return failed("MR lists no commits");
    const wanted = commits.filter((c) => (c.parent_ids?.length ?? 1) < 2);
    if (!wanted.length) return { state, mergedAt }; // only merge commits: nothing to match, don't cry wolf
    // One key per MR commit: its title, plus its author date when GitLab gives a readable one, so someone else's
    // "fix lint" on the target doesn't count. Two MR commits with the same key count once.
    const authored = (c: RestCommit) => Date.parse(c.authored_date ?? "");
    const key = (c: RestCommit) => (Number.isFinite(authored(c)) ? `${c.title}\n${authored(c)}` : c.title);
    const want = new Map(wanted.map((c) => [key(c), Number.isFinite(authored(c))]));
    const found = new Set<string>();
    const see = (c: RestCommit) => {
      if (want.has(key(c))) found.add(key(c));
      else if (want.get(c.title) === false) found.add(c.title); // an MR commit with no author date: title alone
    };

    // Around merged_at, then before it (back to the oldest author date), then since.
    const now = Date.now();
    const earliest = Math.min(...wanted.map(authored).filter(Number.isFinite));
    const windows: Array<[number, number]> = [[mergedMs - MERGE_WINDOW_MS, mergedMs + MERGE_WINDOW_MS]];
    if (earliest < mergedMs - MERGE_WINDOW_MS) windows.push([earliest - 60_000, mergedMs - MERGE_WINDOW_MS]);
    if (now > mergedMs + MERGE_WINDOW_MS) windows.push([mergedMs + MERGE_WINDOW_MS, now]);
    let pages = 0;
    for (const [from, until] of windows) {
      for (let page = 1; found.size < want.size; page++) {
        if (pages++ >= MAX_TARGET_PAGES) return failed(`stopped after ${MAX_TARGET_PAGES * 100} ${target} commits`);
        const q = `ref_name=${encodeURIComponent(target!)}&since=${new Date(from).toISOString()}&until=${new Date(until).toISOString()}&per_page=100&page=${page}`;
        const batch = (await call(`${project}/repository/commits?${q}`)) as RestCommit[] | undefined;
        if (!Array.isArray(batch)) return failed(`${target} commits`);
        for (const c of batch) see(c);
        if (batch.length < 100) break;
      }
      if (found.size === want.size) return { state, mergedAt };
    }
    return { state: "merged-not-landed", mergedAt, landing: `${found.size} of ${want.size} commits on ${target}` };
  }
}

class OutOfTime extends Error {}
