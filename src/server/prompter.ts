// The proactive part. Every tick, look at items + calendar + clock and decide
// what to ask. Rules are deliberately boring and deterministic — the AI does
// extraction and verification; *when to interrupt* stays predictable.

import type { ActionKind, CalendarEvent, Coaching, Item, Job, Question, QuestionOption, QuestionPick } from "../shared/types.ts";
import { config, sweepOn } from "./config.ts";
import { isAgentCard } from "../shared/boss.ts";
import { isOpen } from "./dedupe.ts";
import type { Hub } from "./hub.ts";
import { localDate } from "./memory-sync.ts";
import { type JiraDone, JiraStates } from "./jira-state.ts";
import { type MrRef, MrStates, mrRefs } from "./mr-state.ts";
import { plain } from "./parse.ts";
import { type PrRef, PrStates, prRefs } from "./pr-state.ts";
import { openUrl } from "./prompts.ts";

const MIN = 60_000;
const DAY = 86_400_000;
/** "X just ended" waits this long after the meeting: the end of the scheduler's last notes-sweep window
 * (NOTES_WINDOWS_MIN). 10-23: of 10 cards a scan closed in October, 3 closed by 25 min and 9 by 60. */
export const REVIEW_HOLD_MIN = 60;
/** Minutes after a meeting ends when the scheduler scans for its notes, once per window, if it's still unscanned. */
export const NOTES_WINDOWS_MIN: ReadonlyArray<readonly [number, number]> = [[10, 25], [45, REVIEW_HOLD_MIN]];

/** Caps so the app asks, rather than nags. */
const CAP = { state: 3, doing: 3, kill: 3, proposal: 2, post: 2, inbox: 6, waiting: 2, total: 14 };

const nameTokens = (s: string) => s.toLowerCase().split("@")[0]!.split(/[\s._-]+/).filter(Boolean);

/** True if an attendee ("alex@x.com", "alex.owner@gmail.com", "Alex Owner") is the owner (config.owner.aliases). */
export function isOwner(attendee: string, aliases: string[] = config.owner.aliases) {
  const who = nameTokens(attendee);
  return aliases.some((a) => {
    const t = nameTokens(a);
    return t.length > 0 && t.every((w, i) => who[i] === w);
  });
}

/** Mon–Fri. */
export const isWorkday = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6;

/**
 * Milliseconds of work time between `from` and `to`: weekdays, inside `hours` ([start, end) local, may be fractional).
 * "4 work hours" set at 17:00 Friday means 13:00 Monday, not 21:00 Friday.
 */
export function workMsBetween(from: Date, to: Date, hours: [number, number] = config.sweeps.workHours) {
  let total = 0;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (; day < to; day.setDate(day.getDate() + 1)) {
    if (!isWorkday(day)) continue;
    const start = day.getTime() + hours[0] * 3600_000;
    const end = day.getTime() + hours[1] * 3600_000;
    total += Math.max(0, Math.min(end, to.getTime()) - Math.max(start, from.getTime()));
  }
  return total;
}

/** A `doing` item with no live job and nothing asked gets "Still on it?" after this much work time. */
export const DOING_IDLE_MS = 4 * 3600_000;

