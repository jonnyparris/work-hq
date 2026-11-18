/**
 * Plain-English "what happens if I tap this" for a card's buttons. Shown under the options on hover / focus and as the
 * button's tooltip. 11-18: "Still mine today" read as maybe sending an agent, maybe hiding the card; the button
 * never said. Every line answers three things: what happens to the item, whether an agent goes, and what happens to
 * the card (closes for good, comes back, when). Pure, so the words are tested (test/explain-option.test.ts).
 */
import type { ActionKind, Effect, Item, ItemStatus, Question, QuestionOption } from "./types.ts";

const AGENT: Record<ActionKind, string> = {
  work: "Sends an agent now to do it. Watch it from the Agents panel (in cmux, when it's on, you can take over)",
  ticket: "Sends an agent now to search for a duplicate ticket, then file a new one or comment on the existing one",
  reply: "Sends an agent now to draft a reply in the original thread. It shows you the draft before anything is sent",
  email: "Sends an agent now to draft an email. It is never sent for you",
  prep: "Sends an agent now to write a meeting brief (who's coming, last contact, open items, what to raise) and open it",
  verify: "Sends a read-only agent now to check the real state (MRs, tickets, its transcript). It changes nothing",
  draft: "Sends an agent now to write or revise the post draft, using your note",
  publish: "Sends an agent now to publish the reviewed draft",
};

/** What a status change means to you, with what follows it. `n` > 1: a batch card's "all" button. */
function statusLine(s: ItemStatus, n = 1): string {
  const it = n > 1 ? `all ${n}` : "it";
  const they = n > 1 ? "They" : "It";
  switch (s) {
    case "today": return `Puts ${it} on your Committed list for today. You do ${n > 1 ? "them" : "it"} yourself: no agent is sent. The evening wrap-up asks how ${n > 1 ? "they" : "it"} went`;
    case "doing": return `Marks ${it} as in progress, by you. No agent is sent. If nothing changes for 4 work hours, a "Still on it?" card asks`;
    case "waiting": return `Marks ${it} as waiting on someone else. No agent is sent. If nothing changes for 3 days, a "Still waiting" card asks again`;
    case "done": return `Closes ${it} as done. No agent is sent`;
    case "dropped": return `Drops ${it}: you won't do ${n > 1 ? "them" : "it"}. ${they} leave${n > 1 ? "" : "s"} your lists and won't come back under a new title. No agent is sent`;
    case "proposed": return `Keeps ${it} on Proposed: yours, but not committed to any day. No agent is sent. Untouched for 14 days, it shows up on the "Stale proposals" card`;
    case "inbox": return `Puts ${it} back in Captured, to triage later. No agent is sent`;
    case "scheduled": return `Marks ${it} as scheduled. No agent is sent`;
  }
}

const mins = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m === 60 ? "an hour" : `${m / 60} hours`);
const host = (url: string) => { try { return new URL(url).host || url; } catch { return url; } };

/** One effect, no card tail. */
function effectLine(e: Effect, q?: Question): string {
  switch (e.type) {
    case "status": return statusLine(e.status);
    case "schedule": return `Schedules it for ${e.inMin ? `${mins(e.inMin)} from now` : e.label}. No agent is sent. An "It's time" card comes back then`;
    case "snooze": return `Hides this card for ${mins(e.minutes)}. Nothing about the item changes, and the same card comes back`;
    case "dispatch":
      if (!q?.itemId && q?.picks?.length) return `${AGENT[e.action]}, one for each ticked row`;
      // Agents.dispatch leaves the item's status alone for a verify: checking isn't working on it.
      if (e.action === "verify") return `${AGENT.verify}. The item stays where it is, and it reports back with a card that proposes the status`;
      return `${AGENT[e.action]}. The item moves to "doing". When the agent finishes or gets stuck, it reports back with a card`;
    case "open": return `Opens ${host(e.url)} in your browser${e.keep ? ". The card stays open" : ""}`;
    case "when": return `Asks you when (say or type it), then schedules it. No agent is sent. An "It's time" card comes back at that time`;
    case "noop": return "Closes this card. Nothing else changes";
    case "gatewayLogin": return `Opens a browser tab to log in to ${e.app}. Paused sweeps start again once it works`;
    case "accessLogin": return `Opens a browser tab to log in to ${e.app}${e.rerun?.length ? ", then reruns the job that hit the login" : ""}`;
    case "triage": return "Reads your earlier words again, as if typed in the command bar, and acts on them";
    case "commitPlan": return "Commits the ticked items to today. Items on today that you left unticked go back to Proposed";
    case "prepMeetings": return "Sends one prep agent per ticked meeting. Each writes a brief and opens it";
    case "donePicks": return e.all ? "Marks every item listed here as done. No agent is sent" : "Marks each ticked item as done. The rest stay as they are. No agent is sent";
    case "closePicks": return e.all ? "Closes every card listed here. The items behind them don't change" : "Closes each ticked card. The items behind them don't change";
    case "retirePicks": return e.keep ? "Keeps every listed item on Proposed and hides them from this card for 14 days. Nothing is dropped" : e.all ? "Drops every listed item. Nothing else changes" : "Drops each ticked item. The unticked ones stay on Proposed and stay off this card for 14 days";
    case "stoppedPicks": return `${e.act === "check" ? `Sends a read-only check agent for ${e.all ? "every listed job" : "each ticked job"}, to see if its work landed` : `Sends ${e.all ? "every listed job" : "each ticked job"} again, with its original instructions`}. ${e.all ? "Rows that can't be sent" : "Rows you leave unticked"} come back on a new card`;
    case "flushJournal": return "Saves today's journal to memory now";
    case "sweep": return `Runs the ${e.name} sweep now (a read-only agent)`;
    case "focusSession": return `Switches to the agent's cmux session${e.keep ? ". The card stays open" : ""}`;
    case "multi": {
      // A batch card's "Mark all 7 done": one line for N status changes, not seven.
      const st = e.effects.filter((x): x is Extract<Effect, { type: "status" }> => x.type === "status");
      if (st.length === e.effects.length && st.length && st.every((x) => x.status === st[0]!.status)) return statusLine(st[0]!.status, st.length);
      return e.effects.map((x) => effectLine(x, q)).join(". Then: ");
    }
  }
}

