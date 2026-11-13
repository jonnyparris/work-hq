import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalendarEvent, Question } from "../src/shared/types.ts";
import { Timeline } from "../src/web/parts.tsx";

const now = new Date("2026-10-22T15:05:00Z");
const ev: CalendarEvent = { id: "e1", title: "Echo Weekly", start: "2026-10-22T14:00:00Z", end: "2026-10-22T15:00:00Z", attendees: ["a@x", "b@x"] } as CalendarEvent;
const review = (over: Partial<Question> = {}): Question =>
  ({ id: "q1", kind: "review", eventId: "e1", key: "review:e1", prompt: "Echo Weekly just ended. Anything you committed to?", options: [], priority: 70, status: "open", createdAt: now.toISOString(), notBefore: "2026-10-22T15:25:00Z", ...over }) as Question;

describe("meeting row takes dictation while it just ended", () => {
  const box = (events: CalendarEvent[], questions: Question[] = [], at = now) =>
    renderToStaticMarkup(<Timeline now={at} events={events} items={[]} questions={questions} onRefresh={() => {}} />).includes("held-review");

  test("an open review card puts a box on its meeting row", () => {
    const html = renderToStaticMarkup(<Timeline now={now} events={[ev]} items={[]} questions={[review()]} onRefresh={() => {}} />);
    expect(html).toContain("held-review");
    expect(html).toContain("Committed to anything?");
    // Its card keeps the box past the notes window.
    expect(box([ev], [review()], new Date("2026-10-22T17:00:00Z"))).toBe(true);
  });

  // No per-meeting card any more (one end-of-day card instead): the row takes dictation for REVIEW_HOLD_MIN on its own.
  test("no card: a box until the notes window closes", () => {
    expect(box([ev])).toBe(true);
    expect(box([ev], [review({ status: "expired" })])).toBe(true);
    expect(box([ev], [], new Date("2026-10-22T15:59:00Z"))).toBe(true);
    expect(box([ev], [], new Date("2026-10-22T16:00:00Z"))).toBe(false);
    expect(box([ev], [], new Date("2026-10-22T14:30:00Z"))).toBe(false); // still running
  });

  test("no box for a declined, unattended or solo meeting", () => {
    expect(box([{ ...ev, response: "declined" }])).toBe(false);
    expect(box([{ ...ev, response: "needsAction" }])).toBe(false);
    expect(box([{ ...ev, response: "needsAction", oneOnOne: true, attendees: ["a@x"] }])).toBe(true);
    expect(box([{ ...ev, attendees: [] }])).toBe(false);
  });
});
