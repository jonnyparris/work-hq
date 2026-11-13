import type { CalendarEvent } from "./types.ts";

/**
 * A meeting waits this long after it ends before it counts as unrecorded: the end of the scheduler's last notes-sweep
 * window (NOTES_WINDOWS_MIN in the server's prompter), when the transcript sweep runs. 10-23: of 10 cards a scan closed in October, 3 closed by 25 min and 9 by 60.
 * The meeting row takes dictation meanwhile (web Timeline).
 */
export const REVIEW_HOLD_MIN = 60;

/**
 * A meeting worth asking "anything you committed to?" about: not declined, attended (never RSVP'd = probably didn't
 * go, except 1-1s: plenty of real ones never get accepted), with someone else (the calendar sweep usually leaves you
 * off the attendee list, so a real 1-1 has one attendee). The server also drops invites with only you on them (isOwner).
 */
export function reviewable(ev: Pick<CalendarEvent, "response" | "oneOnOne" | "attendees">) {
  if (ev.response === "declined") return false;
  const attended = ev.response !== "needsAction" || Boolean(ev.oneOnOne);
  return attended && (Boolean(ev.oneOnOne) || (ev.attendees?.length ?? 0) > 1);
}
