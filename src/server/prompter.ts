// The proactive part. Every tick, look at items + calendar + clock and decide
// what to ask. Rules are deliberately boring and deterministic — the AI does
// extraction and verification; *when to interrupt* stays predictable.

import type { ActionKind, CalendarEvent, Coaching, Item, Job, Question, QuestionOption } from "../shared/types.ts";
import { config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { localDate } from "./memory-sync.ts";
import { type JiraDone, JiraStates } from "./jira-state.ts";
import { type MrRef, MrStates, mrRefs } from "./mr-state.ts";
import { plain } from "./parse.ts";
import { type PrRef, PrStates, prRefs } from "./pr-state.ts";
import { openUrl } from "./prompts.ts";

const MIN = 60_000;
const DAY = 86_400_000;

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

/**
 * Milliseconds of work time between `from` and `to`: weekdays, inside `hours` ([start, end) local, may be fractional).
 * "4 work hours" set at 17:00 Friday means 13:00 Monday, not 21:00 Friday.
 */
export function workMsBetween(from: Date, to: Date, hours: [number, number] = config.sweeps.workHours) {
  let total = 0;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (; day < to; day.setDate(day.getDate() + 1)) {
    if (day.getDay() === 0 || day.getDay() === 6) continue;
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
    const at = [mr?.mergedAt ?? "", pr?.mergedAt ?? "", ...tickets.map((t) => t.doneAt ?? "")].sort().pop() || undefined;
    return { mrs: mr?.refs ?? [], mergedAt: mr?.mergedAt, prs: pr?.refs ?? [], prMergedAt: pr?.mergedAt, tickets, at };
  }

  tick(now = new Date()) {
    const store = this.hub.store;
    const items = store.items();
    const open = (this.open = store.questions("open"));
    const openCount = (kind: Question["kind"], pred: (q: Question) => boolean = () => true) =>
      open.filter((q) => q.kind === kind && pred(q)).length;
    // Deferred questions (notBefore later) don't count against the total: they aren't nagging anyone.
    // Per-kind caps still count them, so "skip all posts till Thu" also stops new post questions.
    let budget = CAP.total - open.filter((q) => !q.notBefore || Date.parse(q.notBefore) <= now.getTime()).length;

    const stale = this.expireMoot(open, items, now);
    this.foldReviews(stale, now);

    const hour = now.getHours() + now.getMinutes() / 60;
    const [dayStart, dayEnd] = config.sweeps.workHours;
    const workday = now.getDay() !== 0 && now.getDay() !== 6;
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
      const act = ACTION_FOR[it.kind];
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

    // 2. Meetings: prep before, capture after.
    for (const ev of this.hub.todayEvents(now)) {
      if (ev.response === "declined") continue;
      // Only you on the invite (e.g. a personal block mirrored from a personal address): not a meeting.
      if (ev.attendees?.length && ev.attendees.every((a) => isOwner(a))) continue;
      const start = Date.parse(ev.start);
      const end = Date.parse(ev.end);
      const n = ev.attendees?.length ?? 0;
      const small = ev.oneOnOne || (n >= 2 && n <= 4); // 0–1 attendees = a hold, not a meeting
      if (small && start - now.getTime() <= 20 * MIN && start - now.getTime() > 2 * MIN) {
        this.ask(
          {
            kind: "prep",
            eventId: ev.id,
            key: `prep:${ev.id}`,
            once: true,
            // Card only, no desktop ping: 41 pings to 09-25..10-16, 37 expired untouched (10-17 reflection).
            priority: 75,
            prompt: `${ev.title} in ${Math.round((start - now.getTime()) / MIN)} min. Want a brief?`,
            context: ev.attendees?.length ? `With ${ev.attendees.slice(0, 5).join(", ")}` : undefined,
            options: [
              opt("prep", "Prep a brief", { type: "dispatch", action: "prep" }, "primary"),
              opt("no", "I'm good", { type: "noop" }, "quiet"),
            ],
          },
        );
      }
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
          context: "Type or say it below — it goes straight to triage. Meeting notes get scanned on the next sweep either way.",
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

    // 4. Wrap-up, once per workday, 90 min before the end of the day.
    if (workday && hour >= dayEnd - 1.5 && hour < dayEnd + 3) {
      this.ask({
        kind: "wrap",
        key: `wrap:${today}`,
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
      const act = it.signals?.pineapple && !["message", "email"].includes(it.kind) ? ACTION_FOR.ticket : ACTION_FOR[it.kind];
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

    // 8. Reflection proposals — the ones that never turn into anything.
    const proposals = items
      // A proposal merged into an existing item (proposalOf) counts too, whatever that item's kind or source.
      .filter((i) => i.status === "proposed" && (i.proposalOf || (i.kind === "idea" && i.source.label?.startsWith("Proposals"))))
      // Newest reflection first; within it High Priority before Medium/Low, then file order. createdAt is the
      // file order. memory sync writes rows top to bottom, so `updated` creeps up in file order, and store.items() is
      // ORDER BY updated DESC: without a tiebreak a day's proposals came out last-first (10-18: #9 and #8 asked, #1 never).
      .sort((a, b) => propDate(b).localeCompare(propDate(a)) || propRank(a) - propRank(b) || a.createdAt.localeCompare(b.createdAt));
    for (const it of proposals) {
      if (budget <= 0 || openCount("dispatch") >= CAP.proposal) break;
      if (
        this.ask({
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
            opt("chase", "Chase them", { type: "dispatch", action: "reply" }, mr ? "quiet" : "primary"),
            ...(mr ? [] : [opt("done", "Resolved", { type: "status", status: "done" }, "good")]),
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
      if (last?.answeredAt && now.getTime() - Date.parse(last.answeredAt) < MERGED_COOLDOWN_MIN * MIN) return { asked: false, ids: new Set() };
    }
    const found: Array<{ it: Item; mr: Landed }> = [];
    let pending = false;
    for (const it of items) {
      if (it.status !== "waiting") continue;
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
      else if (mergedIds(prev).join() !== [...ids].join()) {
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
    let saved: { kept: Record<string, string>; split: Record<string, string>; seen?: string } = { kept: {}, split: {} };
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
    return saved;
  }

  /** "Push 1 hour" taps since local midnight on this item's due prompts (any slot). */
  private pushesToday(itemId: string, now: Date) {
    const since = atLocal(0, 0, 0, now).toISOString();
    return this.hub.store.answeredByPrefix(`due:${itemId}:`, since).filter((q) => q.answer?.startsWith(PUSH_1H)).length;
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
      else if (q.kind === "confirm" && it && it.status !== "inbox") this.hub.expireQuestion(q.id, "triaged");
      else if (q.kind === "post" && it && q.key.endsWith(":idea") && hasDraft(it)) this.hub.expireQuestion(q.id, "drafted");
      else if (q.kind === "prep" && q.eventId && this.startedAgo(q.eventId, now) > 10 * MIN) this.hub.expireQuestion(q.id, "meeting started");
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

/** Next workday at 09:30: tomorrow, or Monday from Friday/the weekend. */
export function nextWorkMorning(now: Date) {
  const d = atLocal(9, 30, 1, now);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
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

const MERGED_KEY = "wait:merged";
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
