// "When <ref> lands → run the next step." An agent that hands back a train ("merge !12, then flip the flag") sets
// `next` on its item in `whq report`. The prompter (nextStepCards) watches the refs through the same MR / PR / JIRA
// caches as the merged card, and once every ref has landed raises one "Send an agent" card carrying the stored
// prompt. 11-06..11-10: four sessions where the owner had to ask "X merged, so is Y ready now?".

import type { ActionKind, Item, NextStep, NextStepInput } from "../shared/types.ts";
import { JIRA_HOSTS, parseJiraRef } from "./jira-state.ts";
import { parseMrRef } from "./mr-state.ts";
import { parsePrRef } from "./pr-state.ts";

/** A Record so adding an ActionKind fails the build here until it's listed. */
const ACTIONS: Record<ActionKind, true> = { ticket: true, reply: true, email: true, prep: true, work: true, verify: true, draft: true, publish: true };
/** Each ref is a lookup every 30 min while armed; a prompt rides along in the item doc and the dispatch note. */
export const MAX_REFS = 5;
export const MAX_PROMPT = 4000;

/** A report's `next` → a NextStep, or why not. Every ref must be an MR, GitHub PR or JIRA link the caches can look up:
 *  one they can't would never land, and the step would wait forever. */
export function parseNextStep(raw: unknown, by: string | undefined, now = new Date(), jiraHosts: ReadonlySet<string> = JIRA_HOSTS): NextStep | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "next must be an object: { refs, prompt, action? }" };
  const r = raw as NextStepInput; // every field is checked below
  const refs = [...new Set([...(Array.isArray(r.refs) ? r.refs : []), ...(typeof r.ref === "string" ? [r.ref] : [])].map((u) => String(u).trim()).filter(Boolean))];
  if (!refs.length) return { error: "next needs refs: the MR / PR / ticket URLs it waits on" };
  if (refs.length > MAX_REFS) return { error: `next: at most ${MAX_REFS} refs (got ${refs.length})` };
  const web = (u: string) => /^https?:\/\//i.test(u);
  const bad = refs.filter((u) => !web(u) || (!parseMrRef(u) && !parsePrRef(u) && !parseJiraRef(u, jiraHosts)));
  if (bad.length) return { error: `next: not an MR, GitHub PR or JIRA link Work HQ can look up: ${bad.join(" ")}` };
  const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
  if (!prompt) return { error: "next needs a prompt: what the next agent should do once the refs land" };
  if (prompt.length > MAX_PROMPT) return { error: `next: prompt over ${MAX_PROMPT} characters` };
  const action = r.action ?? "work";
  if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) return { error: `next: unknown action ${JSON.stringify(r.action)}` };
  return { refs, prompt, ...(action !== "work" ? { action: action as ActionKind } : {}), setAt: now.toISOString(), ...(by ? { by } : {}) };
}

/** The item as the landing lookups should see it: only the next step's refs (not its own links or source URL). */
export function nextStepProbe(it: Item, next: NextStep): Item {
  return { ...it, links: next.refs, source: { ...it.source, url: undefined } };
}

/** Its card's key: one per armed step, so a new `next` on the same item gets its own card. */
export function nextStepKey(itemId: string, next: NextStep) {
  return `next:${itemId}:${next.setAt}`;
}

/** Armed: set and not spent (no card raised yet, no ref closed unmerged). */
export const armed = (it: Pick<Item, "next">) => Boolean(it.next && !it.next.firedAt);

/** The armed step, or its card still open: the "mark done?" cards (merged, recheck) leave the item alone, or Done
 *  would close it before the step runs. */
export function holdsDone(it: Item, openKeys: ReadonlySet<string>) {
  return Boolean(it.next && (armed(it) || openKeys.has(nextStepKey(it.id, it.next))));
}