export function atLocal(hours: number, minutes = 0, dayOffset = 0, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/** "Tomorrow 9:00" style scheduling choices relative to now. */
export function whenOptions(now = new Date()): QuestionOption[] {
  const opts: Array<[string, Date]> = [];
  const inHour = new Date(now.getTime() + 60 * MIN);
  inHour.setMinutes(inHour.getMinutes() < 30 ? 30 : 60, 0, 0);
  opts.push([`${fmt(inHour)} today`, inHour]);
  if (now.getHours() < 14) opts.push(["This afternoon · 14:00", atLocal(14, 0, 0, now)]);
  opts.push(["Tomorrow · 09:30", atLocal(9, 30, 1, now)]);
  const mon = atLocal(9, 30, ((8 - now.getDay()) % 7) || 7, now);
  opts.push(["Next week · Mon 09:30", mon]);
  return opts.map(([label, at], i) => ({
    id: `w${i}`,
    label,
    tone: i === 0 ? "primary" : "quiet",
    effect: { type: "schedule", at: at.toISOString(), label },
  }));
}

export function fmt(d: Date) {
  return d.toTimeString().slice(0, 5);
}

const ACTION_FOR: Partial<Record<Item["kind"], { action: ActionKind; label: string }>> = {
  ticket: { action: "ticket", label: "File the ticket" },
  message: { action: "reply", label: "Draft + send reply" },
  email: { action: "email", label: "Draft the email" },
  followup: { action: "reply", label: "Chase them for me" },
  meeting: { action: "prep", label: "Prep a brief" },
  review: { action: "work", label: "Review it for me" },
  idea: { action: "work", label: "Send an agent" },
  task: { action: "work", label: "Send an agent" },
  decision: { action: "verify", label: "Gather the facts" },
  post: { action: "draft", label: "Draft it" },
};

/** Is there someone to chase? 10-22..10-24 three "Chase them" taps sent reply jobs with nobody to message. */
export const hasPeople = (it: Pick<Item, "people">) => Boolean(it.people?.some((p) => p.trim()));

/** The card's agent button for this item. A followup with no people has nobody to chase: send an agent instead. */
function actionFor(it: Item, kind: Item["kind"] = it.kind) {
  return kind === "followup" && !hasPeople(it) ? ACTION_FOR.task : ACTION_FOR[kind];
}

/** "Scheduled for…" — the owner says or types when (booked it already, or wants it booked/reminded). */
export const WHEN_OPT: QuestionOption = {
  id: "when",
  label: "Scheduled for…",
  hint: "say when — “booked Thu 2pm”, “put it in Friday morning”",
  effect: { type: "when" },
};

export class Prompter {
  constructor(
    private hub: Hub,
    /** MR state for items whose ref is an MR. Tests pass a stubbed fetch. */
    readonly mrs = new MrStates(),
    /** JIRA state for items whose ref is a ticket. Tests pass a stubbed fetch. */
    readonly jira = new JiraStates(),
    /** GitHub PR state for items that link a PR. Tests pass a stubbed fetch. */
    readonly prs = new PrStates(),
  ) {}

  /**
   * Has everything the item links to landed? Every MR and GitHub PR merged and every JIRA ticket done → Landed.
   * "pending" while a lookup is in flight. undefined when it has none, or any is open — or unknown: a stale Access
   * token or a glab / gh failure never counts as landed.
   */
  landed(it: Item): "pending" | Landed | undefined {
    const hasMr = mrRefs(it).length > 0;
    const hasJira = this.jira.refs(it).length > 0;
    const hasPr = prRefs(it).length > 0;
    if (!hasMr && !hasJira && !hasPr) return undefined;
    const mr = this.mrs.verdict(it);
    const jr = this.jira.verdict(it);
    const pr = this.prs.verdict(it);
    if ((hasMr && mr === undefined) || (hasJira && jr === undefined) || (hasPr && pr === undefined)) return undefined; // something's open: no need to wait
    if (mr === "pending" || jr === "pending" || pr === "pending") return "pending";
    const tickets = jr?.done ?? [];
    // Latest by time, not by string: GitHub drops milliseconds, so "…55Z" sorts after "…55.100Z".
    const at = [mr?.mergedAt, pr?.mergedAt, ...tickets.map((t) => t.doneAt)].filter((x): x is string => Boolean(x) && !Number.isNaN(Date.parse(x!))).sort((a, b) => Date.parse(a) - Date.parse(b)).pop();
    return { mrs: mr?.refs ?? [], mergedAt: mr?.mergedAt, prs: pr?.refs ?? [], prMergedAt: pr?.mergedAt, tickets, at };
  }

  /**
   * "Recheck": look up every open item's MRs, PRs and tickets again now, whatever the cache says, and put every
   * item whose links have all landed on one card, any lane (the merged card only reads `waiting`, once a day).
   * Tick the done ones: some ask for what comes after the merge ("Merge + deploy", "Verify after deploy").
   * Items an agent is on are left out: it will report. Replaces an open recheck card and folds in the merged card.
   */
  recheck(): Promise<RecheckResult> {
    // A second click while one runs gets the same answer, not a second round of lookups.
    this.rechecking ??= this.runRecheck()
      .catch((e) => {
        // Not a success, so no lastOkAt: the error alone stops the chip's "running" dots.
        const msg = e instanceof Error ? e.message : String(e);
        this.hub.putSync({ ...this.hub.store.syncState("recheck"), error: `Recheck failed: ${msg}` });
        this.hub.toast(`Recheck failed: ${msg}`, "warn");
        throw e;
      })
      .finally(() => (this.rechecking = undefined));
    return this.rechecking;
  }
  private rechecking?: Promise<RecheckResult>;

  private async runRecheck(): Promise<RecheckResult> {
    const store = this.hub.store;
    const hasRefs = (it: Item) => mrRefs(it).length > 0 || prRefs(it).length > 0 || this.jira.refs(it).length > 0;
    const before = store.items().filter((it) => isOpen(it) && hasRefs(it));
    this.hub.putSync({ ...store.syncState("recheck"), lastRunAt: new Date().toISOString(), error: undefined });
    // A lookup the 30-s tick started before the click may predate the merge, and get() won't start another while
    // it runs: let those land, then forget them too.
    await Promise.all([this.mrs.settled(), this.prs.settled(), this.jira.settled()]);
    this.mrs.forget(before);
    this.prs.forget(before);
    this.jira.forget(before);
    for (const it of before) this.landed(it);
    await Promise.all([this.mrs.settled(), this.prs.settled(), this.jira.settled()]);
    // Re-read: lookups take a while, and items close in the meantime.
    const busy = new Set(store.liveJobs().map((j) => j.itemId).filter(Boolean));
    const items = store.items().filter((it) => isOpen(it) && hasRefs(it));
    const failed = items.reduce((n, it) => n + this.mrs.failed(it) + this.prs.failed(it) + this.jira.failed(it), 0);
    const found: Array<{ it: Item; l: Landed }> = [];
    for (const it of items) {
      if (busy.has(it.id)) continue;
      const l = this.landed(it);
      if (l && l !== "pending") found.push({ it, l });
    }
    found.sort((a, b) => (a.l.at ?? "").localeCompare(b.l.at ?? "") || a.it.createdAt.localeCompare(b.it.createdAt));
    const summary = `${items.length} checked · ${found.length} landed${failed ? ` · ${failed} lookup${failed === 1 ? "" : "s"} failed` : ""}`;
    const prev = store.openQuestionByKey(RECHECK_KEY);
    if (prev) this.hub.expireQuestion(prev.id, "rechecked");
    let question: Question | undefined;
    if (found.length) {
      const merged = store.openQuestionByKey(MERGED_KEY);
      if (merged) this.hub.expireQuestion(merged.id, "folded into recheck");
      question = this.ask(recheckCard(found));
    }
    this.hub.putSync({
      ...store.syncState("recheck"),
      lastOkAt: new Date().toISOString(),
      cursor: summary,
      // A failed lookup never counts as landed: say so, it's usually a stale glab / Access login.
      error: failed ? `${failed} lookup${failed === 1 ? "" : "s"} failed (glab / gh / cloudflared access login?). Those items weren't counted.` : undefined,
    });
    this.hub.toast(found.length ? `Rechecked: ${summary}. One card to tick the done ones.` : `Rechecked: ${summary}. Nothing new landed.`, failed ? "warn" : "info");
    this.hub.journal(`Recheck: ${summary}`, { who: "hq" });
    return { checked: items.length, landed: found.map((f) => ({ id: f.it.id, title: f.it.title, status: f.it.status, line: mergedLine(f.l) })), failed, question: question?.id };
  }

  tick(now = new Date()) {
    const store = this.hub.store;
    let items = store.items();
    let open = (this.open = store.questions("open"));
    const openCount = (kind: Question["kind"], pred: (q: Question) => boolean = () => true) =>
      open.filter((q) => q.kind === kind && pred(q)).length;
    const stale = this.expireMoot(open, items, now);
    // It moves items to `waiting`: re-read them so the merged card below picks them up this tick.
    if (this.expireLanded(store.questions("open"), items)) items = store.items();
    // Both passes close cards: the caps and checks below count only what's still open.
    open = this.open = store.questions("open");
    // Deferred questions (notBefore later) don't count against the total: they aren't nagging anyone.
    // Per-kind caps still count them, so "skip all posts till Thu" also stops new post questions.
    // Proposal cards have their own slots (CAP.proposal), and cards older than STALE_WORKDAYS sit on the one
    // stale card (foldStale) instead: neither counts. 10-24..11-01: 8 of 15 open cards were over 3 workdays old,
    // the budget sat at 0, and no proposal was asked for a week.
    const old = staleBefore(now);
    let budget = CAP.total - open.filter((q) => !deferred(q, now) && !isProposalCard(q) && !isStale(q, old)).length;
    this.foldReviews(stale, now);
    if (this.foldStale(open, old, now)) budget--;

    const hour = now.getHours() + now.getMinutes() / 60;
    const [dayStart, dayEnd] = config.sweeps.workHours;
    const workday = isWorkday(now);
    const today = localDate(now);

    // Items an agent is already working on (verify leaves them in inbox): don't re-ask and re-dispatch.
    const busy = new Set(store.liveJobs().map((j) => j.itemId).filter(Boolean));

    // 1. Scheduled items that are due. Always ask — these are promises.
    for (const it of items) {
      if (it.status !== "scheduled" || !it.scheduledFor || Date.parse(it.scheduledFor) > now.getTime()) continue;
      // An agent is on it, or one already asked you something about it: wait for that, don't say "It's time" again.
      // 10-19: a verify job's question landed at 15:31, the 15-min due cooldown re-asked at 15:45.
      if (busy.has(it.id) || open.some((q) => q.itemId === it.id && !q.key.startsWith("due:"))) continue;
      // You just answered another card about it (a noop, typed context): give it 15 min too. The due card's own
      // cooldown is per slot (key), so a reschedule to a new slot still asks.
      const since = new Date(now.getTime() - 15 * MIN).toISOString();
      if (store.answeredForItem(it.id, since).some((q) => !q.key.startsWith("due:"))) continue;
      const act = actionFor(it);
      this.ask(
        {
          kind: "when",
          itemId: it.id,
          key: `due:${it.id}:${it.scheduledFor}`,
          priority: 90,
          prompt: `It's time: ${it.title}`,
          context: it.when ? `You said ${it.when}.` : undefined,
          options: dueOptions(act, this.pushesToday(it.id, now), now),
          // "Scheduled for…" resolves async; don't re-ask this slot while the new time is landing.
          cooldownMin: 15,
        },
        true,
      );
    }

    // 2. Meetings: prep is one morning card (askPrep, below); capture after.
    for (const ev of this.hub.todayEvents(now)) {
      if (ev.response === "declined") continue;
      // Only you on the invite (e.g. a personal block mirrored from a personal address): not a meeting.
      if (ev.attendees?.length && ev.attendees.every((a) => isOwner(a))) continue;
      const end = Date.parse(ev.end);
      // Never RSVP'd = probably didn't go. 1-1s are the exception: plenty of real ones never get accepted.
      const attended = ev.response !== "needsAction" || ev.oneOnOne;
      // The calendar sweep usually leaves you off the attendee list, so a real 1-1 has one attendee.
      const meeting = ev.oneOnOne || (ev.attendees?.length ?? 0) > 1;
      // Notes already scanned by the transcript sweep: it found whatever there was. Don't ask.
      if (attended && meeting && end < now.getTime() && now.getTime() - end < 45 * MIN && !this.hub.wasScanned(ev)) {
        this.ask({
          kind: "review",
          eventId: ev.id,
          key: `review:${ev.id}`,
          once: true,
          priority: 70,
          prompt: `${ev.title} just ended. Anything you committed to?`,
          // Hold it until the last notes-sweep window (NOTES_WINDOWS_MIN: 10–25 and 45–60 min after the end) has closed,
          // so a scan that finds the notes expires it unseen. Gemini notes often land after 25 min. 22 of 32 cards got "Nothing new" (10-22). The meeting row
          // takes dictation meanwhile. No transcript sweep, nothing to wait for.
          ...(sweepOn("transcripts") ? { notBefore: new Date(end + REVIEW_HOLD_MIN * MIN).toISOString() } : {}),
          context: `Type or say it below — it goes straight to triage.${sweepOn("transcripts") ? " Meeting notes get scanned on the next sweep either way." : ""}`,
          options: [
            opt("scan", "Scan the transcript now", { type: "sweep", name: "transcripts" }, "primary"),
            opt("none", "Nothing new", { type: "noop" }, "quiet"),
          ],
        });
      }
    }

    // 3. Morning plan, once per workday.
    if (workday && hour >= dayStart && hour < 12) {
      this.ask({
        kind: "plan",
        key: `plan:${today}`,
        once: true,
        priority: 95,
        prompt: "Morning. What are today's three?",
        context: "Up to three suggested, with why. Search or type to add anything else. Unticked items on today go back to the backlog.",
        options: [
          opt("plan", "Commit to these", { type: "commitPlan" }, "primary"),
          opt("later", "Ask me in 30 min", { type: "snooze", minutes: 30 }, "quiet"),
        ],
      });
    }

    // 3b. Prep: one card for the day's 1-1s and small meetings, after the plan.
    // Asked before noon only, but an open card keeps following the calendar all day (drops started meetings, expires).
    if (workday && hour >= dayStart && (hour < 12 || this.hub.store.openQuestionByKey(`prep:${today}`))) this.askPrep(now, today);

    // 4. Wrap-up, once per workday, 90 min before the end of the day. Ignored two days running → back off (wrapDue).
    // The journal still flushes on the scheduler's cadence on a skipped day; only the "is this the truth" check is lost.
    // Today's card already exists: ask() won't re-ask it (once), so skip the history query on every later tick.
    const wrapKey = `wrap:${today}`;
    const wrapAsked = () => !!(this.hub.store.openQuestionByKey(wrapKey) || this.hub.store.lastAnswered(wrapKey));
    if (workday && hour >= dayEnd - 1.5 && hour < dayEnd + 3 && (wrapAsked() || wrapDue(this.hub.store.closedByPrefix("wrap:", 100), today))) {
      this.ask({
        kind: "wrap",
        key: wrapKey,
        once: true,
        priority: 88,
        prompt: "Wrap up. What actually happened today?",
        context: "Confirm the real state of what you touched. It goes to memory, so tonight's reflection starts from the truth.",
        options: [
          opt("flush", "That's the truth — save it", { type: "flushJournal" }, "primary"),
          opt("later", "Ask me in an hour", { type: "snooze", minutes: 60 }, "quiet"),
        ],
      });
    }

    // 4b. The coaching card's "one thing to try": at its time, ask whether it happened, once per reflection.
    // 10-17..10-19 the reflection kept finding the move hadn't happened, and only guessed why. The answer goes
    // to the journal as "M5 move: … → Done / Hand to an agent / Not today", which nightly-reflect §7 reads.
    this.askCoachMove(now, open);

    // 8. Reflection proposals — the ones that never turn into anything. Before the budget check: they have their own slots.
    const proposals = items
      // A proposal merged into an existing item (proposalOf) counts too, whatever that item's kind or source.
      .filter((i) => i.status === "proposed" && (i.proposalOf || (i.kind === "idea" && i.source.label?.startsWith("Proposals"))))
      // Newest reflection first; within it High Priority before Medium/Low, then file order. createdAt is the
      // file order. memory sync writes rows top to bottom, so `updated` creeps up in file order, and store.items() is
      // ORDER BY updated DESC: without a tiebreak a day's proposals came out last-first (10-18: #9 and #8 asked, #1 never).
      .sort((a, b) => propDate(b).localeCompare(propDate(a)) || propRank(a) - propRank(b) || a.createdAt.localeCompare(b.createdAt));
    // Own slots: only open proposal cards count, never the total budget. Full (the usual case): no lookups at all.
    let slots = CAP.proposal - openCount("dispatch", isProposalCard);
    for (const it of proposals) {
      if (slots <= 0) break;
      const asked = this.ask({
        kind: "dispatch",
        itemId: it.id,
        key: `proposal:${it.id}`,
        priority: 45,
        prompt: it.title,
        context: `${propSource(it)} ${excerpt(it.detail) ?? ""}`,
        options: [
          opt("go", "Do it — send an agent", { type: "dispatch", action: "work" }, "primary"),
          ...whenOptions(now).slice(1, 2),
          WHEN_OPT,
          opt("no", "Reject", { type: "status", status: "dropped", note: "rejected proposal" }, "danger"),
        ],
        cooldownMin: 5 * 24 * 60,
      });
      if (asked) slots--;
    }

    if (budget <= 0) return;

    // 5. Inbox triage — captured but nobody's decided what it is.
    const inbox = items
      .filter((i) => i.status === "inbox")
      .sort((a, b) => Number(b.signals?.pineapple ?? 0) - Number(a.signals?.pineapple ?? 0));
    for (const it of inbox) {
      if (budget <= 0 || openCount("confirm") >= CAP.inbox) break;
      // Something (a check) is already asking about it, with better answers than these.
      if (open.some((q) => q.itemId === it.id)) continue;
      if (busy.has(it.id)) continue;
      // 🍍 means "this should become a ticket" unless it's clearly a message/email.
      const act = it.signals?.pineapple && !["message", "email"].includes(it.kind) ? ACTION_FOR.ticket : actionFor(it);
      if (
        this.ask({
          kind: "confirm",
          itemId: it.id,
          key: `inbox:${it.id}`,
          badge: it.signals?.pineapple ? "🍍 Captured" : `Captured · ${it.source.type}`,
          priority: it.signals?.pineapple ? 82 : 65,
          prompt: it.title,
          context: [it.source.label, it.source.quote ? `“${it.source.quote}”` : ""].filter(Boolean).join(" — "),
          options: [
            ...(act ? [opt("go", act.label, { type: "dispatch", action: act.action }, "primary")] : []),
            opt("today", "Mine, today", { type: "status", status: "today" }, act ? "quiet" : "primary"),
            opt("later", "Mine, later", { type: "status", status: "proposed" }),
            WHEN_OPT,
            opt("notmine", "Not mine / not real", { type: "status", status: "dropped" }, "danger"),
          ],
          // An answer that leaves it in inbox (verify, a dispatch that finished without triage) waits before re-asking.
          cooldownMin: 30,
        })
      )
        budget--;
    }

    // 5b. `doing` with nobody on it: no live job, no open question, quiet for 4 work hours. 10-19..10-21 three items
    // sat there: a failed job whose after-card got "Show me the session", and two "I'm on it" taps on due cards.
    for (const it of this.idleDoing(items, busy, now)) {
      if (budget <= 0 || openCount("state", (q) => q.key.startsWith("doing:")) >= CAP.doing) break;
      const since = new Date(it.since);
      const last = it.job?.summary ?? it.job?.error;
      if (
        this.ask({
          kind: "state",
          itemId: it.item.id,
          key: `doing:${it.item.id}`,
          badge: "Still on it?",
          priority: 62,
          prompt: `Still on it? ${it.item.title}`,
          context: [
            `On “doing” since ${since.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}, with no agent running and nothing asked.`,
            it.job ? `Last agent run ${it.job.status}${last ? `: ${excerpt(last, 200)}` : "."}` : "",
          ].filter(Boolean).join(" "),
          options: [
            opt("done", "Done", { type: "status", status: "done" }, "good"),
            opt("wait", "Waiting on someone", { type: "status", status: "waiting" }),
            opt("today", "Still mine today", { type: "status", status: "today" }, "primary"),
            opt("drop", "Drop it", { type: "status", status: "dropped" }, "danger"),
          ],
          cooldownMin: 24 * 60,
        })
      )
        budget--;
    }

    // 6. Kill dates from the reflection — keep or kill.
    for (const it of items) {
      if (budget <= 0 || openCount("state", (q) => q.key.startsWith("kill:")) >= CAP.kill) break;
      const kill = it.signals?.killDate;
      if (!kill || ["done", "dropped"].includes(it.status)) continue;
      const days = (Date.parse(`${kill}T23:59:59`) - now.getTime()) / DAY;
      if (days > 2) continue;
      if (
        this.ask({
          kind: "state",
          itemId: it.id,
          key: `kill:${it.id}:${kill}`,
          badge: "Kill date",
          priority: days < 0 ? 78 : 72,
          prompt: it.title,
          context: `${days < 0 ? `Kill date ${kill} has passed` : `Kill date is ${days < 1 ? "today" : "tomorrow"}`} — the reflection set it so this stops carrying over. Keep or kill?`,
          options: [
            opt("kill", "Kill it", { type: "status", status: "dropped", note: "killed at kill date" }, "danger"),
            opt("today", "Do it today", { type: "status", status: "today" }, "primary"),
            opt("done", "It's done", { type: "status", status: "done" }, "good"),
            opt("week", "Extend a week", { type: "schedule", at: atLocal(9, 30, 7, now).toISOString(), label: "a week from now" }),
            WHEN_OPT,
          ],
          cooldownMin: 24 * 60,
        })
      )
        budget--;
    }

    // 7. "State unknown" — the reflection's admission it doesn't know. Ask.
    const unknown = items
      .filter((i) => i.signals?.stateUnknown && ["proposed", "inbox"].includes(i.status))
      .filter((i) => !i.confirmedAt || now.getTime() - Date.parse(i.confirmedAt) > 3 * DAY)
      .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
    for (const it of unknown) {
      if (budget <= 0 || openCount("state", (q) => q.key.startsWith("state:")) >= CAP.state) break;
      // An MR or ticket ref answers the question better than memory can. Hold the card until glab / JIRA has replied.
      const mr = this.landed(it);
      if (mr === "pending") continue;
      if (
        this.ask({
          kind: "state",
          itemId: it.id,
          key: `state:${it.id}`,
          ...(mr ? { badge: landedBadge([mr]) } : {}),
          priority: 60,
          prompt: it.title,
          context: mr ? `${mergedLine(mr)} Probably done.` : `Memory doesn't know where this stands.${it.detail ? ` ${excerpt(it.detail)}` : ""}`,
          options: [
            opt("done", mr ? mergedLabel(mr) : "Done", { type: "status", status: "done", ...(mr ? { note: mergedLine(mr) } : {}) }, mr ? "primary" : "good"),
            opt("today", "Doing it today", { type: "status", status: "today" }, mr ? "quiet" : "primary"),
            opt("wait", "Waiting on someone", { type: "status", status: "waiting" }),
            opt("check", "Check for me", { type: "dispatch", action: "verify" }),
            WHEN_OPT,
            opt("drop", "Drop it", { type: "status", status: "dropped" }, "danger"),
          ],
          cooldownMin: 3 * 24 * 60,
        })
      )
        budget--;
    }

    // 9. Waiting on work whose MRs all merged and tickets are done: one card for all of them, daily, instead of one per item after 3 days.
    const batched = budget > 0 ? this.sweepMergedWaiting(items, now) : this.mergedCardItems();
    if (batched.asked) budget--;

    // 10. Waiting too long.
    // "One by one" on the merged card skips the 3-day wait, until the item is touched.
    const { split } = this.mergedAnswers();
    const overdue = (i: Item) => now.getTime() - Date.parse(i.updatedAt) > 3 * DAY || (split[i.id] !== undefined && i.updatedAt <= split[i.id]!);
    for (const it of items.filter((i) => i.status === "waiting" && overdue(i))) {
      if (budget <= 0 || openCount("state", (q) => q.key.startsWith("wait:") && q.key !== MERGED_KEY) >= CAP.waiting) break;
      if (batched.ids.has(it.id)) continue;
      const mr = this.landed(it);
      if (mr === "pending") continue;
      const waited = `You've been waiting on this for ${Math.round((now.getTime() - Date.parse(it.updatedAt)) / DAY)} days.`;
      if (
        this.ask({
          kind: "state",
          itemId: it.id,
          key: `wait:${it.id}`,
          badge: mr ? landedBadge([mr]) : "Still waiting",
          priority: 50,
          prompt: it.title,
          context: mr ? `${waited} ${mergedLine(mr)}` : waited,
          options: [
            ...(mr ? [opt("done", mergedLabel(mr), { type: "status", status: "done", note: mergedLine(mr) }, "primary")] : []),
            // Nobody named: nothing to chase, so "Resolved" leads (10-24: a bug to fix got a chase job).
            ...(hasPeople(it) ? [opt("chase", "Chase them", { type: "dispatch", action: "reply" }, mr ? "quiet" : "primary")] : []),
            ...(mr ? [] : [opt("done", "Resolved", { type: "status", status: "done" }, hasPeople(it) ? "good" : "primary")]),
            opt("keep", "Keep waiting", { type: "status", status: "waiting" }),
            WHEN_OPT,
          ],
          cooldownMin: 2 * 24 * 60,
        })
      )
        budget--;
    }

    // 11. Blog posts — drafts to review first, then bare ideas. Low priority, never nags.
    const posts = items
      .filter((i) => i.kind === "post" && i.status === "proposed")
      .sort((a, b) => Number(hasDraft(b)) - Number(hasDraft(a)) || b.createdAt.localeCompare(a.createdAt));
    for (const it of posts) {
      if (budget <= 0 || openCount("post") >= CAP.post) break;
      const drafts = [it.post?.wikiDraft, it.post?.siteDraft].filter(Boolean) as string[];
      const { wiki, site } = config.writing;
      const venue = { wiki: wiki.name, site: site.name, both: `${wiki.name} + ${site.name}` }[it.post?.venue ?? "wiki"];
      if (
        this.ask({
          kind: "post",
          itemId: it.id,
          key: `post:${it.id}:${drafts.length ? "draft" : "idea"}`,
          badge: drafts.length ? "Draft to review" : "Post idea",
          priority: drafts.length ? 42 : 38,
          prompt: it.title,
          context: [`**${venue}**`, it.post?.why, excerpt(it.detail, 360), it.post?.gap ? `Gap check: ${it.post.gap}` : ""].filter(Boolean).join(" — "),
          options: drafts.length
            ? [
                opt("read", "Open draft", { type: "open", url: openUrl(drafts[0]!), keep: true }, "primary"),
                ...(drafts[1] ? [opt("read2", "Open public version", { type: "open", url: openUrl(drafts[1]), keep: true })] : []),
                opt("publish", "Publish…", { type: "dispatch", action: "publish" }, "good"),
                opt("revise", "Revise (use the note)", { type: "dispatch", action: "draft" }),
                WHEN_OPT,
                opt("no", "Not for me", { type: "status", status: "dropped", note: "post declined" }, "danger"),
              ]
            : [
                opt("draft", "Draft it", { type: "dispatch", action: "draft" }, "primary"),
                WHEN_OPT,
                opt("no", "Not for me", { type: "status", status: "dropped", note: "post idea declined" }, "danger"),
              ],
          cooldownMin: 4 * 24 * 60,
        })
      )
        budget--;
    }
  }

  private open: Question[] = [];

  /**
   * `doing` items nobody is on: no live job, no open question about it, and DOING_IDLE_MS of work time since the
   * last sign of life (the item's own update, its latest job, its latest answered card). Oldest first.
   */
  private idleDoing(items: Item[], busy: Set<string | undefined>, now: Date) {
    const doing = items.filter((i) => i.status === "doing" && !busy.has(i.id) && !this.open.some((q) => q.itemId === i.id));
    if (!doing.length) return [];
    const jobs = this.hub.store.jobs(500);
    const out: { item: Item; since: string; job?: Job }[] = [];
    for (const item of doing) {
      const job = jobs.find((j) => j.itemId === item.id); // newest first
      let since = [item.updatedAt, job?.finishedAt ?? job?.startedAt ?? job?.createdAt ?? ""].sort().pop()!;
      for (const q of this.hub.store.answeredForItem(item.id, since)) if (q.answeredAt && q.answeredAt > since) since = q.answeredAt;
      if (workMsBetween(new Date(since), now) >= DOING_IDLE_MS) out.push({ item, since, job });
    }
    return out.sort((a, b) => a.since.localeCompare(b.since));
  }

  private askCoachMove(now: Date, open: Question[]) {
    const c = this.hub.coaching();
    const key = c ? coachKey(c) : undefined;
    // A newer reflection replaced the move: the old card is moot (unanswered is itself the answer §7 reports).
    for (const q of open) if (q.key.startsWith("coach:") && q.key !== key) this.hub.expireQuestion(q.id, "new reflection");
    if (!c || !key) return;
    const due = coachDue(c);
    if (!due || now < due) return;
    // A stale coaching block (the reflection stopped running) shouldn't surface days later.
    if (now.getTime() - due.getTime() > 2 * DAY) return;
    this.ask({ ...coachQuestion(c), key, once: true });
  }

  /**
   * Waiting items whose MRs all merged and JIRA tickets are done, on one card ("N waiting items: their MRs merged"), at most once a day.
   * 10-18: eight items sat in Waiting on MRs merged 10-14/10-15, and the per-item card only fires after 3 days, two at a time.
   * "Keep waiting" remembers those items (per merge date), so the card doesn't come back for them; the per-item card still can.
   * An open card is refreshed as items close on their own, and expires when none are left.
   */
  private sweepMergedWaiting(items: Item[], now: Date): { asked: boolean; ids: Set<string> } {
    const store = this.hub.store;
    const { kept } = this.mergedAnswers();
    const prev = store.openQuestionByKey(MERGED_KEY);
    if (!prev) {
      const last = store.lastAnswered(MERGED_KEY);
      // Answered only: a card that expired because its items moved on (closed elsewhere, left waiting) wasn't seen.
      if (last?.status === "answered" && last.answeredAt && now.getTime() - Date.parse(last.answeredAt) < MERGED_COOLDOWN_MIN * MIN) return { asked: false, ids: new Set() };
    }
    const found: Array<{ it: Item; mr: Landed }> = [];
    let pending = false;
    // On the open recheck card already: one card per item.
    const onRecheck = new Set((store.openQuestionByKey(RECHECK_KEY)?.picks ?? []).map((p) => p.id));
    for (const it of items) {
      if (it.status !== "waiting" || onRecheck.has(it.id)) continue;
      const mr = this.landed(it);
      if (mr === "pending") pending = true;
      else if (mr && !(kept[it.id] !== undefined && (mr.at ?? "") <= kept[it.id]!)) found.push({ it, mr });
    }
    // Hold until every lookup has landed, so the card doesn't grow one item per tick.
    if (pending) return { asked: false, ids: new Set(mergedIds(prev)) };
    found.sort((a, b) => (a.mr.at ?? "").localeCompare(b.mr.at ?? "") || a.it.createdAt.localeCompare(b.it.createdAt));
    const ids = new Set(found.map((f) => f.it.id));
    if (prev) {
      if (!found.length) this.hub.expireQuestion(prev.id, "nothing left");
      // itemId too: a card drawn before mergedCard() set it (10-22 "chase Omar") heals on the next tick.
      else if (mergedIds(prev).join() !== [...ids].join() || prev.itemId !== mergedCard(found).itemId) {
        Object.assign(prev, mergedCard(found));
        store.putQuestion(prev);
        this.hub.emit({ type: "question", data: prev });
      }
      return { asked: false, ids };
    }
    if (!found.length) return { asked: false, ids };
    return { asked: Boolean(this.ask({ ...mergedCard(found), kind: "state", key: MERGED_KEY })), ids };
  }

  /** Items on the open merged-MRs card, when the sweep doesn't run this tick. */
  private mergedCardItems() {
    return { asked: false, ids: new Set(mergedIds(this.hub.store.openQuestionByKey(MERGED_KEY))) };
  }

  /**
   * What the owner said on earlier merged-MRs cards. `kept`: item → when they chose to keep waiting or go one by one
   * (the card skips it unless a newer merge lands). `split`: item → when they asked for one card each (section 10 asks
   * without the 3-day wait until the item is touched). Folds in the latest answer once.
   */
  private mergedAnswers(): { kept: Record<string, string>; split: Record<string, string> } {
    const store = this.hub.store;
    let saved: { kept: Record<string, string>; split: Record<string, string>; seen?: string; seenRecheck?: string } = { kept: {}, split: {} };
    try {
      saved = { ...saved, ...JSON.parse(store.kv(KEPT_KEY) ?? "{}") };
    } catch {}
    const last = store.lastAnswered(MERGED_KEY);
    const keep = last?.answer?.startsWith(KEEP_LABEL);
    const split = last?.answer?.startsWith(SPLIT_LABEL);
    if (last?.status === "answered" && (keep || split) && saved.seen !== last.id) {
      // Everything on the card had merged by the answer; a later merge (a new MR on the item) puts it back on the card.
      const at = last.answeredAt ?? last.createdAt;
      for (const id of mergedIds(last)) {
        saved.kept[id] = at;
        if (split) saved.split[id] = at;
      }
      saved.seen = last.id;
      store.setKv(KEPT_KEY, JSON.stringify(saved));
    }
    // An answered recheck card already showed these items: the merged card skips them too, unless a newer merge lands.
    const re = store.lastAnswered(RECHECK_KEY);
    if (re?.status === "answered" && saved.seenRecheck !== re.id) {
      const at = re.answeredAt ?? re.createdAt;
      for (const p of re.picks ?? []) saved.kept[p.id] = at;
      saved.seenRecheck = re.id;
      store.setKv(KEPT_KEY, JSON.stringify(saved));
    }
    return saved;
  }

  /** "Push 1 hour" taps since local midnight on this item's due prompts (any slot). */
  private pushesToday(itemId: string, now: Date) {
    const since = atLocal(0, 0, 0, now).toISOString();
    return this.hub.store.answeredByPrefix(`due:${itemId}:`, since).filter((q) => q.answer?.startsWith(PUSH_1H)).length;
  }

  /**
   * One prep card a day, in the morning plan window: tick the 1-1s and small meetings worth a brief, each tick
   * sends a prep agent. It replaced a card 20 min before each meeting: 17 of 19 expired untouched (10-22
   * proposal; 8 of 8 on 10-20). While open, the list follows the calendar: started meetings drop off, new ones
   * join, and the card goes once nothing's left to prep.
   */
  private askPrep(now: Date, today: string) {
    const key = `prep:${today}`;
    const picks = prepPicks(this.hub.todayEvents(now), now);
    const prev = this.hub.store.openQuestionByKey(key);
    if (prev) {
      if (!picks.length) return this.hub.expireQuestion(prev.id, "meetings started");
      const card = prepCard(picks);
      if (JSON.stringify(prev.picks) === JSON.stringify(card.picks)) return;
      Object.assign(prev, card);
      this.hub.store.putQuestion(prev);
      this.hub.emit({ type: "question", data: prev });
      return;
    }
    if (picks.length) this.ask({ ...prepCard(picks), key, once: true });
  }

  private ask(q: Omit<Question, "id" | "status" | "createdAt"> & { cooldownMin?: number; once?: boolean }, notify = false) {
    const created = this.hub.ask(q);
    if (created) this.open.push(created);
    if (created && (notify || q.priority >= 80)) {
      this.hub.emit({ type: "notify", data: { title: "Work HQ", body: q.prompt, questionId: created.id } });
    }
    return created;
  }

  /**
   * Fold "X just ended" cards from earlier days into one card. Nine in ten of these got "Nothing new"
   * in a bulk clear the next morning (10-15), but a few caught real commitments — so keep one question
   * with the titles and the typed-input path, instead of one tap per meeting.
   */
  private foldReviews(stale: StaleMeeting[], now: Date) {
    if (!stale.length) return;
    const today = localDate(now);
    const key = `reviews:${today}`;
    const prev = this.hub.store.openQuestionByKey(key);
    let seen: StaleMeeting[] = [];
    try {
      if (prev) seen = JSON.parse(this.hub.store.kv(key) ?? "[]");
    } catch {}
    // Chronological, not the order the open questions came back in (ORDER BY updated ties within a ms).
    const meetings = [...seen, ...stale]
      .filter((m, i, all) => all.findIndex((x) => x.title === m.title && x.day === m.day) === i)
      .sort((a, b) => (a.start ?? a.day).localeCompare(b.start ?? b.day));
    this.hub.store.setKv(key, JSON.stringify(meetings));
    const q = reviewDigest(meetings, now);
    if (prev) {
      Object.assign(prev, { prompt: q.prompt, context: q.context });
      this.hub.store.putQuestion(prev);
      this.hub.emit({ type: "question", data: prev });
      return;
    }
    const [h] = config.sweeps.workHours;
    const start = atLocal(Math.floor(h), Math.round((h % 1) * 60), 0, now);
    this.ask({ ...q, key, ...(now < start ? { notBefore: start.toISOString() } : {}) });
  }

  /**
   * Cards older than STALE_WORKDAYS go on one card: tick the ones to close, close them all, or keep them. The
   * cards themselves stay open (an agent's question or a due slot keeps its buttons), they just stop counting
   * against the total (the budget in `tick`). "Keep them" remembers those cards, so the next stale card lists only new ones.
   * An open stale card follows the board: cards closed elsewhere drop off, newly stale ones join, it goes when
   * none are left. Returns whether it asked a new card.
   */
  private foldStale(open: Question[], old: number, now: Date): boolean {
    const store = this.hub.store;
    const kept = this.staleKept(open);
    const cards = open
      .filter((q) => isStale(q, old) && !deferred(q, now) && !kept.has(q.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const prev = store.openQuestionByKey(STALE_KEY);
    if (prev) {
      if (!cards.length) this.hub.expireQuestion(prev.id, "nothing left");
      else {
        const next = staleCard(cards);
        if ((prev.picks ?? []).map((p) => p.id).join() === next.picks.map((p) => p.id).join() && prev.prompt === next.prompt) return false;
        Object.assign(prev, next);
        store.putQuestion(prev);
        this.hub.emit({ type: "question", data: prev });
      }
      return false;
    }
    if (!cards.length) return false;
    return Boolean(this.ask({ ...staleCard(cards), key: STALE_KEY, cooldownMin: STALE_COOLDOWN_MIN }));
  }

  /** Cards a "Keep them" answer on the stale card kept, still open. Folds in the latest answer once. */
  private staleKept(open: Question[]): Set<string> {
    const store = this.hub.store;
    let saved: { ids: string[]; seen?: string } = { ids: [] };
    try {
      saved = { ...saved, ...JSON.parse(store.kv(STALE_KEPT_KEY) ?? "{}") };
    } catch {}
    const openIds = new Set(open.map((q) => q.id));
    const last = store.lastAnswered(STALE_KEY);
    let ids = saved.ids.filter((id) => openIds.has(id));
    let dirty = ids.length !== saved.ids.length;
    if (last?.status === "answered" && last.answer?.startsWith(STALE_KEEP_LABEL) && saved.seen !== last.id) {
      ids = [...new Set([...ids, ...(last.picks ?? []).map((p) => p.id).filter((id) => openIds.has(id))])];
      saved.seen = last.id;
      dirty = true;
    }
    if (dirty) store.setKv(STALE_KEPT_KEY, JSON.stringify({ ids, seen: saved.seen }));
    return new Set(ids);
  }

  /**
   * Agent cards on an item whose links have all landed (every MR / PR merged, every ticket done) are about work
   * that's finished, whoever merged it: close them, and put the item on the merged card (it goes to `waiting`, the
   * merged card's lane) so the owner confirms "done" with one tap. Unless another agent card stays open on it: then
   * the item stays in its lane, on the board where the owner sees it. 10-23: 10 of 13 "Agent asks" cards asked to merge
   * PRs that had merged hours before; the job that merged them never touched the items.
   * Skipped: items an agent is on (it will report), cards that wait for the merge ("When #137 merges, …"), cards
   * asked after the last merge (they're about the next step), and cards that name an unlanded ref or ask for work
   * after the merge ("…and deploy"). The Boss check covers those.
   */
  private expireLanded(open: Question[], items: Item[]) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const busy = new Set(this.hub.store.liveJobs().map((j) => j.itemId).filter(Boolean));
    const cards = open.filter((q) => isAgentCard(q) && q.itemId && !followsMerge(q));
    const done = new Map<string, Landed>();
    for (const q of cards) {
      const it = byId.get(q.itemId!);
      if (!it || !isOpen(it) || busy.has(it.id)) continue;
      const l = done.get(it.id) ?? this.landed(it);
      if (!l || l === "pending") continue;
      // Asked after the last merge: the agent knew, so it's about what comes next ("#150 merged. Now what?").
      // No landing date (some JIRA workflows): can't tell, leave it. Parsed: GitHub drops the milliseconds.
      if (!l.at || Date.parse(q.createdAt) >= Date.parse(l.at)) continue;
      if (!settledByLanding(q, l)) continue;
      done.set(it.id, l);
      this.hub.expireQuestion(q.id, `landed: ${mergedLine(l)}`);
    }
    const left = new Set(this.hub.store.questions("open").filter(isAgentCard).map((q) => q.itemId));
    for (const [id, l] of done) {
      const it = byId.get(id)!;
      // A scheduled item keeps its slot: its due card will ask then. An agent card still open on it (a deploy ask)
      // keeps it where it is too: "Done" on the merged card would close that card unanswered.
      if (it.status !== "waiting" && it.status !== "scheduled" && !left.has(id)) this.hub.updateItem(id, { status: "waiting" });
      this.hub.journal(`Closed agent cards, everything it links landed: ${it.title} — ${mergedLine(l)}`, { itemId: id, who: "hq" });
    }
    return done.size > 0;
  }

  /** The recheck card follows the board: items closed elsewhere drop off, and it goes once none are left. */
  private pruneRecheck(q: Question, byId: Map<string, Item>) {
    const keep = (q.picks ?? []).filter((p) => {
      const it = byId.get(p.id);
      return it && isOpen(it);
    });
    if (keep.length === (q.picks ?? []).length) return;
    if (!keep.length) return this.hub.expireQuestion(q.id, "nothing left");
    const n = keep.length;
    Object.assign(q, {
      picks: keep,
      prompt: n === 1 ? `Everything this links to has landed: ${keep[0]!.label}. Done?` : `${n} open items: everything they link to has landed. Which are done?`,
      context: `${(q.context ?? "").split("\n")[0]}\n${keep.map((p) => `- ${p.label} (${p.hint})`).join("\n")}`,
      options: q.options.map((o) => (o.id === "all" ? { ...o, label: n === 1 ? "Mark it done" : `Mark all ${n} done` } : o)),
    });
    this.hub.store.putQuestion(q);
    this.hub.emit({ type: "question", data: q });
  }

  /** Close questions whose item moved on without them. Returns the meeting-ended cards it closed as stale. */
  private expireMoot(open: Question[], items: Item[], now: Date) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const today = localDate(now);
    const stale: StaleMeeting[] = [];
    for (const q of open) {
      const it = q.itemId ? byId.get(q.itemId) : undefined;
      if (q.itemId && (!it || ["done", "dropped"].includes(it.status))) this.hub.expireQuestion(q.id, "moot");
      // Rescheduled (or started / un-scheduled) since this was asked: the old slot's prompt is stale.
      else if (q.key.startsWith("due:") && it && (it.status !== "scheduled" || q.key !== `due:${it.id}:${it.scheduledFor}`)) this.hub.expireQuestion(q.id, "rescheduled");
      // "Still on it?" once it's off `doing` (answered elsewhere, re-dispatched) or an agent picked it up again.
      else if (q.key.startsWith("doing:") && it && (it.status !== "doing" || this.hub.store.liveJobs().some((j) => j.itemId === it.id))) this.hub.expireQuestion(q.id, "moved on");
      // The one-item merged card is that item's card now (it blocks its other prompts): gone once it's off `waiting`.
      else if (q.key === MERGED_KEY && it && it.status !== "waiting") this.hub.expireQuestion(q.id, "moved on");
      else if (q.key === RECHECK_KEY) this.pruneRecheck(q, byId);
      else if (q.kind === "confirm" && it && it.status !== "inbox") this.hub.expireQuestion(q.id, "triaged");
      else if (q.kind === "post" && it && q.key.endsWith(":idea") && hasDraft(it)) this.hub.expireQuestion(q.id, "drafted");
      else if (q.kind === "prep" && q.eventId && this.startedAgo(q.eventId, now) > 10 * MIN) this.hub.expireQuestion(q.id, "meeting started");
      // Yesterday's morning prep card (and any per-meeting card left from before it, which has an eventId).
      else if (q.kind === "prep" && !q.eventId && q.key !== `prep:${today}`) this.hub.expireQuestion(q.id, "day moved on");
      else if (q.kind === "plan" && now.getHours() >= 14) this.hub.expireQuestion(q.id, "day moved on");
      // A snoozed wrap/plan keeps its old key; once the date rolls over it's a stale duplicate.
      else if ((q.kind === "wrap" || q.kind === "plan") && q.key !== `${q.kind}:${localDate(now)}`) this.hub.expireQuestion(q.id, "day moved on");
      // A meeting from an earlier day: fold it into the one morning card (foldReviews).
      else if (q.kind === "review" && q.eventId) {
        const ev = this.hub.store.events().find((e) => e.id === q.eventId);
        const start = new Date(ev?.start ?? q.createdAt);
        const day = localDate(start);
        // Asked today, event gone from today's sync: it moved or was cancelled (10-19: a 1-1 moved to a new
        // series and the old instance's card sat next to the real one). Past days' events are never re-synced,
        // so an earlier card without its event still folds.
        if (!ev && day >= today) {
          this.hub.expireQuestion(q.id, "event removed");
          continue;
        }
        if (day >= today) continue;
        this.hub.expireQuestion(q.id, "day moved on");
        stale.push({ title: ev?.title ?? q.prompt.replace(/ just ended\. Anything you committed to\?$/, ""), day, start: start.toISOString() });
      }
    }
    return stale;
  }

  private startedAgo(eventId: string, now: Date) {
    const ev: CalendarEvent | undefined = this.hub.todayEvents(now).find((e) => e.id === eventId);
    return ev ? now.getTime() - Date.parse(ev.start) : Infinity;
  }
}

export const coachKey = (c: Pick<Coaching, "date">) => `coach:${c.date}`;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * When to ask about the move. Day: an explicit MM-DD in `when` ("Tue 10-20"), else a weekday name
 * ("Thursday", "Monday") after the reflection's date, else the next workday after it ("tomorrow").
 * Time: the last HH:MM in `when` ("before the 10:30 interview" → 10:30, "09:30–09:45" → 09:45), else 09:30.
 */
export function coachDue(c: Pick<Coaching, "date" | "when">): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.date);
  if (!m) return undefined;
  const base = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  const when = c.when ?? "";
  const times = [...when.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)];
  const [h, min] = times.length ? [Number(times.at(-1)![1]), Number(times.at(-1)![2])] : [9, 30];
  let day: Date | undefined;
  // Strip times first so "09:30–09:45" can't read as a date.
  const md = /\b(\d{2})-(\d{2})\b/.exec(when.replace(/\b\d{1,2}:\d{2}\b/g, ""));
  if (md && Number(md[1]) >= 1 && Number(md[1]) <= 12) {
    day = new Date(base.getFullYear(), Number(md[1]) - 1, Number(md[2]), 12);
    if (day < base) day.setFullYear(day.getFullYear() + 1); // a December reflection about "01-04"
  } else {
    const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}`, "i").test(when.replace(/\btomorrow\b/gi, "")));
    day = new Date(base);
    do day.setDate(day.getDate() + 1);
    while (wd >= 0 ? day.getDay() !== wd : day.getDay() === 0 || day.getDay() === 6);
  }
  day.setHours(h, min, 0, 0);
  return day;
}

/** "Spend ten minutes on the two things only you can do": the move's first line, plain, first sentence. */
export function coachShort(move: string) {
  const first = move.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const s = plain(first.replace(/^(?:[-*]|\d+\.)\s+/, ""))
    .split(/(?<=[a-z0-9)\]])[.:]\s/i)[0]!
    .replace(/[.:]$/, "");
  return s.length > 140 ? s.slice(0, 140).replace(/\s+\S*$/, "") + "…" : s;
}

/** The card. Done / Not today only journal; "Hand to an agent" also makes an item for the move (Hub.applyEffect). */
export function coachQuestion(c: Pick<Coaching, "date" | "when" | "move">) {
  return {
    kind: "state" as const,
    badge: "M5 move",
    priority: 85,
    prompt: `M5 move: ${coachShort(c.move)}. Did it happen?`,
    context: `The ${c.date.slice(5)} reflection's one thing to try${c.when ? ` (${c.when})` : ""}:\n${c.move}\n\nYour answer goes to the journal, so tonight's reflection starts from what happened. Partly? Pick one and add a note.`,
    options: [
      opt("done", "Done", { type: "noop" }, "good"),
      opt("agent", "Hand to an agent", { type: "dispatch", action: "work", note: `The M5 "one thing to try" from the ${c.date} reflection. Do what an agent can (drafts, lookups, booking), and hand back what only the owner can send:\n${c.move}` }, "primary"),
      opt("not", "Not today", { type: "noop" }, "quiet"),
    ],
  };
}

/**
 * Today's meetings worth a prep brief, still to start: 1-1s and 2–4 person meetings you haven't declined, not
 * holds (0–1 attendees) or personal blocks (only you). Chronological.
 */
export function prepPicks(events: CalendarEvent[], now: Date): QuestionPick[] {
  return events
    .filter((ev) => {
      if (ev.response === "declined") return false;
      if (ev.attendees?.length && ev.attendees.every((a) => isOwner(a))) return false;
      const n = ev.attendees?.length ?? 0;
      return (ev.oneOnOne || (n >= 2 && n <= 4)) && Date.parse(ev.start) - now.getTime() > 2 * MIN;
    })
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((ev) => {
      const who = (ev.attendees ?? []).filter((a) => !isOwner(a)).map((a) => a.split("@")[0]!);
      return { id: ev.id, label: `${fmt(new Date(ev.start))} · ${ev.title}`, ...(who.length ? { hint: who.slice(0, 4).join(", ") } : {}) };
    });
}

/** The morning prep card. Card only, no desktop ping (priority < 80): 41 pings to 09-25..10-16, 37 expired. */
export function prepCard(picks: QuestionPick[]) {
  const n = picks.length;
  return {
    kind: "prep" as const,
    badge: "Today's prep",
    priority: 75,
    prompt: `${n} ${n === 1 ? "meeting" : "1-1s and small meetings"} today. Any worth a brief?`,
    // The list is in the context too, so a typed note ("prep Kevin and Kuba") reads against it.
    context: `Tick the ones to prep. Each sends an agent for a brief.\n${picks.map((p) => `- ${p.label}${p.hint ? ` (${p.hint})` : ""}`).join("\n")}`,
    picks,
    options: [
      opt("prep", "Prep the ticked ones", { type: "prepMeetings" }, "primary"),
      opt("no", "None today", { type: "noop" }, "quiet"),
    ],
  };
}

/** A meeting-ended card folded into the morning digest. `start` (ISO) orders the list; absent on older kv rows. */
type StaleMeeting = { title: string; day: string; start?: string };

/** The folded "earlier meetings" card. Titles live in the context so a typed note triages with them. */
export function reviewDigest(meetings: Array<{ title: string; day: string }>, now = new Date()) {
  const days = [...new Set(meetings.map((m) => m.day))].sort();
  const yesterday = localDate(new Date(now.getTime() - DAY));
  const when =
    days.length > 1 ? "Earlier meetings" : days[0] === yesterday ? "Yesterday's meetings" : `${new Date(`${days[0]}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long" })}'s meetings`;
  return {
    kind: "review" as const,
    priority: 70,
    prompt: `${when} (${meetings.length}): anything you committed to?`,
    context: meetings.map((m) => `- ${days.length > 1 ? `${m.day.slice(5)} · ` : ""}${m.title}`).join("\n"),
    options: [
      opt("scan", "Scan the transcripts now", { type: "sweep", name: "transcripts" }, "primary"),
      opt("none", "Nothing new", { type: "noop" }, "quiet"),
    ],
  };
}

/** What a review card's typed note goes to triage with: the question, plus the meeting list for a folded card. */
export function reviewUtterance(q: Pick<Question, "prompt" | "key" | "context">, note: string) {
  return [q.prompt, q.key.startsWith("reviews:") ? q.context : "", note].filter(Boolean).join("\n");
}

const PUSH_1H = "Push 1 hour";

/**
 * Should today's wrap-up be asked? `closed`: closed `wrap:<date>` questions, any order (the caller passes the 100
 * most recently closed; only the trailing run of ignored days matters). A day counts as answered when one of its
 * cards got a real answer: a bare "Ask me in an hour" whose follow-up then expired is still an ignored day, but a
 * snooze with typed text counts (deliberate: he wrote something, so he's reading the card). One ignored day is forgiven (busy,
 * OOO). Two in a row: wait 2 calendar days after the last card; three or more: 4 (a Thursday miss skips to Monday).
 * An answer resets it to daily. 10-26..10-30 every card expired unanswered; with this, that week asks 10-26, 10-27
 * and 10-29 only, and 11-02 (answered) still gets its card.
 */
export function wrapDue(closed: Pick<Question, "key" | "status" | "answer" | "options">[], today: string) {
  const days = new Map<string, boolean>();
  for (const q of closed) {
    const day = q.key.slice("wrap:".length);
    if (!q.key.startsWith("wrap:") || day >= today) continue;
    const snoozed = q.options.some((o) => o.effect.type === "snooze" && o.label === q.answer);
    days.set(day, (days.get(day) ?? false) || (q.status === "answered" && !snoozed));
  }
  const past = [...days].sort(([a], [b]) => b.localeCompare(a));
  let ignored = 0;
  while (ignored < past.length && !past[ignored]![1]) ignored++;
  if (ignored < 2) return true;
  const gap = ignored === 2 ? 2 : 4;
  return (Date.parse(today) - Date.parse(past[0]![0])) / DAY >= gap;
}

/** Next workday at 09:30: tomorrow, or Monday from Friday/the weekend. */
export function nextWorkMorning(now: Date) {
  const d = atLocal(9, 30, 1, now);
  while (!isWorkday(d)) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Options for an "It's time" prompt. After two "Push 1 hour" taps today the hour clearly isn't working:
 * lead with the next work morning and drop the hourly push.
 */
export function dueOptions(act: { action: ActionKind; label: string } | undefined, pushes: number, now: Date): QuestionOption[] {
  const tired = pushes >= 2;
  const morning = nextWorkMorning(now);
  const tomorrow = localDate(morning) === localDate(atLocal(12, 0, 1, now));
  const label = `${tomorrow ? "Tomorrow" : morning.toLocaleDateString("en-GB", { weekday: "short" })} 09:30`;
  return [
    ...(tired ? [opt("am", label, { type: "schedule", at: morning.toISOString(), label: label.toLowerCase() }, "primary")] : []),
    ...(act ? [opt("go", act.label, { type: "dispatch", action: act.action }, tired ? "quiet" : "primary")] : []),
    opt("doing", "I'm on it", { type: "status", status: "doing" }, act || tired ? "quiet" : "primary"),
    opt("done", "Already done", { type: "status", status: "done" }, "good"),
    ...(tired ? [] : [opt("1h", PUSH_1H, { type: "schedule", at: new Date(now.getTime() + 60 * MIN).toISOString(), inMin: 60, label: "in an hour" })]),
    WHEN_OPT,
  ];
}

/** A card that waits for a merge rather than asks for one: "When #137 merges, should an agent flip the var?"
 *  Only "merges / merged / lands…": "After review, merge #150?" asks for the merge, so its card can close. */
export function followsMerge(q: Pick<Question, "prompt">) {
  // Up to the end of the sentence: "!16" and "v1.2" don't end one, ". " and a final "?" do.
  return /\b(when|once|after|as soon as)\b(?:(?![.?!](?:\s|$)).)*?\b(merges|merged|lands|landed|ships|shipped|closes|closed)\b/i.test(q.prompt);
}

/** Work that comes after a merge. A card that asks for it isn't settled by the merge ("Merge and deploy #150?"). */
const FOLLOW_UP = /\b(deploy\w*|releas\w*|roll(?:s|ed|ing)?[ -]?out|back(?:[ -]\w+){0,2}?[ -]?out\b|backout\w*|rollout|roll(?:s|ed|ing)?(?:[ -]\w+){0,2}?[ -]?back\b|rollback\w*|ship\w*|cut[ -]?over\w*|enabl\w*|feature[ -]?flag\w*|revert\w*|rebas\w*|migrat\w*|prod|production|tag|publish\w*|flip\w*|announc\w*|notif\w*|backport\w*)\b/i;

/**
 * Is the merge all this card asks about? Every PR (#n), MR (!n) and ticket key it names must be one that landed,
 * and it asks for nothing that comes after. "Merge #151 too?" on an item whose #150 merged stays open.
 */
export function settledByLanding(q: Pick<Question, "prompt">, l: Landed) {
  if (FOLLOW_UP.test(q.prompt)) return false;
  const landed = new Set([
    ...(l.prs ?? []).map((r) => `#${r.number}`),
    ...l.mrs.map((r) => `!${r.iid}`),
    ...l.tickets.map((t) => t.ref.key.toUpperCase()),
  ]);
  // Case-insensitive and loose on purpose: "GPT-4" reads as a ticket and keeps the card, which is the safe miss.
  const named = [...q.prompt.matchAll(/[#!]\d+\b|\b[A-Z][A-Z0-9_]+-\d+\b/gi)].map((m) => m[0].toUpperCase());
  return named.every((r) => landed.has(r));
}

/** Everything the item links to has landed: MRs and PRs merged, tickets done. `at` is the latest of those dates. */
export interface Landed {
  mrs: MrRef[];
  mergedAt?: string;
  prs?: PrRef[];
  prMergedAt?: string;
  tickets: JiraDone[];
  at?: string;
}

/** "10-14" (local), or "" when GitLab / JIRA gave no date. */
const day = (iso?: string) => (iso ? ` ${localDate(new Date(iso)).slice(5)}` : "");

/** "Done (merged 10-14)", "Done (ticket closed 10-14)", "Done (all closed 10-15)". */
function mergedLabel(l: Landed) {
  const what = !l.tickets.length ? "merged" : l.mrs.length || l.prs?.length ? "all closed" : l.tickets.length > 1 ? "tickets closed" : "ticket closed";
  return `Done (${what}${day(l.at)})`;
}

/** "agent-relay-mcp!1 merged 10-14.", "PAY-12 Done 10-14.", "api-worker!17 merged 10-14; PAY-12 Done 10-15.", "agent-memory-mcp#19 merged 10-19." */
function mergedLine(l: Landed) {
  const parts: string[] = [];
  if (l.mrs.length) {
    const names = l.mrs.map((r) => `${r.project.split("/").pop()}!${r.iid}`).join(", ");
    parts.push(`${names} ${l.mrs.length > 1 ? "all merged" : "merged"}${day(l.mergedAt)}`);
  }
  if (l.prs?.length) {
    const names = l.prs.map((r) => `${r.repo}#${r.number}`).join(", ");
    parts.push(`${names} ${l.prs.length > 1 ? "all merged" : "merged"}${day(l.prMergedAt)}`);
  }
  for (const t of l.tickets) parts.push(`${t.ref.key} ${t.status}${day(t.doneAt)}`);
  return `${parts.join("; ")}.`;
}

/** What the refs on these items are: code (MRs / PRs) only, "jira" only, or "both". */
function refKinds(ls: Landed[]): "mr" | "jira" | "both" {
  const mr = ls.some((l) => l.mrs.length || l.prs?.length), jira = ls.some((l) => l.tickets.length);
  return mr && jira ? "both" : jira ? "jira" : "mr";
}

/** "MR", "PR", or "MR/PR": what to call the code refs on these items. */
function codeNoun(ls: Landed[]) {
  const mr = ls.some((l) => l.mrs.length), pr = ls.some((l) => l.prs?.length);
  return pr && !mr ? "PR" : pr ? "MR/PR" : "MR";
}

function landedBadge(ls: Landed[]) {
  return { mr: `${codeNoun(ls)} merged`, jira: "Ticket done", both: "Merged / done" }[refKinds(ls)];
}

/** Cards asked more than this many workdays ago stop counting against the total and go on the one stale card. */
export const STALE_WORKDAYS = 3;
const STALE_KEY = "stale";
const STALE_KEPT_KEY = "stale:kept";
const STALE_KEEP_LABEL = "Keep them";
/** At most one new stale card a day: closing some and leaving the rest shouldn't redraw it on the next tick. */
const STALE_COOLDOWN_MIN = 20 * 60;

/** The moment `n` workdays (Mon–Fri) before `now`, same time of day. */
export function workdaysAgo(n: number, now = new Date()) {
  const d = new Date(now);
  for (let left = n; left > 0; ) {
    d.setDate(d.getDate() - 1);
    if (isWorkday(d)) left--;
  }
  return d;
}

/** Cards asked before this (ms) are stale. */
export const staleBefore = (now: Date) => workdaysAgo(STALE_WORKDAYS, now).getTime();
const deferred = (q: Pick<Question, "notBefore">, now: Date) => Boolean(q.notBefore) && Date.parse(q.notBefore!) > now.getTime();
const isProposalCard = (q: Pick<Question, "key">) => q.key.startsWith("proposal:");
/** Older than STALE_WORKDAYS, and not a card with its own slots or the stale card itself. */
const isStale = (q: Pick<Question, "key" | "createdAt">, before: number) => q.key !== STALE_KEY && !isProposalCard(q) && Date.parse(q.createdAt) < before;

/** The stale card lists the oldest this many; the rest join as those close. */
const STALE_PICKS = 20;
const DAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** "N cards older than 3 workdays": tick the ones to close (the oldest STALE_PICKS). Pick id = question id. */
export function staleCard(cards: Array<Pick<Question, "id" | "prompt" | "badge" | "kind" | "createdAt">>) {
  const n = cards.length;
  const shown = cards.slice(0, STALE_PICKS);
  const day = (iso: string) => DAY_FMT.format(new Date(iso));
  const picks: QuestionPick[] = shown.map((q) => ({ id: q.id, label: excerpt(plain(q.prompt), 120) ?? q.prompt, hint: `${q.badge ?? q.kind} · asked ${day(q.createdAt)}` }));
  return {
    kind: "state" as const,
    badge: "Stale cards",
    priority: 40,
    prompt: n === 1 ? `1 card older than ${STALE_WORKDAYS} workdays: close it or keep it?` : `${n} cards older than ${STALE_WORKDAYS} workdays: close or keep?`,
    context: `They no longer count against the card limit. Close the ones that don't matter any more. Kept cards stay open and don't come back here.${n > shown.length ? ` Showing the oldest ${shown.length}; the rest join as these go (Keep keeps these ${shown.length}).` : ""}`,
    picks,
    options: [
      opt("close", "Close ticked", { type: "closePicks" }, "primary"),
      opt("all", n === 1 ? "Close it" : n > shown.length ? `Close these ${shown.length}` : `Close all ${n}`, { type: "closePicks", all: true }, "danger"),
      opt("keep", STALE_KEEP_LABEL, { type: "noop" }, "quiet"),
    ] satisfies QuestionOption[],
  };
}

const MERGED_KEY = "wait:merged";
/** The "Recheck" card (Prompter.recheck): every open item whose links all landed, any lane, tick the done ones. */
const RECHECK_KEY = "recheck";
const KEPT_KEY = "wait:merged:kept";
const KEEP_LABEL = "Keep waiting";
const SPLIT_LABEL = "One by one";
/** Once a day, give or take: a card answered at 09:40 can come back the next morning. */
const MERGED_COOLDOWN_MIN = 20 * 60;

/** Item ids on a merged-MRs card, read back from its "mark all done" option. */
function mergedIds(q: Question | undefined): string[] {
  const e = q?.options.find((o) => o.id === "done")?.effect;
  return e?.type === "multi" ? e.effects.flatMap((x) => (x.type === "status" && x.itemId ? [x.itemId] : [])) : [];
}

/** The batched card: titles and MR / ticket lines in the context, one tap closes them all. */
export function mergedCard(found: Array<{ it: Pick<Item, "id" | "title">; mr: Landed }>) {
  const n = found.length;
  const kinds = refKinds(found.map((f) => f.mr));
  const code = `${codeNoun(found.map((f) => f.mr))}s`;
  const one = { mr: `its ${code} merged`, jira: "its tickets are done", both: `its ${code} merged and tickets closed` }[kinds];
  const many = { mr: `their ${code} merged`, jira: "their tickets are done", both: `their ${code} merged or tickets closed` }[kinds];
  const each = (status: "done" | "waiting", note: (mr: Landed) => string): QuestionOption["effect"] => ({
    type: "multi",
    effects: found.map((f) => ({ type: "status", status, itemId: f.it.id, note: note(f.mr) })),
  });
  return {
    // One item: the card is that item's card, so a typed note ("chase Omar") acts on it. Several: no item, and
    // applyNote says so instead of filing the note as context (10-22: "Sending an agent", nothing started, twice).
    // Explicit undefined so Object.assign clears it when a one-item card grows.
    itemId: n === 1 ? found[0]!.it.id : undefined,
    badge: landedBadge(found.map((f) => f.mr)),
    priority: 55,
    prompt: n === 1 ? `Waiting on this, but ${one}: ${found[0]!.it.title}` : `${n} waiting items: ${many}. Mark all done?`,
    context: found.map((f) => `- ${f.it.title} — ${mergedLine(f.mr)}`).join("\n"),
    options: [
      opt("done", n === 1 ? mergedLabel(found[0]!.mr) : `Mark all ${n} done`, each("done", mergedLine), "primary"),
      ...(n > 1 ? [opt("split", SPLIT_LABEL, { type: "noop" })] : []),
      opt("keep", n > 1 ? `${KEEP_LABEL} on all` : KEEP_LABEL, each("waiting", (mr) => `kept waiting: ${mergedLine(mr)}`), "quiet"),
    ],
  };
}

export interface RecheckResult {
  checked: number;
  landed: Array<{ id: string; title: string; status: Item["status"]; line: string }>;
  failed: number;
  question?: string;
}

/** What the recheck card's "Check for me" agent is for. Hub.dispatchPicks appends the items. */
export const RECHECK_VERIFY_NOTE =
  "Everything these items link to has merged or closed. For each one, find out if anything is still left after the merge (a deploy, a rollout, a check, a reply). Don't set any status yourself, even when the evidence is clear: propose it. Propose \"Mark done\" (a question per item) for the ones with nothing left; for the rest, say what's left and who has it.";

/** The recheck card: one tick-box per landed item (pick id = item id), nothing pre-ticked. */
export function recheckCard(found: Array<{ it: Pick<Item, "id" | "title" | "status">; l: Landed }>) {
  const n = found.length;
  const picks: QuestionPick[] = found.map((f) => ({ id: f.it.id, label: f.it.title, hint: `${f.it.status} · ${mergedLine(f.l)}` }));
  return {
    kind: "state" as const,
    key: RECHECK_KEY,
    badge: "Recheck",
    priority: 70,
    prompt: n === 1 ? `Everything this links to has landed: ${found[0]!.it.title}. Done?` : `${n} open items: everything they link to has landed. Which are done?`,
    // The list is in the context too, so a typed note ("all but the deploy one") reads against it.
    context: `Tick the done ones. Some ask for what comes after the merge (a deploy, a check).\n${picks.map((p) => `- ${p.label} (${p.hint})`).join("\n")}`,
    picks,
    options: [
      opt("done", "Mark ticked done", { type: "donePicks" }, "primary"),
      opt("all", n === 1 ? mergedLabel(found[0]!.l) : `Mark all ${n} done`, { type: "donePicks", all: true }),
      // 10-27: "check them all yourself" on this card was parked for a week: it had no agent to send.
      // One verify job across the ticked items (all of them if none), see Hub.dispatchPicks.
      { ...opt("check", "Check for me", { type: "dispatch", action: "verify", note: RECHECK_VERIFY_NOTE }), hint: "One agent checks what's left after each merge" },
      opt("keep", "Leave them", { type: "noop" }, "quiet"),
    ],
  };
}

function opt(id: string, label: string, effect: QuestionOption["effect"], tone?: QuestionOption["tone"]): QuestionOption {
  return { id, label, effect, tone };
}

/** Memory's own ordering: Immediate first, delegated last. */
function rank(i: Item) {
  const l = i.source.label ?? "";
  return /Immediate/.test(l) ? 0 : /Delegated/.test(l) ? 2 : 1;
}

function excerpt(s?: string, n = 320) {
  if (!s) return undefined;
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s;
}

function hasDraft(i: Item) {
  return Boolean(i.post?.wikiDraft || i.post?.siteDraft);
}


type PropLike = { proposalOf?: string; source: { label?: string } };

/** The proposal's section label: its own source, or the proposal that merged into it. */
function propLabel(i: PropLike): string {
  return i.proposalOf ?? i.source.label ?? "";
}

/** "From the 2026-10-19 reflection." or, for learn-skill proposals, "From /learn after a pi session (2026-10-21)." */
function propSource(i: PropLike): string {
  const [head, section = ""] = propLabel(i).replace(/^Proposals /, "").split(" · ");
  return section.startsWith("Learn") ? `From /learn after a pi session (${head}).` : `From the ${head} reflection.`;
}

function propDate(i: PropLike): string {
  return /\d{4}-\d{2}-\d{2}/.exec(propLabel(i))?.[0] ?? "";
}

/** "Proposals 2026-10-18 · High Priority (…)" → 0; Medium → 1; Low → 2; anything else → 3. */
function propRank(i: PropLike): number {
  const section = propLabel(i).split(" · ")[1] ?? "";
  const r = ["high", "medium", "low"].findIndex((w) => section.toLowerCase().startsWith(w));
  return r < 0 ? 3 : r;
}
