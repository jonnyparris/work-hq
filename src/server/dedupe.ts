// Same thing, different source. Memory retitles a todo, a transcript sweep finds what an agent
// already filed, a proposal comes back as an active todo. Each has its own source key, so the
// key-based dedupe in Hub.createItem misses them and the owner gets asked twice (or asked again
// about something they already dropped).
//
// Deliberately conservative: plain title-token overlap, tuned on real data so every match it
// makes is a true duplicate. Missing a duplicate costs one extra question; a false merge hides work.

import type { Item } from "../shared/types.ts";

const STOP = new Set(
  ("the a an and or of to for in on with by at from is are be it its this that you your my our we i as into than then " +
    "now not no yes about via per once still yet up out off over after before just get got set run new also any all some more most own")
    .split(" "),
);

/** Sources that already have stable keys of their own, or are the owner typing on purpose. */
const SKIP_SOURCES = new Set<Item["source"]["type"]>(["check", "calendar", "manual"]);

export function titleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (let w of title.toLowerCase().match(/[a-z]+-\d+|[a-z0-9]+/g) ?? []) {
    if (STOP.has(w) || (w.length < 3 && !/\d/.test(w))) continue;
    if (w.length > 5) w = w.replace(/(ing|ed|es|s)$/, "");
    out.add(w);
  }
  return out;
}

/** Ticket keys, MR and PR numbers. Two titles naming different ones are different work. */
function refs(title: string): Set<string> {
  return new Set(title.match(/\b[A-Z][A-Z0-9]+-\d+\b|![0-9]+|#[0-9]+/g) ?? []);
}

export function sameWork(a: string, b: string): boolean {
  const ra = refs(a);
  const rb = refs(b);
  if (ra.size && rb.size && ![...ra].some((r) => rb.has(r))) return false;
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const dice = (2 * inter) / (A.size + B.size);
  const contained = inter / Math.min(A.size, B.size);
  return (inter >= 4 && (dice >= 0.75 || (contained >= 0.9 && Math.min(A.size, B.size) >= 4))) || (inter >= 3 && dice >= 0.9);
}

const CLOSED_WINDOW_MS = 14 * 86400_000;

export function dedupeEligible(source: Item["source"]["type"] | undefined) {
  return !SKIP_SOURCES.has(source ?? "manual");
}

/**
 * The item a new one duplicates, if any. Open items win; an item the owner closed in the last
 * two weeks also counts, so a retitled todo can't bring back something they already dropped.
 */
export function findTwin(title: string, source: Item["source"]["type"] | undefined, items: Item[], now = Date.now()): Item | undefined {
  if (!dedupeEligible(source)) return undefined;
  // The owner saying it again (voice; "pineapple" = the removed in-app listener) means it's live again, even if they closed it before.
  const allowClosed = source !== "voice" && source !== "pineapple";
  const candidates = items.filter((i) => {
    if (!dedupeEligible(i.source.type)) return false;
    if (!["done", "dropped"].includes(i.status)) return true;
    return allowClosed && Boolean(i.confirmedAt) && now - Date.parse(i.updatedAt) < CLOSED_WINDOW_MS;
  });
  const hits = candidates.filter((i) => sameWork(title, i.title));
  // Prefer an open one, then the one the owner touched most recently.
  return hits.sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || (b.confirmedAt ?? "").localeCompare(a.confirmedAt ?? "") || a.createdAt.localeCompare(b.createdAt))[0];
}

export const isOpen = (i: Item) => !["done", "dropped"].includes(i.status);
