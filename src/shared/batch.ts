// Batch triage ("clear the deck"). Groups open questions by how much of you they
// need, so the end of the day goes: one-tap stuff, hand-offs to agents, then
// push the head-work to later. Shared by server (bulk ops, triage) and web (Deck).
// Keep it dependency-free.

import type { CalendarEvent, Effect, Item, ItemKind, ItemStatus, Question, QuestionOption } from "./types.ts";

export type DeckGroup = "review" | "inbox" | "waiting" | "due" | "state" | "proposal" | "agent" | "post" | "day";

/** quick = one tap, no thinking · agent = hand it off · think = needs your head (defer these at 6pm). */
export type Effort = "quick" | "agent" | "think";

export type BulkOp = "dispatch" | "done" | "drop" | "dismiss" | "defer";

export interface GroupInfo {
  label: string;
  effort: Effort;
  /** Bulk ops that make sense for the whole group, with the button label. */
  ops: Partial<Record<BulkOp, string>>;
}

/** Listed in deck order: quickest first. */
export const GROUPS: Record<DeckGroup, GroupInfo> = {
  review: { label: "Meetings that ended", effort: "quick", ops: { dismiss: "Nothing new — clear all" } },
  inbox: { label: "Captured", effort: "quick", ops: { dispatch: "Send agents", dismiss: "All later", drop: "Not mine — drop all", defer: "Defer" } },
  waiting: { label: "Still waiting", effort: "quick", ops: { dispatch: "Chase all", dismiss: "Keep waiting", defer: "Defer" } },
  due: { label: "It's time", effort: "quick", ops: { dispatch: "Send agents", defer: "Push" } },
  state: { label: "State unknown / kill date", effort: "agent", ops: { dispatch: "Check all for me", defer: "Defer" } },
  proposal: { label: "Reflection proposals", effort: "agent", ops: { dispatch: "Send agents", drop: "Reject all", defer: "Defer" } },
  agent: { label: "Agents asking", effort: "think", ops: { defer: "Defer" } },
  post: { label: "Blog posts", effort: "think", ops: { defer: "Defer", drop: "Not for me — drop all" } },
  day: { label: "Plan / wrap / prep", effort: "think", ops: {} },
};

export const GROUP_ORDER = Object.keys(GROUPS) as DeckGroup[];

export const EFFORT_LABEL: Record<Effort, string> = { quick: "one tap", agent: "hand off", think: "needs you" };

export function deckGroup(q: Pick<Question, "key" | "kind">): DeckGroup {
  const k = q.key;
  if (k.startsWith("due:")) return "due";
  if (q.kind === "review") return "review";
  if (k.startsWith("inbox:")) return "inbox";
  if (k.startsWith("wait:")) return "waiting";
  if (k.startsWith("state:") || k.startsWith("kill:")) return "state";
  if (k.startsWith("proposal:")) return "proposal";
  if (q.kind === "post") return "post";
  if (q.kind === "plan" || q.kind === "wrap" || q.kind === "prep") return "day";
  return "agent";
}

export function effortOf(q: Pick<Question, "key" | "kind">): Effort {
  return GROUPS[deckGroup(q)].effort;
}

/** Quick first, then by priority. For the "quick wins first" queue. */
export function quickFirst(a: Question, b: Question) {
  const e = { quick: 0, agent: 1, think: 2 } as const;
  return e[effortOf(a)] - e[effortOf(b)] || b.priority - a.priority || a.createdAt.localeCompare(b.createdAt);
}

/** Bulk dispatch never publishes or (re)drafts — those need a human read first. */
const BULK_ACTIONS = new Set(["ticket", "reply", "email", "prep", "work", "verify"]);

/** The effect sets this status: directly, or on every item of a batched card (a multi of status effects). */
export function setsStatus(e: Effect, s: ItemStatus): boolean {
  if (e.type === "status") return e.status === s;
  return e.type === "multi" && e.effects.length > 0 && e.effects.every((x) => x.type === "status" && x.status === s);
}

/** Which of this question's own options a bulk op means. Undefined = op doesn't apply here. */
export function optionFor(q: Pick<Question, "key" | "kind" | "options">, op: Exclude<BulkOp, "defer">): QuestionOption | undefined {
  const o = q.options;
  switch (op) {
    case "dispatch":
      return o.find((x) => x.effect.type === "dispatch" && BULK_ACTIONS.has(x.effect.action));
    case "done":
      return o.find((x) => setsStatus(x.effect, "done"));
    case "drop":
      return o.find((x) => setsStatus(x.effect, "dropped"));
    case "dismiss": {
      const g = deckGroup(q);
      if (g === "review") return o.find((x) => x.id === "none");
      if (g === "waiting") return o.find((x) => x.id === "keep");
      if (g === "inbox") return o.find((x) => x.id === "later");
      return undefined;
    }
  }
}

export interface DeferTarget {
  id: string;
  label: string;
  at: string;
}

