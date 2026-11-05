/**
 * One card for agents that stopped on the same error. 10-24 17:31: five jobs died on "Connection error." in the same
 * second and drew five "Agent stopped" cards, each asking the same thing; 11-04 21:57 two more. A job that fails
 * within FOLD_WINDOW_MS of another open stopped card with the same error joins it: the per-job cards close and one
 * `after:fold:<job id>` card (keyed by its first stop; later stops are measured against that one) lists the items, with "Check" (a verify agent each) and "Send again" (the same
 * action, same note) for the ticked ones or all of them.
 *
 * The card keeps its item → job map on its own options (the stoppedPicks effect's `jobs`), so nothing else stores it.
 */
import type { Effect, Item, Job, Question, QuestionOption, QuestionPick } from "../shared/types.ts";
import { isOpen } from "./dedupe.ts";
import type { Hub } from "./hub.ts";

export const FOLD_PREFIX = "after:fold:";
export const FOLD_WINDOW_MS = 2 * 60_000;

export const isFoldCard = (q: Pick<Question, "key">) => q.key.startsWith(FOLD_PREFIX);

/**
 * The error that makes two stops "the same". The trailing note finishAction's callers add ("(again after one retry)",
 * "(couldn't nudge the session)", "(nudge didn't start a new turn)") doesn't count.
 */
export function errorKey(error?: string): string | undefined {
  // First line only: the card keeps it as its context's first line, and matches on that.
  const e = error?.split("\n")[0]!.replace(/\s*\((?:again after one retry|couldn't nudge the session|nudge didn't start a new turn)\)\s*$/i, "").trim();
  return e || undefined;
}

/** Item ids a card is about: its own item, or every item on a fold card. */
export function cardItemIds(q: Pick<Question, "key" | "itemId" | "options">): string[] {
  if (q.itemId) return [q.itemId];
  return isFoldCard(q) ? Object.keys(foldJobs(q)) : [];
}

/** The fold card's item → job map, read back from its options. */
export function foldJobs(q: Pick<Question, "options">): Record<string, string> {
  for (const o of q.options) if (o.effect.type === "stoppedPicks") return o.effect.jobs;
  return {};
}

type Member = { job: Pick<Job, "id" | "name" | "finishedAt" | "error">; item: Pick<Item, "id" | "title"> };

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * The fold card for these stopped jobs (oldest first). Pure, for tests. One row left (the rest closed or were sent):
 * it's that item's card, with the single after-card's ways to settle it (Done, Waiting) and its itemId, so a note
 * on it reaches the item.
 */
export function foldCard(members: Member[], error: string) {
  const n = members.length;
  const jobs = Object.fromEntries(members.map((m) => [m.item.id, m.job.id]));
  const picks: QuestionPick[] = members.map((m) => ({
    id: m.item.id,
    label: m.item.title,
    hint: `${m.job.name} · stopped ${m.job.finishedAt ? TIME.format(new Date(m.job.finishedAt)) : "?"}`,
  }));
  const eff = (act: "check" | "rerun", all?: boolean): Effect => ({ type: "stoppedPicks", act, jobs, ...(all ? { all } : {}) });
  // One row left (the rest closed): nothing to tick.
  const ticked = (o: QuestionOption) => (n > 1 ? [o] : []);
  const options: QuestionOption[] = [
    { id: "check", label: n === 1 ? "Check for me" : `Check all ${n} for me`, hint: "A verify agent each reads its transcript, commits, MRs", tone: "primary", effect: eff("check", true) },
    ...ticked({ id: "check-ticked", label: "Check ticked", effect: eff("check") }),
    { id: "rerun", label: n === 1 ? "Send it again" : `Send all ${n} again`, hint: "Same action, same instructions", effect: eff("rerun", true) },
    ...ticked({ id: "rerun-ticked", label: "Send ticked again", effect: eff("rerun") }),
    // Settle without an agent: back on today, where the board asks about them as usual.
    { id: "today", label: "Still mine today", tone: "quiet", effect: { type: "multi", effects: members.map((m) => ({ type: "status" as const, status: "today" as const, itemId: m.item.id })) } },
    ...(n === 1
      ? [
          { id: "wait", label: "Waiting on someone", effect: { type: "status", status: "waiting", itemId: members[0]!.item.id } },
          // Last and quiet, as on the single card: a stopped job is the one least likely to have landed.
          { id: "done", label: "Done", tone: "quiet", effect: { type: "status", status: "done", itemId: members[0]!.item.id } },
        ] satisfies QuestionOption[]
      : []),
  ];
  return {
    kind: "state" as const,
    itemId: n === 1 ? members[0]!.item.id : undefined,
    badge: "Agents stopped",
    priority: 75,
    prompt: n === 1 ? `Agent stopped: ${members[0]!.item.title}. Where does it stand?` : `${n} agents stopped on the same error. Where do they stand?`,
    // The list is in the context too, so a typed note reads against it.
    context: `${error}\n${picks.map((p) => `- ${p.label} (${p.hint})`).join("\n")}`,
    // One row: nothing to tick (the options read the card's own map).
    picks: n > 1 ? picks : undefined,
    options,
  };
}

