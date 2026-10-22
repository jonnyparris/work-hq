// Dead buttons: an option that says it will start something ("Yes", "Send", "Draft it",
// "Dispatch") but whose effect does nothing. The tap writes a journal line and the work is
// silently dropped. 10-13..10-17: three command-bar follow-ups went this way before anyone
// noticed; the usage digest only finds them after a tap. hub.ask() runs this before the card
// shows, and test/dead-button.test.ts walks every option literal in the server.
// Dependency-free: shared by server, CLI and tests.

import type { Effect, Question, QuestionOption } from "./types.ts";

/** Labels that promise an action. Also used by the usage digest's "Yes taps that started nothing". */
export const AFFIRMATIVE = /\b(yes|send|draft|dispatch|research|verify|do it)\b/i;

/** "No, don't send it", "Not now — research later": the verb is there, the answer is no. */
const NEGATED = /^\s*(no|not|nope|don'?t|do not|skip|never)\b/i;

/** The label says yes to an action (and doesn't open with a no). */
export function promisesAction(label: string): boolean {
  return AFFIRMATIVE.test(label) && !NEGATED.test(label);
}

/** Nothing happens: plain noop, or a multi made only of noops. */
export function doesNothing(e: Effect): boolean {
  if (e.type === "noop") return true;
  return e.type === "multi" && e.effects.every(doesNothing);
}

/** The options on this card that promise an action and do nothing. */
export function deadOptions(q: Pick<Question, "options">): QuestionOption[] {
  return q.options.filter((o) => promisesAction(o.label) && doesNothing(o.effect));
}

// Words that say an agent is already on it. Past/present tense only: "dispatch" alone is mostly
// "Want me to dispatch…?" or "you can dispatch it" (3 of 35 naive hits in 182 triage replies, 10-20).
const DISPATCH_CLAIM = /\b(dispatched|dispatching|sent an agent|sending an agent|handed (?:it )?off|asking|chasing)\b/i;
const DISPATCH_HEDGE = /\b(not|no|never|want me|shall i|should i|i can|you can|could|would|asking (?:you|whether|if))\b|n't\b|\?/i;

/** True when some sentence of a triage reply says an agent was started ("Dispatched an agent", "Asking Maryna"),
 *  skipping negated or offered ones ("Not dispatched", "Want me to dispatch?"). A heuristic: hits go to the journal.
 *  Used by triage (agents.ts) and the note reader's context-only branch (hub.applyNote). */
export function claimsDispatch(reply: string | undefined): boolean {
  if (!reply) return false;
  return reply.split(/(?<=[.!?;])\s+/).some((s) => DISPATCH_CLAIM.test(s) && !DISPATCH_HEDGE.test(s));
}
