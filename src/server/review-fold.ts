/**
 * The folded "Yesterday's meetings" card (`reviews:<date>`): meeting-ended cards from earlier days on one card, its
 * meeting list in kv under the same key. After every transcript sweep (hub.markScanned → pruneReviews), meetings the
 * sweep read come off the card, the card closes once none are left, and it's redrawn against the sweeps' coverage.
 */
import { localDay } from "../shared/batch.ts";
import type { CalendarEvent, Question, QuestionOption } from "../shared/types.ts";
import type { Hub } from "./hub.ts";

export const REVIEWS_PREFIX = "reviews:";
const DAY = 86_400_000;
/** How far back the folded card's scan reads, at most (agents.sweep clamps to it too). */
export const BACKFILL_DAYS = 7;
/** A sweep this long after a meeting ended has had time to see its Gemini notes (they land ~10 min after). */
export const NOTES_GRACE_MS = 30 * 60_000;

/** A meeting-ended card folded into the morning digest. `start`/`end` (ISO) are absent on older kv rows. */
export type StaleMeeting = { title: string; day: string; start?: string; end?: string };

const opt = (id: string, label: string, effect: QuestionOption["effect"], tone?: QuestionOption["tone"]): QuestionOption => ({ id, label, effect, tone });

/** What one successful transcript sweep read: docs modified from `since` up to `at` (when it started). */
export type SweepWindow = { since: string; at: string };

/** Do the sweeps' windows, joined end to end, cover [from, to]? */
export function covered(windows: SweepWindow[], from: number, to: number) {
  const spans = windows
    .map((w) => [Date.parse(w.since), Date.parse(w.at)] as const)
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  let reach = from;
  for (const [s, e] of spans) {
    if (s > reach) break;
    reach = Math.max(reach, e);
    if (reach >= to) return true;
  }
  return false;
}

/**
 * Sweeps have read every doc modified from the meeting's end until NOTES_GRACE_MS after it, and none of it was this
 * meeting's notes (it's still on the card): it has no notes doc (most folded meetings are 1-1s without Gemini). A
 * missing end falls back to start + 1 h; no start either (older kv rows), or a gap in coverage: false, the scan stays first.
 */