/** Next working day, the rest of this week, next Monday. All 09:30 local. */
export function deferTargets(now = new Date()): DeferTarget[] {
  const out: DeferTarget[] = [];
  const day = (offset: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    d.setHours(9, 30, 0, 0);
    return d;
  };
  const name = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short" });
  for (let i = 1; i <= 7 && out.length < 4; i++) {
    const d = day(i);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue;
    const first = out.length === 0;
    // After the first working day, stay within this week; then jump to next Monday.
    if (!first && wd === 1) {
      out.push({ id: "nextweek", label: "Next week · Mon", at: d.toISOString() });
      break;
    }
    out.push({ id: first ? "tomorrow" : name(d).toLowerCase(), label: first && i === 1 ? `Tomorrow · ${name(d)}` : name(d), at: d.toISOString() });
  }
  if (!out.some((t) => t.id === "nextweek")) {
    const mon = day(((8 - now.getDay()) % 7) || 7);
    if (!out.some((t) => t.at === mon.toISOString())) out.push({ id: "nextweek", label: "Next week · Mon", at: mon.toISOString() });
  }
  return out;
}

/** Local YYYY-MM-DD. */
export function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The last day a defer button can land on. The calendar sweep reads up to here. */
export function deferHorizon(now = new Date()) {
  const ts = deferTargets(now).map((t) => t.at).sort();
  return localDay(new Date(ts[ts.length - 1] ?? now.toISOString()));
}

const SLOT_MS = 30 * 60_000;

export interface SlotLoad {
  /** Open items already landing in this 30-minute slot. */
  count: number;
  /** Non-declined meetings (with other people) overlapping the slot. */
  clashes: CalendarEvent[];
  /** False when the calendar sweep hasn't read that day: say so, don't claim "free". */
  calendarKnown: boolean;
  /** Next 30-minute gap with no meeting, same day, inside work hours. */
  nextFree?: { at: string; hhmm: string };
}

export const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** A meeting has other people in it. Solo holds ("🚫 No interviews", "Focus time") are fine to land work in. */
const isMeeting = (e: CalendarEvent) => e.response !== "declined" && (e.attendees?.length ?? 0) > 0;
const overlaps = (e: CalendarEvent, from: number, to: number) => isMeeting(e) && Date.parse(e.start) < to && Date.parse(e.end) > from;

/**
 * What a defer target already holds: the two facts worth seeing before you pile more on.
 * `calendarThrough` is the last local day the calendar sweep covered (YYYY-MM-DD).
 */
export function slotLoad(
  at: string,
  ctx: { items: Item[]; questions: Question[]; events: CalendarEvent[]; calendarThrough?: string; workHours?: [number, number] },
): SlotLoad {
  const from = Date.parse(at);
  const to = from + SLOT_MS;
  const inSlot = (iso?: string) => Boolean(iso) && Date.parse(iso!) >= from && Date.parse(iso!) < to;
  const ids = new Set<string>();
  for (const i of ctx.items) {
    if (["done", "dropped"].includes(i.status)) continue;
    if (inSlot(i.scheduledFor)) ids.add(i.id);
  }
  for (const q of ctx.questions) {
    if (q.status === "open" && inSlot(q.notBefore)) ids.add(q.itemId ?? `q:${q.id}`);
  }
  const day = localDay(new Date(from));
  const calendarKnown = Boolean(ctx.calendarThrough && ctx.calendarThrough >= day);
  const dayEvents = ctx.events.filter((e) => localDay(new Date(e.start)) === day || localDay(new Date(e.end)) === day);
  const clashes = dayEvents.filter((e) => overlaps(e, from, to)).sort((a, b) => a.start.localeCompare(b.start));
  let nextFree: SlotLoad["nextFree"];
  if (calendarKnown && clashes.length) {
    const end = new Date(from);
    end.setHours(ctx.workHours?.[1] ?? 18, 0, 0, 0);
    for (let t = to; t + SLOT_MS <= end.getTime(); t += SLOT_MS) {
      if (!dayEvents.some((e) => overlaps(e, t, t + SLOT_MS))) {
        nextFree = { at: new Date(t).toISOString(), hhmm: hhmm(new Date(t)) };
        break;
      }
    }
  }
  return { count: ids.size, clashes, calendarKnown, nextFree };
}

/** "Mon 09:30: 19 items already · clashes with CluePoints 09:30". */
export function slotLine(label: string, l: SlotLoad) {
  const parts = [l.count ? `${l.count} item${l.count === 1 ? "" : "s"} already` : "nothing else there yet"];
  if (!l.calendarKnown) parts.push("calendar not read that far yet");
  else if (l.clashes.length) parts.push(`clashes with ${l.clashes.map((e) => `${e.title} ${hhmm(new Date(e.start))}`).join(", ")}`);
  else parts.push("calendar free");
  return `${label}: ${parts.join(" · ")}`;
}

/** What a bulk op picks. Any combination; all given filters must match. */
export interface BulkSelector {
  ids?: string[];
  group?: DeckGroup;
  /** Item kind, e.g. "post" — also reaches scheduled items of that kind that haven't come due yet. */
  kind?: ItemKind;
}

export interface BulkRequest extends BulkSelector {
  op: BulkOp;
  /** defer only: ISO time. */
  until?: string;
  /** defer only: human label ("Thu 09:30"). */
  label?: string;
}
