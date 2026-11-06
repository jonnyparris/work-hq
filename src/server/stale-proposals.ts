/**
 * Proposed items nobody has touched in STALE_PROPOSED_DAYS go on one card: tick the ones to retire (dropped), the
 * rest are kept and stay off the card for another STALE_PROPOSED_DAYS. 11-06: 122 items sat on Proposed, 87 of them
 * over two weeks old. Nothing ever aged them out: memory-sync's retire() only drops memory items that left memory, and
 * the morning plan, "Mine, later" and finished jobs keep adding to the lane. Nothing is dropped without a tap.
 *
 * "Touched" is the owner or an agent doing something with the item: created, confirmed (any status call or
 * correction by the owner), a note the owner typed on it, a job sent on it, a "keep" on this card (staleKeptAt). Not
 * updatedAt: memory re-imports refresh every memory item's text daily, quietly, so updatedAt is always fresh for them.
 */
import type { Item, Question, QuestionOption, QuestionPick } from "../shared/types.ts";
import type { Hub } from "./hub.ts";
import { cardItemIds } from "./stopped-fold.ts";

export const STALE_PROPOSED_DAYS = 14;
export const STALE_PROPOSED_KEY = "proposed:stale";
/** The card lists the oldest this many; the rest join as those go. */
export const STALE_PROPOSED_PICKS = 20;
/** At most one new card a day: an answer settles every row on it, so there's nothing to come back for sooner. */
export const STALE_PROPOSED_COOLDOWN_MIN = 20 * 60;
const DAY = 86_400_000;
const DAY_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

export const isStaleProposedCard = (q: Pick<Question, "key">) => q.key === STALE_PROPOSED_KEY;

/** The last time anyone did something with the item (ms). See the file comment for what counts. */
export function lastTouch(it: Pick<Item, "createdAt" | "confirmedAt" | "staleKeptAt" | "notes">, lastJobAt?: string): number {
  const times = [it.createdAt, it.confirmedAt, it.staleKeptAt, lastJobAt, ...(it.notes ?? []).filter((n) => !n.who).map((n) => n.at)];
  return Math.max(...times.filter((t): t is string => Boolean(t)).map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t)));
}

export interface StaleCtx {
  /** item id → latest job's createdAt (Store.lastJobAtByItem). */
  lastJob: ReadonlyMap<string, string>;
  /** Items an agent is on right now. */
  busy: Set<string | undefined>;
  /** Items another open card is already asking about (its own item, or a row on a card of several). */
  asked: Set<string | undefined>;
}

/**
 * Proposed items untouched for STALE_PROPOSED_DAYS, oldest first. Left out: a slot still ahead (scheduledFor in the
 * future: the owner deferred it), a kill date (the kill card asks keep-or-kill at that date), an agent on it, or
 * another card asking about it.
 */
export function staleProposals(items: Item[], now: Date, ctx: StaleCtx): Array<{ it: Item; at: number }> {
  const before = now.getTime() - STALE_PROPOSED_DAYS * DAY;
  return items
    .filter((it) => it.status === "proposed")
    .filter((it) => !(it.scheduledFor && Date.parse(it.scheduledFor) > now.getTime()))
    .filter((it) => !it.signals?.killDate)
    .filter((it) => !ctx.busy.has(it.id) && !ctx.asked.has(it.id))
    .map((it) => ({ it, at: lastTouch(it, ctx.lastJob.get(it.id)) }))
    .filter((x) => x.at < before)
    .sort((a, b) => a.at - b.at || a.it.createdAt.localeCompare(b.it.createdAt));
}

/** The card. Pick id = item id. Pure, for tests. */
export function staleProposalsCard(found: Array<{ it: Pick<Item, "id" | "title" | "kind" | "source">; at: number }>, now: Date) {
  const n = found.length;
  const shown = found.slice(0, STALE_PROPOSED_PICKS);
  const picks: QuestionPick[] = shown.map(({ it, at }) => ({
    id: it.id,
    label: it.title,
    hint: `${it.kind} · ${it.source.type} · untouched ${Math.floor((now.getTime() - at) / DAY)} d (since ${DAY_FMT.format(new Date(at))})`,
  }));
  const m = shown.length;
  return {
    kind: "state" as const,
    badge: "Stale proposals",
    priority: 40,
    prompt: n === 1 ? `1 proposed item untouched for ${STALE_PROPOSED_DAYS}+ days: retire it?` : `${n} proposed items untouched for ${STALE_PROPOSED_DAYS}+ days: which can go?`,
    context:
      `Tick the ones to retire (they move to Dropped). The rest are kept on Proposed and don't come back here for ${STALE_PROPOSED_DAYS} days.` +
      (n > m ? ` Showing the oldest ${m} of ${n}; the rest come next.` : "") +
      `\n${picks.map((p) => `- ${p.label} (${p.hint})`).join("\n")}`,
    picks,
    options: [
      opt("retire", "Retire ticked, keep the rest", { type: "retirePicks" }, "primary"),
      opt("all", m === 1 ? "Retire it" : n > m ? `Retire these ${m}` : `Retire all ${m}`, { type: "retirePicks", all: true }, "danger"),
      opt("keep", m === 1 ? "Keep it" : `Keep all ${m}`, { type: "retirePicks", keep: true }, "quiet"),
    ] satisfies QuestionOption[],
  };
}

function opt(id: string, label: string, effect: QuestionOption["effect"], tone?: QuestionOption["tone"]): QuestionOption {
  return { id, label, effect, ...(tone ? { tone } : {}) };
}

/**
 * Prompter tick: keep an open card in step with the board (rows that got touched, closed or picked up drop off; it
 * goes when none are left), or ask a new one. Returns whether it asked a new card.
 */
export function sweepStaleProposals(hub: Hub, items: Item[], open: Question[], now: Date): boolean {
  const store = hub.store;
  const busy = new Set(store.liveJobs().map((j) => j.itemId).filter(Boolean));
  // Rows on cards of several items count too: the recheck card's picks, a stopped-agents fold's items. Picks on other
  // cards are event or question ids, which match no item.
  const asked = new Set(
    open.filter((q) => !isStaleProposedCard(q) && q.status === "open").flatMap((q) => [...cardItemIds(q), ...(q.picks ?? []).map((p) => p.id)]),
  );
  const found = staleProposals(items, now, { lastJob: store.lastJobAtByItem(), busy, asked });
  const prev = store.openQuestionByKey(STALE_PROPOSED_KEY);
  if (prev) {
    if (!found.length) {
      hub.expireQuestion(prev.id, "nothing left");
      return false;
    }
    // Rows only drop off while it's open: no new rows join the list the owner is reading. The counts on the prompt and
    // buttons follow the rows that are left.
    const still = new Set(found.map((f) => f.it.id));
    const keep = (prev.picks ?? []).filter((p) => still.has(p.id));
    if (keep.length === (prev.picks ?? []).length) return false;
    if (!keep.length) {
      hub.expireQuestion(prev.id, "nothing left");
      return false;
    }
    const byId = new Map(found.map((f) => [f.it.id, f]));
    Object.assign(prev, staleProposalsCard(keep.map((p) => byId.get(p.id)!), now));
    store.putQuestion(prev);
    hub.emit({ type: "question", data: prev });
    return false;
  }
  if (!found.length) return false;
  return Boolean(hub.ask({ ...staleProposalsCard(found, now), key: STALE_PROPOSED_KEY, cooldownMin: STALE_PROPOSED_COOLDOWN_MIN }));
}