export function noNotes(m: StaleMeeting, windows: SweepWindow[] = []) {
  const end = Date.parse(m.end ?? "") || Date.parse(m.start ?? "") + 60 * 60_000;
  return Number.isFinite(end) && covered(windows, end, end + NOTES_GRACE_MS);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d: unknown): d is string => typeof d === "string" && DAY_RE.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00`));

/** Local midnight of the earliest folded day (at most BACKFILL_DAYS back): where the card's scan starts reading. */
export function reviewsSince(meetings: Pick<StaleMeeting, "day">[], now = new Date()) {
  const first = meetings.map((m) => m.day).filter(validDay).sort()[0];
  if (!first) return undefined;
  return new Date(Math.max(new Date(`${first}T00:00:00`).getTime(), now.getTime() - BACKFILL_DAYS * DAY)).toISOString();
}

/**
 * The folded "earlier meetings" card. Titles live in the context so a typed note triages with them. `windows`: what
 * recent transcript sweeps read; when they covered every meeting and found no notes, "Nothing new" is the main
 * button (the scan stays, second).
 */
export function reviewDigest(meetings: StaleMeeting[], now = new Date(), windows: SweepWindow[] = []) {
  const days = [...new Set(meetings.map((m) => m.day))].sort();
  const yesterday = localDay(new Date(now.getTime() - DAY));
  const when =
    days.length > 1 ? "Earlier meetings" : days[0] === yesterday ? "Yesterday's meetings" : `${new Date(`${days[0]}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long" })}'s meetings`;
  const since = reviewsSince(meetings, now);
  const bare = meetings.length > 0 && meetings.every((m) => noNotes(m, windows));
  const scan = opt("scan", "Scan the transcripts now", { type: "sweep", name: "transcripts", ...(since ? { since } : {}) }, bare ? "quiet" : "primary");
  const none = opt("none", "Nothing new", { type: "noop" }, bare ? "primary" : "quiet");
  return {
    kind: "review" as const,
    priority: 70,
    prompt: `${when} (${meetings.length}): anything you committed to?`,
    context: [
      ...meetings.map((m) => `- ${days.length > 1 ? `${m.day.slice(5)} · ` : ""}${m.title}`),
      ...(bare ? ["No meeting notes found for these."] : []),
    ].join("\n"),
    options: bare ? [none, scan] : [scan, none],
  };
}

const optIso = (v: unknown) => v === undefined || (typeof v === "string" && Number.isFinite(Date.parse(v)));
const validMeeting = (m: unknown): m is StaleMeeting => {
  if (!m || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  return typeof r.title === "string" && validDay(r.day) && optIso(r.start) && optIso(r.end);
};

/**
 * The folded card's meeting list from kv. Malformed rows are dropped. `undefined`: unreadable (missing, unparseable,
 * not a list, or no valid row in a non-empty list), so callers leave the card alone. `[]`: a real empty list.
 */
export function readMeetings(hub: Hub, key: string): StaleMeeting[] | undefined {
  try {
    const raw = hub.store.kv(key);
    if (raw === undefined) return undefined;
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return undefined;
    const rows = v.filter(validMeeting);
    return v.length && !rows.length ? undefined : rows;
  } catch {
    return undefined;
  }
}

/** Write the card's list back and redraw it, or close it once the list is empty. */
export function redrawReviews(hub: Hub, q: Question, meetings: StaleMeeting[], now = new Date(), reason = "transcript scanned") {
  hub.store.setKv(q.key, JSON.stringify(meetings));
  if (!meetings.length) return hub.expireQuestion(q.id, reason);
  const d = reviewDigest(meetings, now, hub.sweepWindows());
  if (d.prompt === q.prompt && d.context === q.context && JSON.stringify(d.options) === JSON.stringify(q.options)) return;
  Object.assign(q, { prompt: d.prompt, context: d.context, options: d.options });
  hub.store.putQuestion(q);
  hub.emit({ type: "question", data: q });
}

/**
 * Older than the card's scan can reach (BACKFILL_DAYS): no sweep will ever read its notes, so the scan can't clear it.
 * Placed by its start, else (older kv rows) by the end of its day.
 */
export function outOfReach(m: StaleMeeting, now = new Date(), reach = backfillFloor(now)) {
  const t = Date.parse(m.start ?? "") || new Date(`${m.day}T23:59:59`).getTime();
  return Number.isFinite(t) && t < reach;
}

/** The earliest a new scan can read from: BACKFILL_DAYS before `now`. */
const backfillFloor = (now: Date) => now.getTime() - BACKFILL_DAYS * DAY;

/**
 * After a transcript sweep: take meetings it read off every open folded card, and meetings older than its scan can
 * reach (outOfReach), then redraw the rest against the new coverage; a card left empty closes, and so does one whose
 * kv list is a real `[]`. A backfill still queued reaches back to its own `since`, so meetings it would read stay.
 * An unreadable list leaves the card alone. `scanned` matches a meeting against the scanned
 * list. Rows without a start (older kv) can't be placed and stay until out of reach. Returns the cards it closed.
 */
export function pruneReviews(hub: Hub, scanned: (ev: Pick<CalendarEvent, "title" | "start">) => boolean, now = new Date()) {
  let closed = 0;
  const queued = Date.parse(pendingBackfill(hub, now)?.since ?? "");
  const reach = Math.min(backfillFloor(now), Number.isFinite(queued) ? queued : Infinity);
  for (const q of hub.store.questions("open")) {
    if (q.kind !== "review" || !q.key.startsWith(REVIEWS_PREFIX)) continue;
    const meetings = readMeetings(hub, q.key);
    if (!meetings) continue; // unreadable list: leave the card as it is
    const unread = meetings.filter((m) => !m.start || !scanned({ title: m.title, start: m.start }));
    const left = unread.filter((m) => !outOfReach(m, now, reach));
    // Closed only because what was left is out of reach: say so, not "transcript scanned".
    redrawReviews(hub, q, left, now, !left.length && unread.length === meetings.length && unread.length ? `older than ${BACKFILL_DAYS} days` : "transcript scanned");
    if (!left.length) closed++;
  }
  return closed;
}

// ── the card's scan, queued ─────────────────────────────────────────────
/**
 * kv: a backfill waiting for a transcript sweep (`{ since, at, tries }`), kept until a sweep that read from `since`
 * succeeds, or BACKFILL_TRIES runs have started on it. Cleared by writing "" (the store has no delete).
 */
export const BACKFILL_KEY = "transcriptBackfill";
/** Runs a queued backfill gets (each a multi-day read) before it's dropped. A new ask resets the count. */
export const BACKFILL_TRIES = 3;
export type Backfill = { since: string; at: string; tries?: number };

/** A requested scan start, capped at BACKFILL_DAYS before `now` (the time it was asked for). */
export function capSince(since: string, now = new Date()) {
  const floor = backfillFloor(now);
  const t = Date.parse(since);
  return new Date(Number.isFinite(t) ? Math.max(t, floor) : floor).toISOString();
}

/** The queued backfill, or undefined (none, unreadable, or queued over BACKFILL_DAYS ago: its card is long gone). */
export function pendingBackfill(hub: Hub, now = new Date()): Backfill | undefined {
  try {
    const v = JSON.parse(hub.store.kv(BACKFILL_KEY) || "null") as Partial<Backfill> | null;
    if (!v || typeof v.since !== "string" || typeof v.at !== "string") return undefined;
    if (!Number.isFinite(Date.parse(v.since)) || !(Date.parse(v.at) > backfillFloor(now))) return undefined;
    return v as Backfill;
  } catch {
    return undefined;
  }
}

/** Queue an (already capped) backfill; the earlier of it and one already queued wins, with a fresh try count. Returns what's queued. */
export function queueBackfill(hub: Hub, since: string, now = new Date()): Backfill {
  const prev = pendingBackfill(hub, now);
  const next = { since: prev && Date.parse(prev.since) <= Date.parse(since) ? prev.since : since, at: now.toISOString(), tries: 0 };
  hub.store.setKv(BACKFILL_KEY, JSON.stringify(next));
  return next;
}

/** A sweep that read from `since` succeeded: clear the queued backfill if it covered it (one queued earlier meanwhile stays). */
export function settleBackfill(hub: Hub, since: string, now = new Date()) {
  const p = pendingBackfill(hub, now);
  if (!p || Date.parse(p.since) >= Date.parse(since)) hub.store.setKv(BACKFILL_KEY, "");
}

/**
 * A sweep is about to read the queued backfill: count the try (persisted first, so a run killed by a restart counts).
 * `{ run }`: read from `run.since`. `{ dropped }`: it had its BACKFILL_TRIES and is gone. `{}`: none queued.
 */
export function startBackfill(hub: Hub, now = new Date()): { run?: Backfill; dropped?: Backfill } {
  const p = pendingBackfill(hub, now);
  if (!p) return {};
  if ((p.tries ?? 0) >= BACKFILL_TRIES) {
    hub.store.setKv(BACKFILL_KEY, "");
    return { dropped: p };
  }
  const run = { ...p, tries: (p.tries ?? 0) + 1 };
  hub.store.setKv(BACKFILL_KEY, JSON.stringify(run));
  return { run };
}

/** The run slept mid-read (not a failed read): give its try back. */
export function refundBackfill(hub: Hub, now = new Date()) {
  const p = pendingBackfill(hub, now);
  if (p?.tries) hub.store.setKv(BACKFILL_KEY, JSON.stringify({ ...p, tries: p.tries - 1 }));
}
