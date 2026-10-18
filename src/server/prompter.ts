// The proactive part. Every tick, look at items + calendar + clock and decide
// what to ask. Rules are deliberately boring and deterministic — the AI does
// extraction and verification; *when to interrupt* stays predictable.

import type { ActionKind, CalendarEvent, Item, Question, QuestionOption } from "../shared/types.ts";
import { config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { localDate } from "./memory-sync.ts";
import { openUrl } from "./prompts.ts";

const MIN = 60_000;
const DAY = 86_400_000;

/** Caps so the app asks, rather than nags. */
const CAP = { state: 3, kill: 3, proposal: 2, post: 2, inbox: 6, waiting: 2, total: 14 };

const nameTokens = (s: string) => s.toLowerCase().split("@")[0]!.split(/[\s._-]+/).filter(Boolean);

/** True if an attendee ("alex@x.com", "alex.owner@gmail.com", "Alex Owner") is the owner (config.owner.aliases). */
export function isOwner(attendee: string, aliases: string[] = config.owner.aliases) {
  const who = nameTokens(attendee);
  return aliases.some((a) => {
    const t = nameTokens(a);
    return t.length > 0 && t.every((w, i) => who[i] === w);
  });
}

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
  constructor(private hub: Hub) {}

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

    // 1. Scheduled items that are due. Always ask — these are promises.
    for (const it of items) {
      if (it.status !== "scheduled" || !it.scheduledFor || Date.parse(it.scheduledFor) > now.getTime()) continue;
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
            opt("scan", "Scan the transcript now", { type: "noop" }, "primary"),
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
        context: "Pick from what memory thinks is live. Everything else stays proposed.",
        options: [
          opt("plan", "Commit to these", { type: "noop" }, "primary"),
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
          opt("flush", "That's the truth — save it", { type: "noop" }, "primary"),
          opt("later", "Ask me in an hour", { type: "snooze", minutes: 60 }, "quiet"),
        ],
      });
    }

    if (budget <= 0) return;

    // 5. Inbox triage — captured but nobody's decided what it is.
    const inbox = items
      .filter((i) => i.status === "inbox")
      .sort((a, b) => Number(b.signals?.pineapple ?? 0) - Number(a.signals?.pineapple ?? 0));
    // Items an agent is already working on (verify leaves them in inbox): don't re-ask and re-dispatch.
    const busy = new Set(store.liveJobs().map((j) => j.itemId).filter(Boolean));
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
      if (
        this.ask({
          kind: "state",
          itemId: it.id,
          key: `state:${it.id}`,
          priority: 60,
          prompt: it.title,
          context: `Memory doesn't know where this stands.${it.detail ? ` ${excerpt(it.detail)}` : ""}`,
          options: [
            opt("done", "Done", { type: "status", status: "done" }, "good"),
            opt("today", "Doing it today", { type: "status", status: "today" }, "primary"),
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
      .filter((i) => i.kind === "idea" && i.status === "proposed" && i.source.label?.startsWith("Proposals"))
      .sort((a, b) => propDate(b).localeCompare(propDate(a))); // newest reflection first, file order within a day
    for (const it of proposals) {
      if (budget <= 0 || openCount("dispatch") >= CAP.proposal) break;
      if (
        this.ask({
          kind: "dispatch",
          itemId: it.id,
          key: `proposal:${it.id}`,
          priority: 45,
          prompt: it.title,
          context: `From the ${it.source.label?.replace(/^Proposals /, "").split(" · ")[0] ?? ""} reflection. ${excerpt(it.detail) ?? ""}`,
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

    // 9. Waiting too long.
    for (const it of items.filter((i) => i.status === "waiting" && now.getTime() - Date.parse(i.updatedAt) > 3 * DAY)) {
      if (budget <= 0 || openCount("state", (q) => q.key.startsWith("wait:")) >= CAP.waiting) break;
      if (
        this.ask({
          kind: "state",
          itemId: it.id,
          key: `wait:${it.id}`,
          badge: "Still waiting",
          priority: 50,
          prompt: it.title,
          context: `You've been waiting on this for ${Math.round((now.getTime() - Date.parse(it.updatedAt)) / DAY)} days.`,
          options: [
            opt("chase", "Chase them", { type: "dispatch", action: "reply" }, "primary"),
            opt("done", "Resolved", { type: "status", status: "done" }, "good"),
            opt("keep", "Keep waiting", { type: "status", status: "waiting" }),
            WHEN_OPT,
          ],
          cooldownMin: 2 * 24 * 60,
        })
      )
        budget--;
    }

    // 10. Blog posts — drafts to review first, then bare ideas. Low priority, never nags.
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
      opt("scan", "Scan the transcripts now", { type: "noop" }, "primary"),
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


function propDate(i: { source: { label?: string } }): string {
  return /\d{4}-\d{2}-\d{2}/.exec(i.source.label ?? "")?.[0] ?? "";
}
