// Dead buttons: an option that says it will start something ("Yes", "Send", "Draft it",
// "Dispatch") but whose effect does nothing. The tap writes a journal line and the work is
// silently dropped. 10-13..10-17: three command-bar follow-ups went this way before anyone
// noticed; the usage digest only finds them after a tap. hub.ask() runs this before the card
// shows, and test/dead-button.test.ts walks every option literal in the server.
// Stalled buttons (stallsOptions, below) are the sibling: the label approves work but the effect
// only moves the status, so no agent starts.
// Dependency-free: shared by server, CLI and tests.

import type { Effect, Question, QuestionOption } from "./types.ts";

/** Labels that promise an action (with WORK_VERB below, via promisesAction). The usage digest's
 *  "Yes taps that started nothing" uses this regex alone. */
export const AFFIRMATIVE = /\b(yes|send|draft|dispatch|research|verify|do it)\b/i;

/** Labels that approve work to do next ("Approve all 11, regenerate colo map", "Merge", "Land it").
 *  Feeds promisesAction (dead buttons, plain-string agent options) and approvesWork (stalled buttons). */
const WORK_VERB = /\b(approve|merge|regenerate|land|deploy|rebuild|re-?run|go ahead|send|draft|dispatch|do it)\b/i;

/** "No, don't send it", "Not now — research later": the verb is there, the answer is no. */
const NEGATED = /^\s*(no|not|nope|don'?t|do not|skip|never)\b/i;

/** "Mark done — no need to merge", "Approve later", "Keep open, don't merge": the verb is there but nothing should start now. */
const DEFERRED = /\b(later|not (now|yet|today)|no need|on hold|tomorrow|next week)\b|\b(don'?t|do not|never) (\w+ )?(approve|merge|regenerate|land|deploy|rebuild|re-?run|send|draft|dispatch)\b/i;

/** The label says yes to an action now (doesn't open with a no, doesn't defer). A work verb counts:
 *  a plain-string "Approve all 11" used to map to noop. */
export function promisesAction(label: string): boolean {
  return (AFFIRMATIVE.test(label) || WORK_VERB.test(label)) && !NEGATED.test(label) && !DEFERRED.test(label);
}

/** The AFFIRMATIVE words alone, not opened by a no. For drawer notes, where "Deploy is blocked" is background. */
export function affirms(text: string): boolean {
  return AFFIRMATIVE.test(text) && !NEGATED.test(text);
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

// Stalled buttons: the label approves work someone should do next ("Approve all 11, regenerate
// colo map", "Merge", "Land it") but the effect only moves the item's status. 10-21: that card set
// status today, no agent started, and the same go-ahead was retyped 3.5 h later. Not dead (the
// status does change), so deadOptions misses it. Warn the reporting agent; it re-reports with
// `action: "work"`. Uses WORK_VERB and DEFERRED above.

/** Only status changes: a status, or a multi made only of statuses (noops allowed, at least one status). */
export function onlySetsStatus(e: Effect): boolean {
  if (e.type === "status") return true;
  if (e.type !== "multi") return false;
  return e.effects.every((x) => x.type === "noop" || onlySetsStatus(x)) && e.effects.some((x) => x.type !== "noop");
}

/** The label approves work to do next, and doesn't say no or later anywhere. */
export function approvesWork(label: string): boolean {
  return WORK_VERB.test(label) && !NEGATED.test(label) && !DEFERRED.test(label);
}

/** The options on this card that approve work but only set a status, so no agent starts. */
export function stallsOptions(q: Pick<Question, "options">): QuestionOption[] {
  return q.options.filter((o) => approvesWork(o.label) && onlySetsStatus(o.effect));
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

// A reply that leaves the agent for later and asks in prose: "Not dispatched; say the word…", "Nothing dispatched.",
// "Want me to send an agent?". 11-06 11:47, 13:14, 16:18, 16:20: four asks parked like this with no button to say it.
const DISPATCH_PARKED = /\b(?:not|nothing|no agent|none)\s+(?:\w+\s+)?(?:dispatched|dispatching|sent|started)\b|\bsay the word\b|\b(?:want|shall|should) (?:me|i) (?:to )?(?:dispatch|send an agent|start an agent|wire|kick)/i;

/** True when a triage reply says no agent was started but one could be, or offers one. Triage turns it into a
 *  "Send an agent?" card on the item it created, so the offer has a button (agents.ts). */
export function parksDispatch(reply: string | undefined): boolean {
  return Boolean(reply && DISPATCH_PARKED.test(reply));
}

// Words that say an item's status was changed. 10-23 18:26: "Marked the Joao Duarte reference calls done."
// Nothing was marked (no update applied) until the owner did it by hand 82 min later. Past-tense verbs plus
// "set … to/as <status>", not "moved" / "scheduled": in 233 triage replies (10-24) those mostly describe
// meetings or reminders ("Sofia 1-1 moved to tomorrow"), which go through other paths.
const STATUS_WORD = "(?:done|waiting|today|doing|later|dropped)";
const STATUS_CLAIM = new RegExp(String.raw`\b(marked|dropped|parked|closed|reopened|snoozed|archived|set (?:(?!(?:to|as) ${STATUS_WORD}(?![\w-])|(?:up|aside|out|for|on|at|by|with|in)(?![\w-]))\S+ ){0,6}(?:to|as) ${STATUS_WORD})\b`, "gi");
/** Checked on the clause before the claim word: "Dropped; won't ask Kunwar" and "Not those, but I marked X done" are claims. */
const STATUS_HEDGE = /\b(not|no|nothing|never|want me|shall i|should i|i can|i'll|i will|i'm going to|i am going to|you can|could|would|if)\b|n't\b/i;
/** Right before the claim word, a state or an adjective, not an action: "Sofia's 1-1 is closed for today",
 *  "that's already archived", "were closed and archived", "the closed Joao calls".
 *  A comma ends the state: "It's closed, marked the rest done" is a claim. */
const STATE_NOT_ACTION = /(\b(is|are|was|were|be|been|being|stays?|remains?)|\b(that|it|there|this|what|here)'s)\s+(\w+\s+)?(\w+\s+and\s+)?$|\b(the|a|an|this|that|these|those|my|your|all)\s+$/i;
/** Everything up to the last clause break: the hedge in "Not the Sofia ones, but I marked Joao's done" stays in its clause. */
const CLAUSE_BREAK = /^[\s\S]*(?:[,;:—–\n]|\s--?\s|\bbut\b|\band\b|\bso\s+(?:i|we|you|it|they)\b)/i;
/** Right after the claim word: "I marked nothing". */
const NEGATED_OBJECT = /^\s+(nothing|none|no one|neither|no)\b/i;
/** After the claim word, an offer: "I'd set the Joao calls to done if you like". */
const OFFER_AFTER = /\bif (you|that's|needed|wanted)\b/i;

/** True when some sentence of a triage reply says an item's status was changed ("Marked X done", "Dropped it"),
 *  skipping negated, offered or asked ones ("I'll set it to done", "Not marked", "Mark it done?"). A heuristic:
 *  triage appends "(Nothing was marked.)" only when it fires and no status change was applied. Misses on purpose
 *  (a false flag on an honest reply is worse): passive "were archived", a claim in a sentence with "?", an
 *  update that re-sets the status the item already had, a bulk done/drop over cards already closed.
 *  Known false hit: a sentence opening with an adjective use ("Closed items are hidden now"). */
export function claimsStatus(reply: string | undefined): boolean {
  if (!reply) return false;
  // Parentheticals and slash lists name statuses, they don't claim them: "(capture/proposed/scheduled/waiting/closed)".
  const prose = reply.replace(/[‘’]/g, "'").replace(/\([^)]*\)/g, " ").replace(/\S*\/\S*/g, " ");
  // Every match, not the first: "Sofia's 1-1 is closed for today and I marked the Joao calls done" is a claim.
  return prose.split(/(?<=[.!?;])\s+/).some((s) => !s.includes("?") && [...s.matchAll(STATUS_CLAIM)].some((m) => {
    const before = s.slice(0, m.index);
    const after = s.slice(m.index! + m[0].length);
    return !STATUS_HEDGE.test(before.replace(CLAUSE_BREAK, "")) && !STATE_NOT_ACTION.test(before) && !NEGATED_OBJECT.test(after) && !OFFER_AFTER.test(after);
  }));
}
