// JIRA state for items whose refs are JIRA tickets, so the waiting cards can say "PAY-12 Done 10-14"
// the way they say "api-worker!17 merged 10-14" (10-20: waiting items carrying only JIRA links never
// reached the MR-merged card).
//
// Same shape as MrStates: tick() reads a cache, lookups run in the background. The Access token goes stale
// (cloudflared hands back nothing, or JIRA answers 401 / an Access login page), so any failure is "unknown",
// never "done": an unknown ref keeps the item off the card.

import { existsSync } from "node:fs";
import type { Item } from "../shared/types.ts";
import { config } from "./config.ts";
import { RefCache, runCli } from "./ref-cache.ts";

/** statusCategory "done" covers Done, Closed, Resolved, Won't Do. */
export type JiraState = "done" | "open" | "unknown";
export interface JiraInfo {
  state: JiraState;
  /** The status name ("Done", "Closed", "Resolved"…). */
  status?: string;
  /** resolutiondate, when JIRA has one. */
  doneAt?: string;
}
export interface JiraRef {
  url: string;
  host: string;
  key: string;
}

/** JIRA hosts to look up (config jira.hosts; default: labels.trackerUrl's host when it's a JIRA /browse/ URL). Others' links aren't refs. */
export const JIRA_HOSTS: ReadonlySet<string> = new Set(config.jira.hosts);

/** "https://jira.example.com/browse/PAY-12?focusedId=1" → ref. Anything else → undefined. */
export function parseJiraRef(u: string, hosts: ReadonlySet<string> = JIRA_HOSTS): JiraRef | undefined {
  try {
    const url = new URL(u);
    if (!hosts.has(url.host)) return undefined;
    const m = /^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/.exec(url.pathname);
    if (!m) return undefined;
    return { url: `${url.origin}/browse/${m[1]}`, host: url.host, key: m[1]! };
  } catch {
    return undefined;
  }
}

/** The item's JIRA refs: its links, then its source URL. Deduped. */
export function jiraRefs(it: Pick<Item, "links" | "source">, hosts: ReadonlySet<string> = JIRA_HOSTS): JiraRef[] {
  const out = new Map<string, JiraRef>();
  for (const u of [...(it.links ?? []), it.source.url ?? ""]) {
    const r = parseJiraRef(u, hosts);
    if (r && !out.has(r.url)) out.set(r.url, r);
  }
  return [...out.values()];
}

export interface JiraDone {
  ref: JiraRef;
  status: string;
  doneAt?: string;
}
/** "pending" while a lookup is in flight; every ticket done → the list; otherwise (none, any open or unknown) undefined. */
export type JiraVerdict = "pending" | { done: JiraDone[] } | undefined;

type Fetch = (ref: JiraRef) => Promise<JiraInfo>;

const TTL = 30 * 60_000;
const FAIL_TTL = 10 * 60_000;

export class JiraStates {
  /** Tickets reopen, so "done" expires like the rest. */
  private cache: RefCache<JiraRef, JiraInfo>;

  constructor(
    fetch: Fetch = jiraFetch,
    readonly hosts: ReadonlySet<string> = JIRA_HOSTS,
  ) {
    this.cache = new RefCache(fetch, (i) => (i.state === "unknown" ? FAIL_TTL : TTL), { state: "unknown" });
  }

  refs(it: Pick<Item, "links" | "source">) {
    return jiraRefs(it, this.hosts);
  }

  verdict(it: Pick<Item, "links" | "source">): JiraVerdict {
    const now = Date.now();
    const refs = this.refs(it);
    if (!refs.length) return undefined;
    const infos = refs.map((r) => this.cache.get(r, now));
    if (infos.some((i) => i === undefined)) return "pending";
    if (!infos.every((i) => i!.state === "done")) return undefined;
    return { done: refs.map((ref, n) => ({ ref, status: infos[n]!.status || "Done", doneAt: infos[n]!.doneAt })) };
  }

  settled() {
    return this.cache.settled();
  }
}

/** Parse a /rest/api/2/issue response. Anything not shaped like an issue is "unknown". */
export function parseIssue(status: number, body: string): JiraInfo {
  if (status !== 200) return { state: "unknown" };
  try {
    const j = JSON.parse(body) as { fields?: { status?: { name?: string; statusCategory?: { key?: string } }; resolutiondate?: string | null } };
    const cat = j.fields?.status?.statusCategory?.key;
    if (!cat) return { state: "unknown" };
    const doneAt = j.fields?.resolutiondate ? new Date(j.fields.resolutiondate).toISOString() : undefined;
    return { state: cat === "done" ? "done" : "open", status: j.fields?.status?.name, doneAt };
  } catch {
    return { state: "unknown" };
  }
}

let token: { host: string; value: string; at: number } | undefined;
const TOKEN_TTL = 5 * 60_000;

/** One REST call with the cloudflared Access token. Never throws: a failure is "unknown". */
export async function jiraFetch(ref: JiraRef): Promise<JiraInfo> {
  const t = await accessToken(ref.host);
  if (!t) return { state: "unknown" };
  try {
    const res = await fetch(`https://${ref.host}/rest/api/2/issue/${ref.key}?fields=status,resolutiondate`, {
      headers: { "cf-access-token": t, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) token = undefined;
    return parseIssue(res.status, await res.text());
  } catch {
    return { state: "unknown" };
  }
}

async function accessToken(host: string): Promise<string | undefined> {
  if (token?.host === host && Date.now() - token.at < TOKEN_TTL) return token.value;
  const bin = existsSync("/opt/homebrew/bin/cloudflared") ? "/opt/homebrew/bin/cloudflared" : "cloudflared";
  // `access token` never opens a browser: a missing or expired token prints an error and exits non-zero.
  const out = (await runCli(bin, ["access", "token", `-app=https://${host}`], 10_000, true)).trim();
  if (!/^ey[\w-]+\.[\w-]+\.[\w-]+$/.test(out)) return undefined;
  token = { host, value: out, at: Date.now() };
  return out;
}
