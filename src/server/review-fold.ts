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

/** Local midnight of the earliest folded day (at most BACKFILL_DAYS back): where the card's scan starts reading. */
export function reviewsSince(meetings: Pick<StaleMeeting, "day">[], now = new Date()) {
  const first = meetings.map((m) => m.day).sort()[0];
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

export function readMeetings(hub: Hub, key: string): StaleMeeting[] {
  try {
    const v = JSON.parse(hub.store.kv(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Write the card's list back and redraw it, or close it once the list is empty. */
export function redrawReviews(hub: Hub, q: Question, meetings: StaleMeeting[], now = new Date()) {
  hub.store.setKv(q.key, JSON.stringify(meetings));
  if (!meetings.length) return hub.expireQuestion(q.id, "transcript scanned");
  const d = reviewDigest(meetings, now, hub.sweepWindows());
  if (d.prompt === q.prompt && d.context === q.context && JSON.stringify(d.options) === JSON.stringify(q.options)) return;
  Object.assign(q, { prompt: d.prompt, context: d.context, options: d.options });
  hub.store.putQuestion(q);
  hub.emit({ type: "question", data: q });
}

/**
 * After a transcript sweep: take meetings it read off every open folded card (a card left empty closes) and redraw
 * the rest against the new coverage. `scanned` matches a meeting against the scanned list. Rows without a start
 * (older kv) can't be placed and stay. Returns the cards it closed.
 */
export function pruneReviews(hub: Hub, scanned: (ev: Pick<CalendarEvent, "title" | "start">) => boolean, now = new Date()) {
  let closed = 0;
  for (const q of hub.store.questions("open")) {
    if (q.kind !== "review" || !q.key.startsWith(REVIEWS_PREFIX)) continue;
    const meetings = readMeetings(hub, q.key);
    if (!meetings.length) continue; // unreadable list: leave the card as it is
    const left = meetings.filter((m) => !m.start || !scanned({ title: m.title, start: m.start }));
    redrawReviews(hub, q, left, now);
    if (!left.length) closed++;
  }
  return closed;
}
