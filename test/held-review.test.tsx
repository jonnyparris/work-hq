import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalendarEvent, Question } from "../src/shared/types.ts";
import { Timeline } from "../src/web/parts.tsx";

const now = new Date("2026-10-22T15:05:00Z");
const ev: CalendarEvent = { id: "e1", title: "Echo Weekly", start: "2026-10-22T14:00:00Z", end: "2026-10-22T15:00:00Z", attendees: ["a@x", "b@x"] } as CalendarEvent;
const review = (over: Partial<Question> = {}): Question =>
  ({ id: "q1", kind: "review", eventId: "e1", key: "review:e1", prompt: "Echo Weekly just ended. Anything you committed to?", options: [], priority: 70, status: "open", createdAt: now.toISOString(), notBefore: "2026-10-22T15:25:00Z", ...over }) as Question;

describe("meeting row takes dictation while its 'just ended' card is held", () => {
  test("an open review card puts a box on its meeting row", () => {
    const html = renderToStaticMarkup(<Timeline now={now} events={[ev]} items={[]} questions={[review()]} onRefresh={() => {}} />);
    expect(html).toContain("held-review");
    expect(html).toContain("Committed to anything?");
  });

  test("no open card, no box", () => {
    for (const questions of [[], [review({ status: "expired" })], [review({ kind: "prep" })]]) {
      const html = renderToStaticMarkup(<Timeline now={now} events={[ev]} items={[]} questions={questions} onRefresh={() => {}} />);
      expect(html).not.toContain("held-review");
    }
  });
});
