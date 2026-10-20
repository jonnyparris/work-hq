// Dead buttons: an option that says it will start something ("Yes", "Send", "Draft it",
// "Dispatch") but whose effect does nothing. The tap writes a journal line and the work is
// silently dropped. 10-13..10-17: three command-bar follow-ups went this way before anyone
// noticed; the usage digest only finds them after a tap. hub.ask() runs this before the card
// shows, and test/dead-button.test.ts walks every option literal in the server.
// Dependency-free: shared by server, CLI and tests.

import type { Effect, Question, QuestionOption } from "./types.ts";

/** Labels that promise an action. Also used by the usage digest's "Yes taps that started nothing". */
export const AFFIRMATIVE = /\b(yes|send|draft|dispatch|research|verify|do it)\b/i;

/**
 * Option ids whose real work happens in the answer route (src/server/index.ts), after the
 * noop effect. Keyed by question kind; `*` = any kind. Keep in step with that route.
 */
export const ROUTE_HANDLED: Record<string, readonly string[]> = {
  plan: ["plan"],
  wrap: ["flush"],
  review: ["scan"],
  "*": ["look"],
};

/** Nothing happens: plain noop, or a multi made only of noops. */
export function doesNothing(e: Effect): boolean {
  if (e.type === "noop") return true;
  return e.type === "multi" && e.effects.every(doesNothing);
}

export function routeHandled(kind: string, optionId: string): boolean {
  return (ROUTE_HANDLED[kind] ?? []).includes(optionId) || ROUTE_HANDLED["*"]!.includes(optionId);
}

/** The options on this card that promise an action and do nothing. */
export function deadOptions(q: Pick<Question, "kind" | "options">): QuestionOption[] {
  return q.options.filter((o) => AFFIRMATIVE.test(o.label) && doesNothing(o.effect) && !routeHandled(q.kind, o.id));
}
