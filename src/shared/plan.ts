// The morning plan card ("What are today's three?"). Pure, so the web card recomputes it live from the
// current items and tests can pin the choices.
//
// 10-21: the card pre-ticked every today + doing item (29), offered the top 14 proposed by a weak score, froze
// the list on items.length (so it went stale), let you tick agent-run `doing` items (which demoted them to
// today), and unticking a today item did nothing. Snoozed three times that morning, never used.

import type { Item } from "./types.ts";

const DAY = 86400000;

/** Planner/lane priority from the item's own signals. */
export function score(i: Item, now = Date.now()) {
  let s = 0;
  // Kill date near: boost from 3 days past to 3 days ahead. Past that the prompter's
  // "Kill date passed — keep or kill?" card owns it; the planner shouldn't pin it forever.
  const kill = i.signals?.killDate ? Date.parse(i.signals.killDate) : NaN;
  if (kill - now < 3 * DAY && kill - now >= -3 * DAY) s += 3;
  // Due soon: boost from 3 days overdue to 7 days ahead. Older overdue dates get no boost,
  // so a missed target doesn't sit on top of the planner forever.
  const due = i.signals?.dueDate ? Date.parse(i.signals.dueDate) : NaN;
  if (due - now < 7 * DAY && due - now >= -3 * DAY) s += 2;
  if (i.signals?.pineapple) s += 2;
  if (i.source.label?.includes("Immediate")) s += 2;
  if (i.kind === "decision") s += 1;
  if (i.status === "inbox") s += 1;
  if (i.kind === "idea") s -= 1;
  return s;
}

export type PlanGroup = "today" | "due" | "backlog";

export interface PlanRow {
  item: Item;
  group: PlanGroup;
  /** One short reason it's here, e.g. "due Thu", "you committed to it today", "on today since 10-15". */
  why: string;
  rank: number;
}

export interface PlanView {
  rows: PlanRow[];
  /** Up to three ids worth doing today: pre-ticked on the card. */
  suggested: string[];
  /** Items agents are working on (`doing`): not yours to plan, not shown. */
  withAgents: number;
  /** Agent-written ideas left out of the backlog list (search still finds them). */
  hiddenIdeas: number;
}

export const MAX_SUGGESTED = 3;
const BACKLOG_ROWS = 8;
const PEOPLE = new Set(["commitment", "decision", "message", "email", "review", "meeting"]);
const CLOSED = new Set(["done", "dropped"]);

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const md = (t: number) => new Date(t).toISOString().slice(5, 10);
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const dayName = (t: number, now: number) => (sameDay(t, now) ? "today" : t - now < 6 * DAY && t > now ? new Date(t).toLocaleDateString("en-GB", { weekday: "short" }) : md(t));
const agentIdea = (i: Item) => i.source.type === "agent" && i.kind === "idea" && !i.signals?.pineapple;

