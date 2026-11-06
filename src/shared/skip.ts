// "Next" on the current card: navigation only, nothing is sent. The web view keeps, per tab, a list of
// skipped card ids (oldest skip first) and the queue as shown before each move (Nav.history), so Back can
// restore one.
// Shared so the tests use the same rules. Dependency-free.
//
// Skipped cards go to the back in the order you skipped them. Sorting them by priority instead broke
// Next once every card had been skipped once: re-skipping the front card left it in front
// (it_mw5jlpteeo791).

export interface Nav {
  /** Skipped card ids, oldest skip first. */
  skipped: string[];
  /**
   * Before each move, newest last: the queue as shown, then skipped ids not on screen (snoozed). Back pops one
   * and restores that order, with cards that arrived since behind it.
   */
  history: string[][];
}

// The open queue is capped at 14 cards, so 200 skip ids is far more than one tab ever needs live.
const MAX_SKIPPED = 200;
const MAX_HISTORY = 30;

export const emptyNav = (): Nav => ({ skipped: [], history: [] });

/** The queue as shown: unskipped cards in their given order, then skipped ones, the one skipped longest ago first. */
export function orderQueue<T extends { id: string }>(ready: readonly T[], skipped: readonly string[]): T[] {
  const at = new Map<string, number>();
  skipped.forEach((id, i) => at.set(id, i));
  const fresh = ready.filter((q) => !at.has(q.id));
  const back = ready.filter((q) => at.has(q.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return [...fresh, ...back];
}

/** Next: the card goes to the very back. */
export function skipCard(skipped: readonly string[], id: string): string[] {
  return [...skipped.filter((y) => y !== id), id];
}

/** A queue chip: that card comes to the front, the ones ahead of it go to the back in queue order. */
export function jumpTo(skipped: readonly string[], queue: readonly { id: string }[], id: string): string[] {
  const i = queue.findIndex((q) => q.id === id);
  if (i < 0) return [...skipped];
  const ahead = queue.slice(0, i).map((q) => q.id);
  const drop = new Set([id, ...ahead]);
  return [...skipped.filter((y) => !drop.has(y)), ...ahead];
}

/** Over the cap, drop the oldest ids of cards not in `queue` (closed or snoozed) first, so an open card keeps its place. */
function cap(skipped: string[], queue: readonly { id: string }[]): string[] {
  let extra = skipped.length - MAX_SKIPPED;
  if (extra <= 0) return skipped;
  const open = new Set(queue.map((q) => q.id));
  const kept = skipped.filter((id) => open.has(id) || extra-- <= 0);
  return kept.slice(-MAX_SKIPPED);
}

// History keeps the order that was on screen (`queue`, which may have a pinned card in front), not the skip
// list, so Back can return to a pinned card. Skipped ids off screen (snoozed) go after it, so they stay behind.
function move(nav: Nav, skipped: string[], queue: readonly { id: string }[]): Nav {
  const shown = queue.map((q) => q.id);
  const on = new Set(shown);
  return {
    skipped: cap(skipped, queue),
    history: [...nav.history, [...shown, ...nav.skipped.filter((id) => !on.has(id))]].slice(-MAX_HISTORY),
  };
}

/** Next from the card in front of `queue`. */
export function next(nav: Nav, queue: readonly { id: string }[]): Nav {
  return queue[0] ? move(nav, skipCard(nav.skipped, queue[0].id), queue) : nav;
}

/** Queue chip for `id`. */
export function jump(nav: Nav, queue: readonly { id: string }[], id: string): Nav {
  return move(nav, jumpTo(nav.skipped, queue, id), queue);
}

/** The deck's "answer in the focus card": `id` in front, everything else behind it in queue order. */
export function focusOn(nav: Nav, queue: readonly { id: string }[], id: string): Nav {
  return move(nav, queue.filter((q) => q.id !== id).map((q) => q.id), queue);
}

/**
 * Back: restore the newest earlier list that puts a different card in front of `ready` than `front` (the
 * card showing now). Lists that would show the same card (it closed since, or new cards arrived) are dropped.
 */
export function back(nav: Nav, ready: readonly { id: string }[], front: string | undefined): Nav {
  const history = [...nav.history];
  while (history.length) {
    const entry = history.pop()!;
    // As a skip list the entry reproduces that screen (orderQueue keeps list order for skipped ids). Cards
    // that arrived since go after it, so they don't take the front.
    const had = new Set(entry);
    const prev = [...entry, ...ready.map((q) => q.id).filter((id) => !had.has(id))];
    const top = orderQueue(ready, prev)[0]?.id;
    if (top && top !== front) return { skipped: prev, history };
  }
  return nav;
}

export function canBack(nav: Nav, ready: readonly { id: string }[], front: string | undefined): boolean {
  return back(nav, ready, front) !== nav;
}

/**
 * sessionStorage → Nav. `stored` is the one-key blob ({ skipped, history }, written whole so the two can't
 * disagree); `legacy` is the old bare skip list, read only when there's no blob. Malformed reads as empty.
 */
export function readNav(stored: string | null, legacy: string | null = null): Nav {
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const parse = (s: string | null): unknown => { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } };
  const v = parse(stored);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const { skipped, history } = v as { skipped?: unknown; history?: unknown };
    return { skipped: ids(skipped), history: Array.isArray(history) ? history.filter(Array.isArray).map(ids) : [] };
  }
  return { skipped: ids(parse(legacy)), history: [] };
}
