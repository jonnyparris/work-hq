// The "Committed" panel: what you're on the hook for today. Pure, so tests can pin it.
//
// 10-21: the panel listed 97 items: 81 closed today (mostly agent ideas closing), 14 `doing` items a live
// agent job already owned (shown again in the Agents panel), and 2 that were actually yours.
// Now: your open items, plus closures from the last couple of hours, a few at most. Older closures
// only count in the header; agent-run items stay in the Agents panel.

import type { Item, Job } from "./types.ts";

/** A closure stays in the list this long, then drops to the header count. */
export const RECENT_DONE_MS = 2 * 3600_000;
/** At most this many recent closures in the list. */
export const MAX_RECENT_DONE = 3;
const LIVE = new Set(["queued", "running", "blocked"]);

export interface CommittedView {
  /** Open first, then recent closures, newest first. */
  rows: Item[];
  open: number;
  /** Closed today, including ones no longer listed. */
  doneToday: number;
  /** `doing` items a live agent job owns: in the Agents panel, not here. */
  withAgents: number;
}

export function committedView(items: Item[], jobs: Job[], now = Date.now()): CommittedView {
  const live = new Set(jobs.filter((j) => LIVE.has(j.status) && j.itemId).map((j) => j.itemId!));
  const today = new Date(now).toDateString();
  const t = (i: Item) => Date.parse(i.updatedAt);
  const mine = items.filter((i) => i.status === "today" || (i.status === "doing" && !live.has(i.id)));
  const withAgents = items.filter((i) => i.status === "doing" && live.has(i.id)).length;
  const done = items.filter((i) => i.status === "done" && new Date(t(i)).toDateString() === today).sort((a, b) => t(b) - t(a));
  const recent = done.filter((i) => now - t(i) < RECENT_DONE_MS).slice(0, MAX_RECENT_DONE);
  return { rows: [...mine, ...recent], open: mine.length, doneToday: done.length, withAgents };
}
