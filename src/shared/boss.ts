import type { Job, Question } from "./types.ts";

/** The badge ingestReport puts on a card an action/sweep job raised. Matched below: change both together. */
export const AGENT_ASKS = "Agent asks";

/** A card an agent raised, or raised about an agent: "Agent asks", "Agent finished/stopped", "Didn't run".
 *  The badge catches agent cards reported with their own key (`merge:dodo#150`). */
export const isAgentCard = (q: Pick<Question, "key" | "status" | "badge">) => q.status === "open" && (q.badge === AGENT_ASKS || /^(agent|after|restart):/.test(q.key));

/** An action session in cmux that says it's waiting for the owner. */
export const isWaitingSession = (j: Pick<Job, "kind" | "surface" | "status">) => j.kind === "action" && j.surface === "cmux" && j.status === "blocked";

/** How many things claim to be waiting on the owner: agent cards plus sessions blocked in cmux. */
export function waitingOnYou(questions: Pick<Question, "key" | "status" | "badge">[], jobs: Pick<Job, "kind" | "surface" | "status">[]) {
  return questions.filter(isAgentCard).length + jobs.filter(isWaitingSession).length;
}

/** Show the Boss check button from this many. One or two you can just read. */
export const BOSS_MIN = 3;
