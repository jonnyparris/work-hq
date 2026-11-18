/**
 * "Sort the pile": the Proposed lane as a separate job, not a queue of cards. 11-18: 152 items on Proposed, 53 over
 * 30 days old. The stale-proposals card shows 20 at a time, once a day, and only items untouched for 14 days; the lane
 * kept growing faster. The pile view lists every proposed item by where it came from and how old it is, with
 * tick-boxes and one bulk bar (Hub.bulkItems). Pure helpers here so the grouping is tested.
 */
import type { Item } from "./types.ts";

export const PILE_OPS = ["today", "done", "drop", "keep", "agent"] as const;
export type PileOp = (typeof PILE_OPS)[number];
/** Most work agents one "Agent" tap on the pile sends. More would swamp the run cap and the Agents panel. */
export const PILE_AGENT_MAX = 5;

export type PileSource = "todos" | "reflection" | "learn" | "writing" | "meetings" | "you" | "agents" | "checks";

export const PILE_SOURCES: Array<{ id: PileSource; label: string; hint: string }> = [
  { id: "todos", label: "Your to-do list", hint: "Lines from active-todos in memory. Memory drops them when you remove the line." },
  { id: "reflection", label: "Reflection proposals", hint: "Ideas the nightly reflection proposed." },
  { id: "learn", label: "Learn proposals", hint: "Rule fixes the end-of-session learn step proposed." },
  { id: "writing", label: "Writing ideas", hint: "Post ideas from the weekly writing scout." },
  { id: "meetings", label: "From meetings", hint: "Pulled from meeting transcripts." },
  { id: "you", label: "You said", hint: "Things you typed or dictated." },
  { id: "agents", label: "From agents", hint: "Follow-ups agents left behind." },
  { id: "checks", label: "From checks", hint: "Morning check commands." },
];

export function pileSource(it: Pick<Item, "source" | "kind">): PileSource {
  const s = it.source;
  const label = s.label ?? "";
  if (s.type === "memory") {
    if (/^Proposals .*Learn\b/i.test(label)) return "learn";
    if (/^Proposals\b/i.test(label)) return "reflection";
    return "todos";
  }
  if (s.type === "agent") return it.kind === "post" || /writing scout/i.test(label) ? "writing" : "agents";
  if (s.type === "transcript" || s.type === "pineapple" || s.type === "calendar") return "meetings";
  if (s.type === "voice" || s.type === "manual") return "you";
  return "checks";
}

export type PileAge = "week" | "fortnight" | "month" | "older";
export const PILE_AGES: Array<{ id: PileAge; label: string }> = [
  { id: "week", label: "This week" },
  { id: "fortnight", label: "1–2 weeks" },
  { id: "month", label: "2–4 weeks" },
  { id: "older", label: "Over a month" },
];

const DAY = 86_400_000;

/** Age from createdAt: memory re-imports refresh updatedAt daily, so it says nothing about how long it's sat there. */
export function pileAge(it: Pick<Item, "createdAt">, now: number): PileAge {
  const d = (now - Date.parse(it.createdAt)) / DAY;
  return d < 7 ? "week" : d < 14 ? "fortnight" : d < 30 ? "month" : "older";
}

export function pileDays(it: Pick<Item, "createdAt">, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(it.createdAt)) / DAY));
}

/** Proposed items, filtered, oldest first (the oldest are the easiest to drop). */
export function pileItems(items: Item[], now: number, f: { source?: PileSource; age?: PileAge; q?: string } = {}): Item[] {
  const q = f.q?.trim().toLowerCase();
  return items
    .filter((i) => i.status === "proposed")
    .filter((i) => !f.source || pileSource(i) === f.source)
    .filter((i) => !f.age || pileAge(i, now) === f.age)
    .filter((i) => !q || `${i.title} ${i.project ?? ""} ${i.source.label ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Counts per source and per age over every proposed item, for the filter chips. */
export function pileCounts(items: Item[], now: number) {
  const source = new Map<PileSource, number>();
  const age = new Map<PileAge, number>();
  let total = 0;
  for (const i of items) {
    if (i.status !== "proposed") continue;
    total++;
    source.set(pileSource(i), (source.get(pileSource(i)) ?? 0) + 1);
    age.set(pileAge(i, now), (age.get(pileAge(i, now)) ?? 0) + 1);
  }
  return { total, source, age };
}

/** What each bulk button does, for its tooltip. `n` = how many are ticked. */
export function pileOpText(op: PileOp, n: number): string {
  const them = n === 1 ? "it" : `these ${n}`;
  switch (op) {
    case "today": return `Puts ${them} on your Committed list for today. You do them yourself: no agent is sent.`;
    case "done": return `Closes ${them} as done. No agent is sent.`;
    case "drop": return `Drops ${them}: you won't do them. They leave Proposed and won't come back under a new title.`;
    case "keep": return `Leaves ${them} on Proposed and keeps them off the "Stale proposals" card for 14 days. Nothing else changes.`;
    case "agent": return `Sends an agent on each, now (at most ${PILE_AGENT_MAX} per tap): a draft for post ideas, a brief for meetings, otherwise one that does the work. Each reports back with a card.`;
  }
}