function endOfDay(now: number) {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Rank and the strongest reason, for one candidate. */
export function rate(i: Item, now = Date.now()): { rank: number; why: string } {
  const reasons: Array<[number, string]> = [];
  let rank = score(i, now);
  const kill = i.signals?.killDate ? Date.parse(i.signals.killDate) : NaN;
  if (kill - now < 3 * DAY && kill - now >= -3 * DAY) reasons.push([3, kill < now ? `kill date passed ${md(kill)}` : `kill date ${dayName(kill, now)}`]);
  const due = i.signals?.dueDate ? Date.parse(i.signals.dueDate) : NaN;
  if (due - now < 7 * DAY && due - now >= -3 * DAY) reasons.push([2.5, due < now && !sameDay(due, now) ? `overdue since ${md(due)}` : `due ${dayName(due, now)}`]);
  if (i.signals?.pineapple) reasons.push([2, "you captured it 🍍"]);
  if (i.source.label?.includes("Immediate")) reasons.push([1.5, "marked Immediate in your todos"]);

  const at = i.scheduledFor ? Date.parse(i.scheduledFor) : NaN;
  if (i.status === "scheduled" && at <= endOfDay(now)) {
    rank += 4;
    reasons.push([4, sameDay(at, now) ? `scheduled ${hhmm(at)}` : `was scheduled ${md(at)}`]);
  }
  if (i.status === "today") {
    const since = Date.parse(i.confirmedAt ?? i.updatedAt ?? "");
    const days = Number.isNaN(since) ? 99 : Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(since).setHours(0, 0, 0, 0)) / DAY);
    if (days <= 0) {
      rank += 4;
      reasons.push([5, "you committed to it today"]);
    } else if (days <= 2) {
      rank += 2;
      reasons.push([1, days === 1 ? "carried from yesterday" : `on today since ${md(since)}`]);
    } else {
      rank -= 2;
      reasons.push([0.5, `on today since ${Number.isNaN(since) ? "a while" : md(since)}: still real?`]);
    }
  }
  if (PEOPLE.has(i.kind)) {
    rank += 1;
    reasons.push([1.2, i.kind === "decision" ? "a decision only you can make" : i.kind === "review" ? "someone waits on your review" : "someone's waiting on you"]);
  }
  if (i.source.type === "transcript") {
    rank += 1;
    reasons.push([1.1, `from ${i.source.label ?? "a meeting"}`]);
  } else if (i.source.type === "voice" || i.source.type === "manual") {
    rank += 1;
    reasons.push([1, "you added it"]);
  } else if (i.source.type === "agent") {
    rank -= 1;
  }
  reasons.sort((a, b) => b[0] - a[0]);
  return { rank, why: reasons[0]?.[1] ?? (i.source.label ? `from ${i.source.label.replace("active-todos · ", "your todos · ")}` : i.source.type) };
}

export function planView(items: Item[], now = Date.now()): PlanView {
  const rows: PlanRow[] = [];
  let hiddenIdeas = 0;
  const eod = endOfDay(now);
  const backlog: PlanRow[] = [];
  for (const i of items) {
    if (CLOSED.has(i.status) || i.status === "doing" || i.status === "waiting") continue;
    if (!["today", "scheduled", "proposed", "inbox"].includes(i.status)) continue; // e.g. legacy "review" rows: search still finds them
    const r = rate(i, now);
    if (i.status === "today") rows.push({ item: i, group: "today", ...r });
    else if ((i.status === "scheduled" && Date.parse(i.scheduledFor ?? "") <= eod)) rows.push({ item: i, group: "due", ...r });
    else if (i.status === "proposed" || i.status === "inbox") {
      const dueSoon = score(i, now) >= 2 && Boolean(i.signals?.dueDate || i.signals?.killDate);
      if (dueSoon) rows.push({ item: i, group: "due", ...r });
      else if (agentIdea(i)) hiddenIdeas++;
      else backlog.push({ item: i, group: "backlog", ...r });
    }
  }
  backlog.sort((a, b) => b.rank - a.rank || b.item.updatedAt.localeCompare(a.item.updatedAt));
  rows.push(...backlog.slice(0, BACKLOG_ROWS));
  const order: Record<PlanGroup, number> = { today: 0, due: 1, backlog: 2 };
  rows.sort((a, b) => order[a.group] - order[b.group] || b.rank - a.rank);
  const best = [...rows].sort((a, b) => b.rank - a.rank || order[a.group] - order[b.group]);
  let suggested = best.filter((r) => r.rank >= 1).slice(0, MAX_SUGGESTED).map((r) => r.item.id);
  if (!suggested.length) suggested = rows.filter((r) => r.group !== "backlog").slice(0, MAX_SUGGESTED).map((r) => r.item.id);
  return { rows, suggested, withAgents: items.filter((i) => i.status === "doing").length, hiddenIdeas };
}

/** Typed filter on the card: every open item you could pick (not agent-run), all words must match. */
export function searchPlan(items: Item[], query: string, limit = 12): Item[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = items.filter((i) => {
    if (CLOSED.has(i.status) || i.status === "doing") return false;
    const hay = `${i.title} ${i.project ?? ""} ${i.detail ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const inTitle = (i: Item) => words.every((w) => `${i.title} ${i.project ?? ""}`.toLowerCase().includes(w));
  return hits.sort((a, b) => Number(inTitle(b)) - Number(inTitle(a)) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}