/** Card tail: does this card go, and does it come back? Effects that keep or bring the card back say so themselves. */
function cardTail(e: Effect): string {
  if (e.type === "snooze" || e.type === "noop" || ((e.type === "open" || e.type === "focusSession") && e.keep)) return "";
  if (e.type === "when") return "";
  // foldRest puts the rows it didn't handle on a new card: "This card closes" would read as "all gone".
  if (e.type === "stoppedPicks") return "";
  return "This card closes";
}

/**
 * The full line for one button. `o.hint`, when the card set one, goes first: it's the card's own reason. `typed`: the
 * note box has words, which ride along with the tap.
 */
export function explainOption(o: Pick<QuestionOption, "effect" | "hint" | "label">, q?: Question, opts: { typed?: boolean } = {}): string {
  const parts = [o.hint?.trim(), effectLine(o.effect, q), cardTail(o.effect)].filter(Boolean) as string[];
  let text = parts.map((p) => p.replace(/[.\s]+$/, "")).join(". ") + ".";
  if (opts.typed) {
    const agent = o.effect.type === "dispatch" || o.effect.type === "prepMeetings" || o.effect.type === "stoppedPicks";
    text += agent ? " Your note goes to the agent." : " Your note is kept with the answer.";
  }
  return text;
}

/** The agent an item gets when you just say "deal with it": a brief for a calendar prep item, a draft for a post idea, else work. */
export function itemAgentAction(item?: Pick<Item, "kind" | "source">): ActionKind {
  if (item?.kind === "meeting" && item.source.type === "calendar") return "prep";
  if (item?.kind === "post") return "draft";
  return "work";
}

/**
 * The action the card's "Agent: deal with it now" button sends: the item's (itemAgentAction), or a brief for a card
 * about a meeting that hasn't happened yet. A "just ended" review card gets none: a brief after the meeting is no use.
 */
export function agentNowAction(q: Pick<Question, "itemId" | "eventId" | "kind">, item?: Pick<Item, "kind" | "source">): ActionKind | undefined {
  if (q.itemId) return itemAgentAction(item);
  return q.eventId && q.kind !== "review" ? "prep" : undefined;
}

/**
 * Show the "Agent: deal with it now" button? Only on a card about one item or one upcoming meeting, with no agent
 * already on the item (`busy`), and only when none of its own buttons already sends that agent (then that button is
 * the one, and its tooltip says so).
 */
export function showAgentNow(q: Pick<Question, "itemId" | "eventId" | "options" | "picks" | "kind">, item?: Pick<Item, "kind" | "source" | "status">, busy = false): boolean {
  if (q.picks?.length || q.kind === "plan" || q.kind === "wrap") return false;
  // An agent is already on the item: answer its card instead of starting a second one (Hub.agentNow refuses too).
  if (busy || (item && ["done", "dropped"].includes(item.status))) return false;
  const action = agentNowAction(q, item);
  if (!action) return false;
  return !q.options.some((o) => o.effect.type === "dispatch" && o.effect.action === action);
}

export const AGENT_NOW_LABEL = "Agent: deal with it now";

export function explainAgentNow(action: ActionKind, opts: { typed?: boolean } = {}): string {
  return `${AGENT[action]}. The item moves to "doing" and this card closes. When the agent finishes or gets stuck, it reports back with a card.${opts.typed ? " Your note goes to the agent." : ""}`;
}
