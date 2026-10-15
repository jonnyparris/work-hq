// Keep the card you're on while you're writing on it. The queue re-sorts on every
// incoming question; without a pin a higher-priority arrival would take the front
// and the half-typed (or half-dictated) note would land on the wrong card or vanish.
// Shared so the web view and the tests use the same rule. Dependency-free.

export interface Pin {
  /** The card that stays in front. */
  id: string;
  /** Queue ids present when the pin was taken. Anything else is "new". */
  seen: string[];
}

/** Take a pin on whatever is in front now. */
export function takePin(queue: readonly { id: string }[]): Pin | undefined {
  return queue[0] ? { id: queue[0].id, seen: queue.map((q) => q.id) } : undefined;
}

/**
 * Queue as shown: the pinned card first (if it's still open), the rest in their
 * normal order. `fresh` counts cards that arrived while pinned.
 * A pin whose card has gone (answered elsewhere, expired) does nothing.
 */
export function pinQueue<T extends { id: string }>(queue: readonly T[], pin?: Pin): { queue: T[]; fresh: number } {
  if (!pin) return { queue: [...queue], fresh: 0 };
  const held = queue.find((q) => q.id === pin.id);
  const seen = new Set(pin.seen);
  const fresh = queue.filter((q) => !seen.has(q.id)).length;
  if (!held) return { queue: [...queue], fresh };
  return { queue: [held, ...queue.filter((q) => q !== held)], fresh };
}