const finished = (j: Pick<Job, "finishedAt">) => (j.finishedAt ? Date.parse(j.finishedAt) : NaN);

/**
 * A job just failed: fold it into one card with the other open stopped cards that failed on the same error within
 * FOLD_WINDOW_MS. Returns false when there's nothing to fold with: the caller asks its usual after-card.
 */
export function foldStopped(hub: Hub, job: Job, item: Item): boolean {
  const key = errorKey(job.error);
  const at = finished(job);
  if (!key || Number.isNaN(at)) return false;
  const store = hub.store;
  const within = (j: Job | undefined): j is Job => !!j && errorKey(j.error) === key && Math.abs(at - finished(j)) <= FOLD_WINDOW_MS;
  const near = (j: Job | undefined): j is Job => within(j) && j.status === "failed";
  const open = store.questions("open");
  // An open fold card on the same error drawn within the window. Anchored to the job that started it, so stops a
  // little under 2 min apart don't chain one card forever.
  // The card's error is its context's first line: the anchor job's own error is cleared if it reports after all.
  const fold = open.find((q) => {
    const first = isFoldCard(q) ? store.job(q.key.slice(FOLD_PREFIX.length)) : undefined;
    return !!first && errorKey(q.context?.split("\n")[0]) === key && Math.abs(at - finished(first)) <= FOLD_WINDOW_MS;
  });
  // Single stopped cards (after:<job id>) inside the window. Only stopped ones: a finished job's card is a real question.
  const peers = open.flatMap((q) => {
    if (!q.key.startsWith("after:") || isFoldCard(q) || q.key === `after:${job.id}`) return [];
    // Parked while the note reader reads a note typed on it: closing it now would lose what the note asked for.
    if (q.notBefore && Date.parse(q.notBefore) > Date.now()) return [];
    const j = store.job(q.key.slice("after:".length));
    return near(j) && j.itemId ? [{ q, job: j }] : [];
  });
  // Another item's stop makes it a fold. An earlier stop on this same item alone doesn't (that's the usual single
  // card), but once folding, its card goes too: the item's row shows the newest stop.
  if (!fold && !peers.some((p) => p.job.itemId !== item.id)) return false;

  const members = new Map<string, Member>();
  const add = (j: Job) => {
    if (j.status !== "failed") return; // reported after all since: not stopped any more
    const it = j.itemId ? store.item(j.itemId) : undefined;
    if (it && !isOpen(it)) return; // closed since its card was drawn
    const had = it && members.get(it.id);
    if (it && (!had || finished(j) >= finished(had.job))) members.set(it.id, { job: j, item: it }); // newest stop per item
  };
  for (const id of fold ? Object.values(foldJobs(fold)) : []) {
    const j = store.job(id);
    if (j) add(j);
  }
  for (const p of peers) add(p.job);
  add(job); // the newest stop on an item wins its row
  const list = [...members.values()].sort((a, b) => finished(a.job) - finished(b.job));
  const card = foldCard(list, job.error!);

  if (fold) {
    // A new stop shows now, even on a card that was snoozed: its own card is what it replaces.
    Object.assign(fold, card, { notBefore: undefined });
    store.putQuestion(fold);
    hub.emit({ type: "question", data: fold });
  } else if (!hub.ask({ ...card, key: `${FOLD_PREFIX}${list[0]!.job.id}` })) return false; // key taken: keep the single cards
  for (const p of peers) hub.expireQuestion(p.q.id, "folded into one card: same error");
  return true;
}

/**
 * The fold card follows the board: rows whose item closed, or whose job recovered (reported after all), drop off; it
 * goes when none are left. Runs every tick (Prompter.expireMoot).
 */
export function pruneFold(hub: Hub, q: Question) {
  const store = hub.store;
  const jobs = foldJobs(q);
  const keep: Member[] = [];
  for (const [itemId, jobId] of Object.entries(jobs)) {
    const it = store.item(itemId);
    const j = store.job(jobId);
    if (it && isOpen(it) && j?.status === "failed") keep.push({ job: j, item: it });
  }
  if (keep.length === Object.keys(jobs).length) return;
  if (!keep.length) return hub.expireQuestion(q.id, "moot");
  keep.sort((a, b) => finished(a.job) - finished(b.job));
  Object.assign(q, foldCard(keep, keep[0]!.job.error ?? ""));
  store.putQuestion(q);
  hub.emit({ type: "question", data: q });
}

/**
 * The card was answered with Check / Send again: rows that weren't handled (unticked, or the send failed) come back on
 * it (same key), so they aren't stranded on doing with nothing asking about them.
 */
export function foldRest(hub: Hub, q: Question, handled: string[]) {
  const store = hub.store;
  const rest: Member[] = [];
  for (const [itemId, jobId] of Object.entries(foldJobs(q))) {
    if (handled.includes(itemId)) continue;
    const it = store.item(itemId);
    const j = store.job(jobId);
    if (it && isOpen(it) && j?.status === "failed") rest.push({ job: j, item: it });
  }
  if (!rest.length) return;
  rest.sort((a, b) => finished(a.job) - finished(b.job));
  hub.ask({ ...foldCard(rest, rest[0]!.job.error ?? ""), key: q.key });
}
