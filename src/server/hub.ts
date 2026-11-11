// The hub owns state transitions. Everything that changes an item, a question
// or the journal goes through here so the UI stays in sync and every human
// decision lands in the journal (and from there, in memory).

import type {
  ActionKind, AgentReport, AwayBlock, CalendarEvent, Effect, Item, ItemKind, ItemStatus, Job, JournalEntry, NoteDecision, Question,
  QuestionOption, ServerEvent, Snapshot, SyncState, Coaching, CoachOutcome,
} from "../shared/types.ts";
import { type BulkRequest, deckGroup, deferHorizon, localDay, optionFor, setsStatus } from "../shared/batch.ts";
import { affirms, claimsDispatch, deadOptions, promisesAction, stallsOptions } from "../shared/dead-button.ts";
import { AGENT_ASKS, isAgentCard } from "../shared/boss.ts";
import { asksForIdeas, IDEA_CAP } from "../shared/ideas.ts";
import { config, memoryOn } from "./config.ts";
import { newId, nowIso, type Store } from "./db.ts";
import { findTwin, isOpen } from "./dedupe.ts";
import { LoadLog, loadNow } from "./load.ts";
import { stoppedJobNote } from "./prompts.ts";
import { pruneReviews } from "./review-fold.ts";
import { foldRest } from "./stopped-fold.ts";

type Listener = (e: ServerEvent) => void;

/** A Cloudflare Access app origin `cloudflared access login` may be run against: https and a bare host, nothing to inject. */
export const ACCESS_APP = /^https:\/\/[a-z0-9.-]+\/?$/i;
const ACCESS_LATER = "Later";
/** An item's own state cards (prompter; when-retry: from Agents.scheduleFromWords): closed once an agent is sent on it (closeStateCards). */
const STATE_CARD = /^(wait|state|inbox|kill|due|when-retry|doing|proposal):/;

export interface Dispatcher {
  /** `decision`: the one answer that sent this job ("<question> → <option>"); the prompt scopes the job to it. */
  dispatch(itemId: string, action: import("../shared/types.ts").ActionKind, note?: string, decision?: string): Promise<Job | undefined>;
  scheduleFromWords(itemId: string, words: string): Promise<void>;
  /** Read a typed note against the question it was typed on. Throws if the read failed; undefined = question gone. */
  readNote?(questionId: string, text: string): Promise<NoteDecision | undefined>;
  gatewayLogin?(app: string): Promise<void>;
  accessLogin?(app: string): Promise<void>;
  triage?(text: string, mode: "chat" | "review"): Promise<unknown>;
  sweep?(name: "transcripts" | "calendar", opts?: { since?: string }): Promise<unknown>;
  /** Focus a job's cmux workspace. */
  focus?(jobId: string): unknown;
}

/** Context an effect needs from the tap beyond the note: the plan card's picked items, the prep card's ticked meetings. */
export interface AnswerContext {
  itemIds?: string[];
  picks?: string[];
}

export class Hub {
  private listeners = new Set<Listener>();
  /** Cards whose typed note the note reader is reading now (note()): reads in flight, and a close held until they end. */
  private reading = new Map<string, { n: number; close?: string }>();
  dispatcher?: Dispatcher;
  /** Writes the journal to memory (MemorySync; wired in index.ts). */
  journalFlusher?: () => Promise<unknown>;

  /** Load average once a minute (src/server/load.ts), in the store so a restart keeps the history. */
  readonly load: LoadLog;

  constructor(readonly store: Store) {
    this.load = new LoadLog(store);
  }

  /** Take a load sample (scheduler, every minute) and push it to the Agents panel. */
  sampleLoad(jobs: number) {
    const data = loadNow(this.load.record(jobs), config.pi.maxLoad);
    this.emit({ type: "load", data });
    return data;
  }

  // ── pub/sub ────────────────────────────────────────────────────────────
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(e: ServerEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {}
    }
  }
  toast(text: string, tone: "good" | "warn" | "info" = "info") {
    this.emit({ type: "toast", data: { text, tone } });
  }

  snapshot(): Snapshot {
    const cutoff = Date.now() - 3 * 86400_000;
    return {
      items: this.store.items().filter((i) => !(["done", "dropped"].includes(i.status) && Date.parse(i.updatedAt) < cutoff)),
      questions: this.store.questions("open"),
      jobs: this.store.jobs(40),
      events: this.todayEvents(),
      upcoming: this.upcomingEvents(),
      journal: this.store.journal(120),
      sync: this.store.syncStates(),
      coaching: this.coaching(),
      load: ((s) => (s ? loadNow(s, config.pi.maxLoad) : undefined))(this.load.latest()),
      config: {
        port: config.port,
        demo: config.demo,
        liveUrl: config.demo ? config.liveUrl : undefined,
        cmux: Boolean(config.cmux.bin),
        memory: memoryOn(),
        model: config.pi.model || "pi default",
        workHours: config.sweeps.workHours,
        owner: { name: config.owner.name, aliases: config.owner.aliases, speechLang: config.owner.speechLang },
        journalPath: config.memory.journalPath,
        labels: { tracker: config.labels.tracker, chat: config.labels.chat, wiki: config.writing.wiki.name, site: config.writing.site.name, trackerUrl: config.labels.trackerUrl || undefined },
      },
    };
  }

  /** After today, up to the furthest defer target. */
  upcomingEvents(now = new Date()): CalendarEvent[] {
    const today = localDay(now);
    const last = deferHorizon(now);
    return this.store.events().filter((e) => {
      const d = localDay(new Date(e.start));
      return d > today && d <= last;
    });
  }

  todayEvents(now = new Date()): CalendarEvent[] {
    const day = now.toDateString();
    return this.store.events().filter((e) => new Date(e.start).toDateString() === day);
  }

  // ── items ──────────────────────────────────────────────────────────────
  createItem(input: Partial<Item> & { title: string }): Item {
    // Dedupe on source key: re-imports and repeated agent reports update in place.
    const existing = input.source?.key ? this.store.itemBySourceKey(input.source.key) : undefined;
    if (existing) {
      // Reached through a merged key: the item has its own source and wording. Only add what's new.
      if (input.source?.key && existing.source.key && existing.source.key !== input.source.key) return this.absorb(existing, input);
      return this.updateItem(existing.id, input, { quiet: true });
    }
    const twin = findTwin(input.title, input.source?.type, this.store.items());
    if (twin) {
      if (input.source?.key) this.store.aliasKey(input.source.key, twin.id);
      this.journal(
        isOpen(twin)
          ? `Merged duplicate from ${input.source?.type ?? "?"}: “${input.title.trim()}” → ${twin.title}`
          : `Not re-adding “${input.title.trim()}” (${input.source?.type ?? "?"}): you closed it as “${twin.title}” (${twin.status} ${twin.updatedAt.slice(5, 10)})`,
        { itemId: twin.id, who: "hq" },
      );
      return this.absorb(twin, input);
    }
    const now = nowIso();
    const item: Item = {
      id: newId("it"),
      kind: (input.kind ?? "task") as ItemKind,
      status: input.status ?? "inbox",
      title: input.title.trim(),
      detail: input.detail,
      project: input.project,
      people: input.people,
      source: input.source ?? { type: "manual" },
      scheduledFor: input.scheduledFor,
      when: input.when,
      links: input.links,
      confidence: input.confidence,
      signals: input.signals,
      post: input.post,
      confirmedAt: input.confirmedAt,
      createdAt: now,
      updatedAt: now,
    };
    this.store.putItem(item);
    this.emit({ type: "item", data: item });
    return item;
  }

  /** Fold a duplicate's extra facts (links, people) into an item without touching its title or status. */
  private absorb(item: Item, input: Partial<Item>): Item {
    const links = [...new Set([...(item.links ?? []), ...(input.links ?? []), ...(input.source?.url ? [input.source.url] : [])])];
    const people = [...new Set([...(item.people ?? []), ...(input.people ?? [])])];
    if (links.length === (item.links?.length ?? 0) && people.length === (item.people?.length ?? 0)) return item;
    return this.updateItem(item.id, { links: links.length ? links : undefined, people: people.length ? people : undefined }, { quiet: true });
  }

  /**
   * Merge duplicates that already exist (from before this check, or two sources racing).
   * Keeps the one the owner touched (else the older), drops the other as a duplicate, and
   * points the dropped one's key at the keeper so it can't come back.
   */
  dedupeExisting(now = Date.now()) {
    const all = this.store.items();
    const open = all.filter((i) => isOpen(i) && !i.confirmedAt);
    let merged = 0;
    for (const dup of open) {
      const cur = this.store.item(dup.id);
      if (!cur || !isOpen(cur)) continue;
      const others = this.store.items().filter((i) => i.id !== dup.id);
      const twin = findTwin(cur.title, cur.source.type, others, now);
      if (!twin) continue;
      // Two unconfirmed open ones: keep the older.
      if (isOpen(twin) && !twin.confirmedAt && (cur.createdAt < twin.createdAt || (cur.createdAt === twin.createdAt && cur.id < twin.id))) continue;
      if (cur.source.key) this.store.aliasKey(cur.source.key, twin.id);
      for (const k of this.store.aliasesFor(cur.id)) this.store.aliasKey(k, twin.id);
      this.absorb(twin, cur);
      this.updateItem(cur.id, { status: "dropped" });
      this.closeQuestionsFor(cur.id, "duplicate");
      this.journal(`Merged duplicate: “${cur.title}” → ${twin.title}${isOpen(twin) ? "" : ` (you ${twin.status === "done" ? "finished" : "dropped"} it ${twin.updatedAt.slice(5, 10)})`}`, { itemId: twin.id, who: "hq" });
      merged++;
    }
    return merged;
  }

  updateItem(id: string, patch: Partial<Item>, opts: { quiet?: boolean } = {}): Item {
    const cur = this.store.item(id);
    if (!cur) throw new Error(`no item ${id}`);
    const next: Item = {
      ...cur,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      id: cur.id,
      status: quietStatus(cur, patch.status, opts.quiet),
      // An item keeps its own source key; other keys that reach it are aliases (Store.aliasKey).
      source: { ...cur.source, ...(patch.source ?? {}), key: cur.source.key ?? patch.source?.key },
      createdAt: cur.createdAt,
      updatedAt: nowIso(),
    };
    // checkClosed belongs to the close it was stamped with: any later status call (even a same-status settle) ends it.
    if (!patch.checkClosed && (next.status !== cur.status || (!opts.quiet && patch.status !== undefined))) delete next.checkClosed;
    this.store.putItem(next);
    this.emit({ type: "item", data: next });
    // A handed-off coaching move's outcome follows its item (coachHistory): re-send the panel when it changes.
    if (next.status !== cur.status && next.source.key?.startsWith("coach:move:")) {
      const c = this.coaching();
      if (c) this.emit({ type: "coaching", data: c });
    }
    return next;
  }

  /** A status change + journal line. `who` is who decided (the journal reads `you` as the owner's own words);
   *  `confirm` stamps confirmedAt (defaults to who === "you"; false leaves any earlier stamp alone). `extra` goes in
   *  the same write (Checks.run stamps checkClosed this way). */
  setStatus(id: string, status: ItemStatus, note?: string, who: JournalEntry["who"] = "you", confirm = who === "you", extra: Partial<Item> = {}) {
    const item = this.updateItem(id, { ...extra, status, confirmedAt: confirm ? nowIso() : undefined });
    this.journal(`${label(status)}: ${item.title}${note ? ` — ${note}` : ""}`, { itemId: id, who });
    // Anything open about this item is now moot.
    if (["done", "dropped"].includes(status)) this.closeQuestionsFor(id, `item ${status}`);
    return item;
  }

  /**
   * PATCH /api/items/:id. `who: "agent"` in the body marks a change an agent made over the API outside a job
   * (a nightly reflection dropping a killed item with curl, an agent jotting context): its journal lines and notes read `agent`, not
   * `you`, and a note stays context instead of going to the note reader (an agent's "check the logs" isn't the
   * owner's instruction). Attribution only: confirmedAt is still stamped, as before, so a quiet memory re-import
   * can't revive an item an agent dropped (updateItem). Absent or "you" = the drawer, unchanged.
   * 10-26 proposals: agent notes and drops journalled as `you`, so the digest counted them as the owner's typed notes.
   */
  async patchItem(
    id: string,
    b: { status?: ItemStatus; note?: string; who?: string | null; title?: string; detail?: string; kind?: Item["kind"]; project?: string },
  ): Promise<Item> {
    const { status, note, who: rawWho, ...rest } = b;
    if (rawWho != null && rawWho !== "you" && rawWho !== "agent") throw new Error(`who must be "you" or "agent", not ${JSON.stringify(String(rawWho).slice(0, 40))}`);
    const who = rawWho === "agent" ? "agent" : "you";
    let item = this.store.item(id);
    if (!item) throw new Error("no such item");
    if (Object.keys(rest).length) {
      item = this.updateItem(item.id, { ...rest, confirmedAt: nowIso() });
      this.journal(`Corrected: ${item.title}${rest.kind ? ` (now a ${rest.kind})` : ""}`, { itemId: item.id, who });
    }
    if (status) {
      if (note?.trim()) item = this.updateItem(item.id, { notes: appendNote(item, note.trim(), who === "agent" ? "agent" : undefined) });
      return this.setStatus(item.id, status, note, who, true);
    }
    // No status: an owner's instruction goes to the note reader like a card note; background stays on the item.
    if (note?.trim()) await this.itemNote(item.id, note, who);
    return this.store.item(item.id) ?? item;
  }

  schedule(id: string, at: string, labelText: string, who: JournalEntry["who"] = "you") {
    const item = this.updateItem(id, { status: "scheduled", scheduledFor: at, when: labelText, confirmedAt: nowIso() });
    this.journal(`Scheduled ${labelText}: ${item.title}`, { itemId: id, who });
    return item;
  }

  // ── questions ──────────────────────────────────────────────────────────
  /**
   * Ask once per key while open. `cooldownMin` also holds it back after an answer;
   * `once` means never ask this key again after it was answered or expired
   * (per-day / per-event keys like `wrap:<date>`, `plan:<date>`, `prep:<event>`).
   */
  ask(q: Omit<Question, "id" | "status" | "createdAt"> & { cooldownMin?: number; once?: boolean }): Question | undefined {
    if (this.store.openQuestionByKey(q.key)) return undefined;
    if (q.once && this.store.lastAnswered(q.key)) return undefined;
    if (q.cooldownMin) {
      const last = this.store.lastAnswered(q.key);
      if (last?.answeredAt && Date.now() - Date.parse(last.answeredAt) < q.cooldownMin * 60_000) return undefined;
    }
    const { cooldownMin: _c, once: _o, ...rest } = q;
    const question: Question = { ...rest, id: newId("q"), status: "open", createdAt: nowIso() };
    this.store.putQuestion(question);
    this.emit({ type: "question", data: question });
    this.flagDeadButtons(question);
    return question;
  }

  /**
   * "Yes, dispatch" that does nothing: say so when it's asked, not after someone taps it
   * (10-13..10-17 three taps were silently dropped). Warn only — the card still shows.
   * The journal is a log nobody reads live, so toast too: the card and the warning land together.
   */
  private flagDeadButtons(q: Question) {
    const dead = deadOptions(q);
    if (!dead.length) return;
    const labels = dead.map((o) => `“${o.label}”`).join(", ");
    console.warn(`[work-hq] dead button on ${q.key}: ${labels} has a noop effect`);
    this.journal(`Dead button: ${labels} on “${q.prompt.slice(0, 120)}” does nothing when tapped (${q.key})`, { itemId: q.itemId, questionId: q.id, who: "hq" });
    this.toast(`Dead button: ${labels} on the new card does nothing when tapped. Answer it another way.`, "warn");
  }

  closeQuestionsFor(itemId: string, reason: string) {
    for (const q of this.store.questions("open").filter((q) => q.itemId === itemId)) {
      q.status = "expired";
      q.answer = reason;
      q.answeredAt = nowIso();
      this.store.putQuestion(q);
      this.emit({ type: "question", data: q });
    }
  }

  /**
   * An agent was sent on the item: its own "where does this stand?" cards (waiting, state unknown, kill date, due,
   * when-retry, still on it, inbox, proposal) are answered. Agent cards (`agent:`, `after:`, `restart:`, or an
   * "Agent asks" badge on an agent-chosen key) and other kinds stay: they carry an agent's own question or result.
   * A card whose typed note the reader is still reading closes once the read ends (note(): acted on, failed, or the
   * question gone): closing it now would drop what the note asked for. 11-05: "just do it" sent an agent and the item's "Still waiting" card
   * stayed open. Returns how many closed now.
   */
  closeStateCards(itemId: string, reason: string) {
    const cards = this.store.openQuestionsFor(itemId).filter((q) => STATE_CARD.test(q.key) && !isAgentCard(q));
    let closed = 0;
    for (const q of cards) {
      const r = this.reading.get(q.id);
      if (r) r.close = reason;
      else (this.expireQuestion(q.id, reason), closed++);
    }
    return closed;
  }

  expireQuestion(id: string, reason = "expired") {
    const q = this.store.question(id);
    if (!q || q.status !== "open") return;
    q.status = "expired";
    q.answer = reason;
    q.answeredAt = nowIso();
    this.store.putQuestion(q);
    this.emit({ type: "question", data: q });
    this.coachClosed(q);
  }

  /**
   * A local job (launchd script) found its Cloudflare Access session for `app` lapsed: one "Log in now" card per
   * app per day, key `access-login:<host>:<day>`. Replaces a free-text capture per run (`whq pineapple`, since removed), which sent a triage job each time
   * (10-22..10-29: six of them for a ClickHouse app). Asking again while the card is open, or after "Later" that
   * day, does nothing; after a login (that failed, or lapsed again) or `resolved`, a lapse asks again. Yesterday's
   * card closes. `resolved`: the job got through, so close any open card for the app instead.
   */
  accessLoginCard(b: { app: string; reason?: unknown; resolved?: unknown }, now = new Date()) {
    if (typeof b.app !== "string" || !ACCESS_APP.test(b.app)) throw new Error("app must be https://<host>");
    const host = new URL(b.app).host;
    const key = `access-login:${host}:${localDay(now)}`;
    if (b.resolved === true) {
      this.settleAccessLoginTodos(host, `Access login for ${host} works again`);
      return { asked: false, closed: this.closeAccessLoginCards(host, "session back") };
    }
    const closed = this.closeAccessLoginCards(host, "day moved on", key);
    if (this.store.lastAnswered(key)?.answer?.startsWith(ACCESS_LATER)) return { asked: false, closed, key };
    const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 400) : "";
    const q = this.ask({
      kind: "open",
      key,
      badge: "Login expired",
      priority: 80,
      prompt: `Your Cloudflare Access login for ${host} lapsed`,
      context: `${reason || "A local job needs it and can't open the browser itself."} Log in and the job's next run gets through.`,
      options: [
        { id: "login", label: "Log in now (opens one tab)", tone: "primary", effect: { type: "accessLogin", app: `https://${host}` } },
        { id: "later", label: ACCESS_LATER, tone: "quiet", effect: { type: "noop" } },
      ],
    });
    return { asked: !!q, closed, key };
  }

  /**
   * The login for `host` works again: mark done the open todos that only ask for that login ("Re-login CF Access for
   * ready-analytics-us"), so a memory todo doesn't sit beside the keyed card. A task whose title has a login word and
   * the host or its first label; a title that joins two things ("Jira and ready-analytics") stays, one login doesn't
   * finish it. Confirmed, so a memory re-import doesn't reopen it. Returns the ids.
   * 11-04..11-08: the ready-analytics todo stayed open beside the card through four lapses and logins.
   */
  settleAccessLoginTodos(host: string, why: string) {
    const ids: string[] = [];
    for (const it of this.store.items()) {
      if (it.kind !== "task" || !isOpen(it) || !accessLoginTodo(it.title, host)) continue;
      this.setStatus(it.id, "done", why, "hq", true);
      ids.push(it.id);
    }
    return ids;
  }

  /** Close the open `access-login:<host>:*` cards (all, or all but `keep`). Returns how many. */
  closeAccessLoginCards(host: string, why: string, keep?: string) {
    const cards = this.store.questions("open").filter((q) => q.key.startsWith(`access-login:${host}:`) && q.key !== keep);
    for (const q of cards) this.expireQuestion(q.id, why);
    return cards.length;
  }

  /**
   * `journalOpen`: also journal "prompt → answer" for an `open` question, unless the effect
   * already wrote that line (item-less status/open/noop do). The answer route sets it.
   */
  async answer(questionId: string, optionId: string, note?: string, opts: { journalOpen?: boolean } & AnswerContext = {}) {
    const q = this.store.question(questionId);
    if (!q || q.status !== "open") throw new Error("question not open");
    const opt = q.options.find((o) => o.id === optionId);
    if (!opt) throw new Error("no such option");
    q.status = "answered";
    q.answer = opt.label + (note ? ` — ${note}` : "");
    q.answeredAt = nowIso();
    this.store.putQuestion(q);
    this.emit({ type: "question", data: q });
    this.coachClosed(q);
    this.rememberAnswer(q, opt.label, note);
    const journaled = await this.applyEffect(opt.effect, q, opt, note, { itemIds: opts.itemIds, picks: opts.picks });
    if (opts.journalOpen && q.kind === "open" && !journaled) this.journal(`${q.prompt} → ${q.answer}`);
    return q;
  }

  /**
   * Agent questions (`agent:*`, `after:*`) are answered once, then the next agent run only
   * sees item.notes. Keep "prompt → label (— note)" there so nobody asks the same thing twice.
   * Runs before the effect so a dispatch from this answer already sees it.
   */
  private rememberAnswer(q: Question, label: string, note?: string) {
    if (!q.itemId || !/^(agent|after):/.test(q.key)) return;
    const item = this.store.item(q.itemId);
    if (!item) return;
    const words = note?.trim();
    const text = `${q.prompt} → ${label}${words ? ` — ${words}` : ""}`;
    let notes = [...(item.notes ?? [])];
    // A typed note already landed on its own via note(); fold it into this line rather than repeat it.
    if (words && notes.at(-1)?.text === words) notes = notes.slice(0, -1);
    this.updateItem(item.id, { notes: [...notes, { at: nowIso(), text }].slice(-20) });
  }

  /** Returns true when it journaled the "prompt → answer" line itself. */
  async applyEffect(effect: Effect, q: Question | undefined, opt: QuestionOption | undefined, note?: string, ctx: AnswerContext = {}): Promise<boolean> {
    let itemId = q?.itemId;
    let journaled = false;
    const answerLine = () => {
      this.journal(`${q?.prompt} → ${opt?.label}${note ? ` — ${note}` : ""}`);
      journaled = true;
    };
    // Meeting questions have no item until the owner wants something done about them.
    if (!itemId && q?.eventId && effect.type === "dispatch") {
      const ev = this.store.events().find((e) => e.id === q.eventId);
      if (ev) itemId = this.prepItem(ev);
    }
    // The coaching move (prompter askCoachMove) has no item until it's handed to an agent. Journal the answer
    // first, so "M5 move: \u2026 \u2192 Hand to an agent" reads like Done / Not today do.
    if (!itemId && q?.key.startsWith("coach:") && effect.type === "dispatch") {
      answerLine();
      const c = this.coaching();
      const date = q.key.slice("coach:".length);
      const key = `coach:move:${date}`;
      itemId =
        this.store.itemBySourceKey(key)?.id ??
        this.createItem({
          title: q.prompt.replace(/^M5 move: /, "M5 move (" + date.slice(5) + "): ").replace(/\. Did it happen\?$/, ""),
          kind: "task",
          status: "doing",
          detail: c?.date === date ? c.move : q.context,
          source: { type: "agent", label: `Coaching ${date}`, key, url: c?.date === date ? c.url : undefined },
        }).id;
    }
    switch (effect.type) {
      case "status":
        if (effect.itemId) {
          // A batched card: skip items that moved on since it was asked (closed on their own card).
          const it = this.store.item(effect.itemId);
          if (it && !["done", "dropped"].includes(it.status)) this.setStatus(it.id, effect.status, note ?? effect.note);
        } else if (itemId) this.setStatus(itemId, effect.status, note ?? effect.note);
        else answerLine();
        break;
      case "schedule":
        if (itemId) this.schedule(itemId, effect.inMin ? new Date(Date.now() + effect.inMin * 60_000).toISOString() : effect.at, effect.label);
        break;
      case "snooze":
        if (q) this.reopen(q, effect.minutes);
        break;
      case "dispatch":
        if (itemId && this.dispatcher) {
          this.journal(`Dispatched ${effect.action}: ${this.store.item(itemId)?.title}`, { itemId });
          // A typed note adds to the option's note (which question, which choice), it doesn't replace it.
          const typed = note?.trim();
          await this.dispatcher.dispatch(
            itemId,
            effect.action,
            typed && effect.note ? `${effect.note}\nThey added: ${typed}` : typed || effect.note,
            q && opt ? `${q.prompt} → ${opt.label}${typed ? ` — ${typed}` : ""}` : undefined,
          );
        } else if (!itemId && q && opt && this.dispatcher && picksDispatchOption(q, effect.action)) {
          journaled = await this.dispatchPicks(effect, q, opt, note, ctx);
        }
        break;
      case "when":
        if (itemId && note?.trim() && this.dispatcher) {
          // Parsing takes a few seconds; the answer is recorded now, the time lands when it's resolved.
          void this.dispatcher.scheduleFromWords(itemId, note.trim()).catch((e) => this.toast(`Couldn't schedule: ${e.message}`, "warn"));
        } else if (q) {
          this.reopen(q, 0);
          this.toast("Say or type when, then pick it again.", "warn");
        }
        break;
      case "open":
        openLocal(effect.url);
        if (effect.keep && q) this.reopen(q, 0);
        else if (q && !itemId) answerLine();
        break;
      case "noop":
        if (q && !itemId) answerLine();
        break;
      case "gatewayLogin":
        void this.dispatcher?.gatewayLogin?.(effect.app);
        break;
      case "accessLogin":
        void this.dispatcher?.accessLogin?.(effect.app)?.catch((e) => this.toast(`Login failed: ${errText(e)}`, "warn"));
        break;
      case "triage":
        // Not awaited: triage takes seconds and the card has already been answered.
        // A note typed with the tap is part of the answer ("Yes — but only the Q3 numbers").
        void this.dispatcher?.triage?.(note?.trim() ? `${effect.text}\nThey added: ${note.trim()}` : effect.text, effect.mode)?.catch((e) => this.toast(`Triage failed again: ${errText(e)}`, "warn"));
        break;
      case "commitPlan": {
        // The card shows every today item; what's left unticked leaves today (10-21: unticking did nothing,
        // so today only grew: 16 items, some carried since 10-15). Agent-run (doing) items aren't on the card.
        const picked = new Set(ctx.itemIds ?? []);
        for (const id of picked) {
          const it = this.store.item(id);
          if (!it || ["done", "dropped"].includes(it.status)) continue;
          if (it.status === "today") this.updateItem(id, { confirmedAt: nowIso() });
          else this.setStatus(id, "today", "picked in morning plan");
        }
        for (const it of this.store.items()) {
          if (it.status === "today" && !picked.has(it.id)) this.setStatus(it.id, "proposed", "not picked in morning plan");
        }
        if (q && !itemId) answerLine();
        break;
      }
      case "prepMeetings": {
        // The morning prep card: one prep agent per ticked meeting. A typed note with nothing ticked
        // ("prep Kevin and Kuba", "all of them") picks by name.
        // Only the card's own (current) meetings: a stale tick on one that dropped off, or a stray id, does nothing.
        const listed = q?.picks ?? [];
        const ticked = Array.isArray(ctx.picks) ? ctx.picks.filter((id) => listed.some((p) => p.id === id)) : [];
        const ids = ticked.length ? ticked : note?.trim() ? picksFromNote(listed, note) : [];
        if (!ids.length) {
          // Don't eat the note: keep the card and say why.
          if (q) this.reopen(q, 0);
          this.toast(note?.trim() ? "No meeting on the card matched that. Tick one, or name it." : "Nothing ticked. Tick a meeting first.", "warn");
          break;
        }
        if (q && !itemId) answerLine();
        for (const id of ids) {
          const ev = this.store.events().find((e) => e.id === id);
          if (!ev || !this.dispatcher) continue;
          const prepId = this.prepItem(ev);
          if (this.store.liveJobs().some((j) => j.itemId === prepId)) continue;
          this.journal(`Dispatched prep: ${this.store.item(prepId)?.title}`, { itemId: prepId });
          await this.dispatcher.dispatch(prepId, "prep", note?.trim() || undefined, q ? `${q.prompt} → ${ev.title}` : undefined);
        }
        break;
      }
      case "donePicks": {
        // The recheck card: the ticked items landed and are done. A typed note with nothing ticked picks by name.
        const listed = q?.picks ?? [];
        const ticked = Array.isArray(ctx.picks) ? ctx.picks.filter((id) => listed.some((p) => p.id === id)) : [];
        // "All but the deploy one", "not Bravo": name matching can't subtract, so ask for ticks rather than guess.
        // Fail closed: any word that might leave something out ("skip", "no", "leave", "still") means ticks.
        // Best effort for picking by name; ticks are the real answer.
        const excludes = leavesOut(note);
        // "Mark all" takes no qualifiers: a note on it ("all but Bravo", "all with the exception of…") might leave
        // something out, and a blocklist can't catch every way of saying so. Only a plain "all" / "done" goes through.
        const plainAll = !note?.trim() || /^(all|every(thing| one)?|all of them|both|yes|yep|done|all done)[.!]*$/i.test(note.trim());
        const ids = effect.all ? (plainAll ? listed.map((p) => p.id) : []) : ticked.length ? ticked : note?.trim() && !excludes ? picksFromNote(listed, note) : [];
        if (!ids.length) {
          if (q) this.reopen(q, 0);
          this.toast(
            effect.all && note?.trim() ? "“Mark all” takes no note. Tick the ones you mean, or clear the note." : excludes ? "Tick the ones you mean: I won't guess what to leave out." : note?.trim() ? "No item on the card matched that. Tick one, or name it." : "Nothing ticked. Tick the done ones first.",
            "warn",
          );
          break;
        }
        if (q && !itemId) answerLine();
        // An agent picked one up since the card was drawn: it will report, don't close it under it.
        const busy = new Set(this.store.liveJobs().map((j) => j.itemId).filter(Boolean));
        const skipped: string[] = [];
        for (const id of ids) {
          const it = this.store.item(id);
          if (!it || ["done", "dropped"].includes(it.status)) continue;
          if (busy.has(id)) skipped.push(it.title);
          else this.setStatus(id, "done", `rechecked: ${listed.find((p) => p.id === id)?.hint ?? "landed"}`);
        }
        if (skipped.length) this.toast(`Left open, an agent is on ${skipped.length === 1 ? "it" : "them"}: ${skipped.join("; ")}`, "info");
        break;
      }
      case "closePicks": {
        // The stale card: close the ticked cards (or all of them). Ticks only: a typed note can't be trusted to
        // say which of several old cards to close, so it keeps the card and asks for ticks.
        const listed = q?.picks ?? [];
        const ticked = Array.isArray(ctx.picks) ? ctx.picks.filter((id) => listed.some((p) => p.id === id)) : [];
        const ids = effect.all ? (note?.trim() ? [] : listed.map((p) => p.id)) : ticked;
        if (!ids.length) {
          if (q) this.reopen(q, 0);
          this.toast(effect.all && note?.trim() ? "“Close all” takes no note. Tick the ones you mean, or clear the note." : "Tick the cards to close first.", "warn");
          break;
        }
        const label = new Map(listed.map((p) => [p.id, p.label]));
        const closed: string[] = [];
        for (const id of ids) {
          if (this.store.question(id)?.status !== "open") continue; // answered or closed elsewhere since
          this.expireQuestion(id, "closed as stale");
          closed.push(label.get(id) ?? id);
        }
        if (closed.length && q && !itemId) answerLine();
        if (closed.length) this.journal(`Closed ${closed.length} stale card${closed.length === 1 ? "" : "s"}: ${closed.join("; ")}`, { who: "hq" });
        else this.toast("Those cards were already closed.", "info");
        break;
      }
      case "retirePicks": {
        // The stale-proposals card: ticked rows (or all) go to dropped, the rest are kept. Ticks only, like closePicks:
        // a note can't be trusted to say which of 20 old items to drop, and a wrong guess drops one of the owner's items.
        const listed = q?.picks ?? [];
        const ticked = Array.isArray(ctx.picks) ? ctx.picks.filter((id) => listed.some((p) => p.id === id)) : [];
        const typed = Boolean(note?.trim());
        const drop = effect.keep ? [] : effect.all ? (typed ? null : listed.map((p) => p.id)) : ticked.length ? ticked : null;
        if (!drop) {
          if (q) this.reopen(q, 0);
          this.toast(effect.all && typed ? "“Retire all” takes no note. Tick the ones you mean, or clear the note." : "Tick the ones to retire first, or tap Keep all.", "warn");
          break;
        }
        if (q && !itemId) answerLine();
        // Only items still on proposed: one moved elsewhere since the card was drawn keeps its new status.
        const busy = new Set(this.store.liveJobs().map((j) => j.itemId).filter(Boolean));
        const dropSet = new Set(drop);
        const retired: string[] = [];
        const kept: string[] = [];
        const skipped: string[] = [];
        for (const p of listed) {
          const it = this.store.item(p.id);
          if (!it || it.status !== "proposed") continue;
          if (busy.has(it.id)) {
            skipped.push(it.title);
            continue;
          }
          if (dropSet.has(it.id)) {
            this.setStatus(it.id, "dropped", "retired: stale proposal");
            retired.push(it.title);
          } else {
            // Not confirmedAt: memory-sync's retire() reads that as "the owner's call" and would never drop the item
            // when memory stops listing it.
            this.updateItem(it.id, { staleKeptAt: nowIso() });
            kept.push(it.title);
          }
        }
        if (kept.length) this.journal(`Kept ${kept.length} stale proposal${kept.length === 1 ? "" : "s"} on Proposed: ${kept.join("; ")}`, { who: "you" });
        if (skipped.length) this.toast(`Left open, an agent is on ${skipped.length === 1 ? "it" : "them"}: ${skipped.join("; ")}`, "info");
        else if (!retired.length && !kept.length) this.toast("Those items already moved on.", "info");
        break;
      }
      case "stoppedPicks": {
        // The stopped-agents card: check or re-send the ticked items (or all). A typed note goes to each agent; it
        // doesn't pick rows: ticks only, as on the stale card.
        const listed = q?.picks ?? [];
        const ticked = Array.isArray(ctx.picks) ? ctx.picks.filter((id) => listed.some((p) => p.id === id)) : [];
        // "All" reads the card's own map: a one-row card has no tick-boxes.
        const ids = effect.all ? Object.keys(effect.jobs) : ticked;
        if (!ids.length) {
          if (q) this.reopen(q, 0);
          this.toast("Tick the ones you mean first.", "warn");
          break;
        }
        if (q && !itemId) answerLine();
        const typed = note?.trim();
        const busy = new Set(this.store.liveJobs().map((j) => j.itemId).filter(Boolean));
        const skipped: string[] = [];
        const failed: string[] = [];
        // Rows taken care of: sent, closed, or an agent's already on it. The rest come back on the card.
        const handled: string[] = [];
        for (const id of ids) {
          const it = this.store.item(id);
          if (!it || ["done", "dropped"].includes(it.status)) {
            handled.push(id); // closed since: nothing to do
            continue;
          }
          const job = effect.jobs[id] ? this.store.job(effect.jobs[id]!) : undefined;
          // An agent picked it up since the card was drawn (it will report), or nothing to send.
          if (busy.has(id) || !job || !this.dispatcher) {
            if (busy.has(id)) handled.push(id);
            skipped.push(it.title);
            continue;
          }
          const add = (base?: string) => (typed && base ? `${base}\nThey added: ${typed}` : typed || base);
          const decision = q && opt ? `${q.prompt} → ${opt.label}${typed ? ` — ${typed}` : ""}` : undefined;
          // One failed send doesn't stop the rest: the card is already answered, so say which to redo.
          try {
            if (effect.act === "check") {
              this.journal(`Dispatched verify: ${it.title}`, { itemId: id });
              await this.dispatcher.dispatch(id, "verify", add(stoppedJobNote(job)), decision);
            } else {
              this.journal(`Sent again (${job.name}): ${it.title}`, { itemId: id });
              // The same job again: its action, its instructions, and the answer that first sent it.
              await this.dispatcher.dispatch(id, job.name as ActionKind, add(job.note), job.decision ?? decision);
            }
            handled.push(id);
          } catch (e) {
            failed.push(`${it.title} (${errText(e)})`);
          }
        }
        if (skipped.length) this.toast(`Left alone (an agent is on ${skipped.length === 1 ? "it" : "them"}, or none can start): ${skipped.join("; ")}`, "info");
        if (failed.length) this.toast(`Couldn't send: ${failed.join("; ")}. They stay on the card.`, "warn");
        // Unticked rows, and ones that couldn't be sent, stay on a card: not stranded on doing.
        if (q) foldRest(this, q, handled);
        break;
      }
      case "flushJournal":
        void this.journalFlusher?.().catch((e) => this.toast(`Couldn't save the journal: ${errText(e)}`, "warn"));
        if (q && !itemId) answerLine();
        break;
      case "sweep":
        void this.dispatcher?.sweep?.(effect.name, effect.since ? { since: effect.since } : undefined)?.catch((e) => this.toast(`Sweep failed: ${errText(e)}`, "warn"));
        if (q && !itemId) answerLine();
        break;
      case "focusSession": {
        const job = itemId ? this.store.jobs(100).find((j) => j.itemId === itemId && j.workspace) : undefined;
        if (job) this.dispatcher?.focus?.(job.id);
        else this.toast("That session was closed after sitting idle. `pi --resume` in your workspace brings it back.", "warn");
        if (effect.keep && q) this.reopen(q, 0);
        else if (q && !itemId) answerLine();
        break;
      }
      case "multi":
        for (const e of effect.effects) if (await this.applyEffect(e, q, opt, note, ctx)) journaled = true;
        break;
    }
    return journaled;
  }

  /**
   * The prep item for a meeting: reused while open (same event). Otherwise createItem makes it, or reopens a closed
   * one for the same event (it dedupes on the source key) — a second brief for the same meeting, on `doing`.
   */
  private prepItem(ev: CalendarEvent): string {
    const key = `cal:prep:${ev.id}`;
    const existing = this.store.itemBySourceKey(key);
    if (existing && !["done", "dropped"].includes(existing.status)) return existing.id;
    return this.createItem({
      title: `Prep: ${ev.title}`,
      kind: "meeting",
      status: "doing",
      people: ev.attendees,
      detail: `${new Date(ev.start).toTimeString().slice(0, 5)}–${new Date(ev.end).toTimeString().slice(0, 5)}${ev.url ? ` · ${ev.url}` : ""}`,
      source: { type: "calendar", label: ev.title, key, url: ev.url },
    }).id;
  }

  /**
   * Batch triage. Applies one op to every open question the selector matches, using each
   * question's own option for it (so effects, journal and follow-through stay identical to
   * answering one by one). Plan / wrap / prep are never touched unless picked by id.
   * `defer` hides a question until `until`; for an item that's already scheduled it moves
   * the time instead, and with `kind` it also moves not-yet-due scheduled items of that kind.
   */
  async bulk(req: BulkRequest) {
    const { op } = req;
    const until = req.until && !Number.isNaN(Date.parse(req.until)) ? req.until : undefined;
    if (op === "defer" && !until) throw new Error("defer needs a time");
    const label = req.label ?? (until ? new Date(until).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "");
    const ids = req.ids ? new Set(req.ids) : undefined;
    const picked = this.store.questions("open").filter((q) => {
      if (ids && !ids.has(q.id)) return false;
      const g = deckGroup(q);
      if (!ids && g === "day") return false;
      if (req.group && g !== req.group) return false;
      if (req.kind && (!q.itemId || this.store.item(q.itemId)?.kind !== req.kind)) return false;
      return Boolean(req.ids || req.group || req.kind);
    });

    const touched: string[] = [];
    let skipped = 0;
    for (const q of picked) {
      const item = q.itemId ? this.store.item(q.itemId) : undefined;
      if (op === "defer") {
        if (item?.status === "scheduled") {
          this.updateItem(item.id, { scheduledFor: until, when: label, confirmedAt: nowIso() });
          this.expireQuestion(q.id, `pushed to ${label}`);
        } else {
          q.notBefore = until;
          this.store.putQuestion(q);
          this.emit({ type: "question", data: q });
        }
        touched.push(item?.title ?? q.prompt);
        continue;
      }
      const opt = optionFor(q, op);
      if (!opt) {
        skipped++;
        continue;
      }
      await this.answer(q.id, opt.id);
      touched.push(item?.title ?? q.prompt);
    }

    // "Skip all blog posts till Thursday" also means the ones already scheduled for tomorrow.
    if (op === "defer" && req.kind && !ids) {
      const done = new Set(picked.map((q) => q.itemId));
      for (const it of this.store.items()) {
        if (it.kind !== req.kind || it.status !== "scheduled" || done.has(it.id)) continue;
        if (it.scheduledFor && Date.parse(it.scheduledFor) >= Date.parse(until!)) continue;
        this.updateItem(it.id, { scheduledFor: until, when: label, confirmedAt: nowIso() });
        touched.push(it.title);
      }
    }

    if (touched.length) {
      const verb = { dispatch: "Dispatched", done: "Marked done", drop: "Dropped", dismiss: "Cleared", defer: `Deferred to ${label}` }[op];
      this.journal(`Batch \u2014 ${verb} (${touched.length}): ${touched.join("; ")}`.slice(0, 1200));
    }
    return { count: touched.length, skipped };
  }

  // ── notes typed on a question ──────────────────────────────────────────
  /**
   * ⌘↵ in the note field. The note is an answer in words, not a comment on the side:
   * keep it on the item, take the question out of the queue straight away, then act on it
   * (pick an option, change status, schedule, send an agent). If it's pure context, the
   * question comes back the next working morning, not on the next tick.
   */
  async note(questionId: string, text: string): Promise<{ pending: boolean }> {
    const q = this.store.question(questionId);
    if (!q || q.status !== "open") throw new Error("question not open");
    const t = text.trim();
    if (!t) throw new Error("empty note");
    const item = q.itemId ? this.store.item(q.itemId) : undefined;
    const noteId = this.journal(item ? `Note on ${item.title}: ${t}` : `Re "${q.prompt}": ${t}`, { itemId: item?.id, questionId: q.id }).id;
    if (item) this.updateItem(item.id, { notes: appendNote(item, t), confirmedAt: nowIso() });
    this.park(q, new Date(Date.now() + 15 * 60_000).toISOString());

    const quick = quickNote(t, q);
    if (quick || !this.dispatcher?.readNote) {
      await this.applyNote(q.id, quick ?? {}, t, new Date(), noteId);
      return { pending: false };
    }
    const read = this.dispatcher.readNote.bind(this.dispatcher);
    void (async () => {
      let d: NoteDecision | undefined;
      const r = this.reading.get(q.id) ?? { n: 0 };
      r.n++;
      this.reading.set(q.id, r);
      // finally: a throw below (park, journal, toast, applyNote) still ends this read, so a held close happens and the
      // entry doesn't leak. The last read on the card is done: a close held while it ran (closeStateCards) happens now.
      try {
        try {
          d = await read(q.id, t).catch((e) => {
            if (!isCrash(e)) throw e;
            this.journal(`Note reader crashed (${errText(e)}), retrying once`, { itemId: item?.id, questionId: q.id, who: "hq" });
            return read(q.id, t);
          });
        } catch (e) {
          // Never apply an empty decision here: a crash is not "you typed background".
          // An agent was sent on the item while this ran: the card closes when the read ends, so don't promise it back.
          if (r.close) {
            this.journal(`Couldn't read note (${errText(e)}); an agent is already on it, card closed`, { itemId: item?.id, questionId: q.id, who: "hq" });
            this.toast(`Couldn't read that note (${errText(e)}). It's kept on the item; an agent is already on it, so the card is closed.`, "warn");
            return;
          }
          this.park(q, new Date(Date.now() + 15 * 60_000).toISOString());
          this.journal(`Couldn't read note (${errText(e)}), card back in 15 min`, { itemId: item?.id, questionId: q.id, who: "hq" });
          this.toast(`Couldn't read that note (${errText(e)}). Card back in 15 min.`, "warn");
          return;
        }
        if (d) await this.applyNote(q.id, d, t, new Date(), noteId).catch((e) => this.toast(`Couldn't act on that note: ${errText(e)}`, "warn"));
      } finally {
        if (--r.n <= 0) {
          this.reading.delete(q.id);
          if (r.close) this.expireQuestion(q.id, r.close);
        }
      }
    })().catch((e) => {
      // Escaped the handler (a journal or toast that threw): the read already ended above; leave a trace.
      console.error(`note read on ${q.id}:`, e);
      try {
        this.journal(`Couldn't act on note (${errText(e)})`, { itemId: item?.id, questionId: q.id, who: "hq" });
      } catch {}
    });
    return { pending: true };
  }

  /**
   * A note typed in the item drawer (PATCH /api/items/:id with a note, no status). Background stays background:
   * kept on the item, journalled, nothing runs. An instruction ("do it", "ask Bernardo", "check the logs") goes
   * through the same reader as a card note: on the item's open card if it has one, else on a hidden one-off
   * `drawer:` card that expires if the reader calls it context. 10-15 14:58: "do it" on it_mv7a0vsjsewtj was
   * filed as context and the item sat in today for six days. `who: "agent"` (an agent's PATCH) is always context.
   */
  async itemNote(itemId: string, text: string, who: "you" | "agent" = "you"): Promise<{ pending: boolean; routed: boolean }> {
    const item = this.store.item(itemId);
    if (!item) throw new Error("no such item");
    const t = text.trim();
    if (!t) throw new Error("empty note");
    // An agent's note is always context: the reader acts on the owner's instructions only.
    if (who === "agent" || !isInstruction(t) || ["done", "dropped"].includes(item.status)) {
      this.updateItem(item.id, { notes: appendNote(item, t, who === "agent" ? "agent" : undefined) });
      this.journal(`Note on ${item.title}: ${t}`, { itemId: item.id, who });
      return { pending: false, routed: false };
    }
    const card = this.store
      .questions("open")
      .find((q) => q.itemId === item.id && !["review", "plan", "wrap"].includes(q.kind));
    const q = card ?? this.ask({
      kind: "dispatch",
      itemId: item.id,
      key: `drawer:${item.id}:${Date.now()}`,
      priority: 60,
      // Born parked: note() takes it from here, and it only resurfaces if the reader couldn't be run.
      notBefore: new Date(Date.now() + 15 * 60_000).toISOString(),
      prompt: `What should happen with: ${item.title}?`,
      context: `You wrote in the item drawer: “${t.slice(0, 300)}”`,
      options: [
        { id: "go", label: "Send an agent", tone: "primary", effect: { type: "dispatch", action: "work" } },
        { id: "when", label: "Scheduled for…", hint: "say when", effect: { type: "when" } },
        { id: "done", label: "Done", effect: { type: "status", status: "done" } },
        { id: "drop", label: "Drop it", tone: "quiet", effect: { type: "status", status: "dropped" } },
      ],
    });
    if (!q) throw new Error("couldn't open a card for that note");
    const r = await this.note(q.id, t);
    return { ...r, routed: true };
  }

  async applyNote(questionId: string, d: NoteDecision, text: string, now = new Date(), noteId?: string) {
    const q = this.store.question(questionId);
    if (!q || q.status !== "open") return; // answered some other way meanwhile
    let item = q.itemId ? this.store.item(q.itemId) : undefined;
    const note = d.note?.trim() || text;

    if (item && d.title?.trim() && d.title.trim() !== item.title) {
      const was = item.title;
      item = this.updateItem(item.id, { title: d.title.trim(), confirmedAt: nowIso() });
      this.journal(`Corrected: ${was} → ${item.title}`, { itemId: item.id });
    }

    const opt = d.pick ? q.options.find((o) => o.id === d.pick) : undefined;
    // The stale card closes cards on ticks or a bare "Close all" tap: a note can't say which, so don't guess.
    // Same for the stopped-agents card's tick-only options: a note can't pick rows. The stale-proposals card takes no
    // note at all, whatever the reader made of it: it has no item, so a status or a "when" would do nothing and the
    // card would sit parked until the next morning.
    const retireCard = q.options.some((o) => o.effect.type === "retirePicks");
    if (retireCard || opt?.effect.type === "closePicks" || (opt?.effect.type === "stoppedPicks" && !opt.effect.all)) {
      // note() hid it for 15 min: it's still waiting on a tap, so show it again now.
      const cur = this.store.question(q.id);
      if (cur?.notBefore) {
        cur.notBefore = undefined;
        this.store.putQuestion(cur);
        this.emit({ type: "question", data: cur });
      }
      this.toast(retireCard ? "Tap a button on the card (tick the ones to retire first, or Keep all). A note can't answer this one." : opt?.effect.type === "closePicks" ? "Tick the cards to close, or tap Close all. A note can't pick them." : "Tick the ones you mean, or tap the button for all of them. A note can't pick them.", "warn");
      return;
    }
    // A card of several items (recheck) with its own agent option: a typed "check them all yourself" goes through
    // it, one agent across the items. 10-27: that note was parked as stranded and the card sat open for a week.
    // Only when the reader wants what the option does: "chase the reviewer on Bravo" (reply) isn't a check, and still
    // gets the stranded "open one to act on it". Only when an item is left to check, so the toast below is true.
    const viaPicks = !opt && !item && this.dispatcher && d.dispatch?.action ? picksDispatchOption(q, d.dispatch.action) : undefined;
    if (viaPicks && this.pickTargets(q, [], text).length) {
      // The typed words only: the reader's paraphrase ("check charlie only") would change which items are picked.
      await this.answer(q.id, viaPicks.id, text);
      // Fixed words: the agent hasn't started yet, so the model's reply isn't safe here.
      this.toast(`Noted → ${viaPicks.label}`, "good");
      return;
    }
    // "Open the link" keeps the question open; that's not an answer.
    if (opt && !((opt.effect.type === "open" || opt.effect.type === "focusSession") && opt.effect.keep)) {
      const words = opt.effect.type === "when" ? d.when?.trim() || text : note;
      await this.answer(q.id, opt.id, words);
      // reply-safe: queuedNote takes over when the pick only queues work; otherwise answer() already applied it.
      this.toast(queuedNote(q, d, item?.title) ?? d.reply ?? `Noted → ${opt.label}`, "good");
      return;
    }
    if (item && d.dispatch?.action && this.dispatcher) {
      this.closeWithNote(q, text);
      const agentNote = d.dispatch.note?.trim() || text;
      this.journal(`Dispatched ${d.dispatch.action}: ${item.title} — ${agentNote}`, { itemId: item.id });
      // Never the model's reply here: it reads as done ("Asking Maryna in chat…", 10-16) while the agent hasn't started.
      this.toast(queuedNote(q, d, item.title)!, "good");
      await this.dispatcher.dispatch(item.id, d.dispatch.action, agentNote, `${q.prompt} → (typed) ${text}`);
      return;
    }
    // No item, but the card makes one when its own dispatch option is picked (the coaching move):
    // a typed instruction goes through that option. 11-02: "break this out into smaller tasks" on the M5 card
    // was parked as stranded while the reply said an agent was on it.
    const ownGo = !item ? itemlessDispatchOption(q, d) : undefined;
    if (ownGo && this.dispatcher) {
      // The typed words always go (journal, agent brief); the reader's reading rides along when it adds something.
      const read = d.dispatch?.note?.trim();
      await this.answer(q.id, ownGo.id, read && read !== text ? `${text}\n(Read as: ${read})` : text);
      // Fixed words: the agent hasn't started yet, so the model's reply isn't safe here.
      this.toast(`Noted → ${ownGo.label}`, "good");
      return;
    }
    if (item && d.when?.trim() && this.dispatcher) {
      this.closeWithNote(q, text);
      const id = item.id;
      void this.dispatcher.scheduleFromWords(id, d.when.trim()).catch((e) => this.toast(`Couldn't schedule: ${e.message}`, "warn"));
      return;
    }
    if (item && d.status) {
      this.closeWithNote(q, text);
      this.setStatus(item.id, d.status, note !== text ? note : undefined);
      // reply-safe: setStatus already ran.
      this.toast(d.reply ?? `${label(d.status)}: ${item.title}`, "good");
      return;
    }
    // Context only. Keep it, ask again next working morning.
    const back = nextMorning(now);
    // The reader wanted an agent but the card has no single item to send one on (a batched card).
    const stranded = !item && Boolean(d.dispatch?.action);
    // The reply was written before anything ran. Nothing ran here, so a reply that says an agent is on it is
    // false (10-22 "chase Omar" → "Sending an agent to chase Omar.", no job). Say so wherever it's kept.
    const unbacked = Boolean(d.reply?.trim()) && (stranded || claimsDispatch(d.reply));
    if (unbacked) this.journal(`Note reply claimed a dispatch but none started (${stranded ? "card has no single item" : "heuristic, check it"}): "${d.reply!.trim()}"`, { itemId: item?.id, questionId: q.id, noteId, who: "hq" });
    // A question in the note ("eli5") gets its answer in d.reply. A toast alone loses it (10-15): keep it
    // on the item, in the journal and on the card, so the card that comes back still explains itself.
    const reply = unbacked ? `${d.reply!.trim()} (No agent started.)` : d.reply?.trim();
    if (reply) {
      if (item) this.updateItem(item.id, { notes: [...(item.notes ?? []), { at: nowIso(), text: reply, who: "hq" as const }].slice(-20) });
      this.journal(item ? `Reply on ${item.title}: ${reply}` : `Reply re "${q.prompt}": ${reply}`, { itemId: item?.id, questionId: q.id, who: "hq" });
      const cur = this.store.question(q.id);
      if (cur && !cur.context?.includes(reply)) {
        cur.context = [cur.context, `**You asked:** ${text}\n**HQ:** ${reply}`].filter(Boolean).join("\n\n");
        this.store.putQuestion(cur);
      }
    }
    if (stranded) {
      this.park(q, back.toISOString());
      this.toast(
        q.options.some((o) => o.effect.type === "donePicks") ? (batchedItems(q) > 1 ? "That card covers several items. Tick the ones that are done, or open one to act on it." : "That card only marks things done. Open the item to act on it.") : batchedItems(q) > 1 ? "That card covers several items. Open one to act on it." : "That card isn't tied to an item, so no agent started.",
        "warn",
      );
      return;
    }
    // A drawer note read as background: nobody asked a question, so there's no card to bring back.
    if (q.key.startsWith("drawer:")) {
      this.expireQuestion(q.id, `Note: ${text}`);
      // reply-safe: context only, nothing runs; the reply is an answer.
      this.toast(reply ? `${reply} Kept as context.` : "Kept as context.", "info");
      return;
    }
    this.park(q, back.toISOString());
    // reply-safe: context only, nothing runs; the reply is an answer.
    this.toast(reply ? `${reply} Back ${fmtDay(back)}.` : `Noted. Back ${fmtDay(back)}.`, "info");
  }

  /**
   * One agent across a card's item picks (picksDispatchOption): the ticked ones, else the ones the note names, else
   * all of them. A note that might leave some out takes all of them and passes the words on: the note only asks the
   * agent to propose (RECHECK_VERIFY_NOTE), so one too many costs a look, never a closure. The job sits on the
   * first item (dispatch takes one); its note names every item by id, with links, so its report can update each.
   * Returns true when it journaled the answer line.
   */
  private async dispatchPicks(effect: Extract<Effect, { type: "dispatch" }>, q: Question, opt: QuestionOption, note: string | undefined, ctx: AnswerContext): Promise<boolean> {
    const listed = q.picks ?? [];
    const typed = note?.trim();
    const open = this.pickTargets(q, Array.isArray(ctx.picks) ? ctx.picks : [], typed);
    if (!open.length) {
      // Don't eat the card (a tap answered it already): put it back and say why.
      this.reopen(q, 0);
      this.toast("Nothing left to check there: those items are closed, or an agent is on them.", "info");
      return false;
    }
    this.journal(`${q.prompt} → ${opt.label}${typed ? ` — ${typed}` : ""}`);
    const hint = (id: string) => listed.find((p) => p.id === id)?.hint;
    const list = open
      .map((it) => `- ${it.id} · ${it.title}${hint(it.id) ? ` (${hint(it.id)})` : ""}${it.links?.length ? `\n  links: ${it.links.join(" ")}` : ""}`)
      .join("\n");
    const agentNote = [
      effect.note,
      `${PICKS_JOB_HEADER} ${open.length} item${open.length === 1 ? "" : "s"}. Report an update (and a question, if one is needed) for each id:\n${list}`,
      typed ? `They added: ${typed}` : "",
    ].filter(Boolean).join("\n");
    this.journal(`Dispatched ${effect.action} across ${open.length} item${open.length === 1 ? "" : "s"}: ${open.map((it) => it.title).join("; ")}`, { itemId: open[0]!.id });
    await this.dispatcher!.dispatch(open[0]!.id, effect.action, agentNote, `${q.prompt} → ${opt.label}${typed ? ` — ${typed}` : ""}`);
    return true;
  }

  /**
   * The items a picks agent would cover (dispatchPicks): the ticked ones, else the ones the note names, else all;
   * then only those still open with no agent on them already (it will report). An item another picks job lists in
   * its note (`- <id> ·`) counts as having an agent: that job sits on its first item only.
   */
  private pickTargets(q: Question, ticks: string[], note?: string): Item[] {
    const listed = q.picks ?? [];
    const ticked = ticks.filter((id) => listed.some((p) => p.id === id));
    const typed = note?.trim();
    // What the note says about the check itself ("check these yourself") doesn't name an item ("Check the staging deploy").
    const named = typed && !leavesOut(typed) ? picksFromNote(listed, typed.replace(/\b(check(?:s|ed|ing)?|verif(?:y|ies|ied|ying)|them|these|those|yourself|myself)\b/gi, " ")) : [];
    const ids = ticked.length ? ticked : named.length ? named : listed.map((p) => p.id);
    // Action agents only: a note reader or a triage run on the item isn't looking at it.
    const live = this.store.liveJobs().filter((j) => j.kind === "action");
    const busy = (id: string) => live.some((j) => j.itemId === id || Boolean(j.note?.includes(PICKS_JOB_HEADER) && j.note.includes(`- ${id} · `)));
    return ids.map((id) => this.store.item(id)).filter((it): it is Item => Boolean(it && !["done", "dropped"].includes(it.status) && !busy(it.id)));
  }

  /** Hide an open question until `until`. */
  park(q: Question, until: string) {
    const cur = this.store.question(q.id);
    if (!cur || cur.status !== "open") return;
    cur.notBefore = until;
    this.store.putQuestion(cur);
    this.emit({ type: "question", data: cur });
  }

  /** Answered by a note that didn't map to one of its options. Counts as answered for cooldowns. */
  private closeWithNote(q: Question, text: string) {
    const cur = this.store.question(q.id);
    if (!cur || cur.status !== "open") return;
    cur.status = "answered";
    cur.answer = `Note: ${text}`;
    cur.answeredAt = nowIso();
    this.store.putQuestion(cur);
    this.emit({ type: "question", data: cur });
  }

  /** Put the same question back, now or later. */
  private reopen(q: Question, minutes: number) {
    const again: Question = {
      ...q,
      id: newId("q"),
      status: "open",
      answer: undefined,
      answeredAt: undefined,
      notBefore: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : q.notBefore,
      createdAt: minutes ? nowIso() : q.createdAt,
      reopenedFrom: q.reopenedFrom ?? q.id,
    };
    this.store.putQuestion(again);
    this.emit({ type: "question", data: again });
  }

  // ── meetings the transcript sweep has read ──────────────────────────────
  /**
   * Remember which meetings a transcript sweep covered and close their "just ended" questions:
   * once the notes are scanned, asking "anything you committed to?" is noise. Called after every successful
   * transcript sweep, even one that read nothing: the folded "Yesterday's meetings" card loses those meetings, closes
   * once none are left, and is redrawn against the sweeps' coverage (review-fold.ts). Returns the cards it closed,
   * per-meeting and folded.
   */
  markScanned(meetings: Array<{ title: string; start?: string; url?: string }>, now = new Date()) {
    const keep = now.getTime() - 3 * 86400_000;
    const at = now.toISOString();
    const list = [...this.scannedMeetings(), ...meetings.filter((m) => m.title?.trim()).map((m) => ({ title: m.title.trim(), start: m.start, at }))]
      .filter((m) => Date.parse(m.at) > keep)
      .slice(-200);
    this.store.setKv("scannedMeetings", JSON.stringify(list));
    const scanned = (ev: Pick<CalendarEvent, "title" | "start">) => list.some((m) => meetingMatches(m, ev));
    let closed = 0;
    for (const q of this.store.questions("open")) {
      if (q.kind !== "review" || !q.eventId) continue;
      const ev = this.store.events().find((e) => e.id === q.eventId);
      if (ev && scanned(ev)) {
        this.expireQuestion(q.id, "transcript scanned");
        closed++;
      }
    }
    return closed + pruneReviews(this, scanned, now);
  }

  /** Record what a successful transcript sweep read (review-fold.ts: noNotes). Kept 4 days, like the folds that use it. */
  noteSweepWindow(since: string, at: string, now = new Date()) {
    const keep = now.getTime() - 4 * 86400_000;
    const list = [...this.sweepWindows(), { since, at }].filter((w) => Date.parse(w.at) > keep).slice(-200);
    this.store.setKv("transcriptWindows", JSON.stringify(list));
  }

  sweepWindows(): Array<{ since: string; at: string }> {
    try {
      const v = JSON.parse(this.store.kv("transcriptWindows") ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  scannedMeetings(): Array<{ title: string; start?: string; at: string }> {
    try {
      return JSON.parse(this.store.kv("scannedMeetings") ?? "[]");
    } catch {
      return [];
    }
  }

  wasScanned(ev: Pick<CalendarEvent, "title" | "start">) {
    return this.scannedMeetings().some((m) => meetingMatches(m, ev));
  }

  // ── journal ────────────────────────────────────────────────────────────
  journal(text: string, opts: { itemId?: string; questionId?: string; noteId?: string; who?: JournalEntry["who"] } = {}) {
    const e: JournalEntry = {
      id: newId("j"),
      at: nowIso(),
      itemId: opts.itemId,
      ...(opts.questionId ? { questionId: opts.questionId } : {}),
      ...(opts.noteId ? { noteId: opts.noteId } : {}),
      who: opts.who ?? "you",
      text,
      synced: false,
    };
    this.store.putJournal(e);
    this.emit({ type: "journal", data: e });
    return e;
  }

  // ── jobs & sync ────────────────────────────────────────────────────────
  putJob(job: Job) {
    this.store.putJob(job);
    this.emit({ type: "job", data: job });
    return job;
  }

  /** Latest nightly coaching block (from the memory import). */
  coaching(): Coaching | undefined {
    try {
      const v = this.store.kv("coaching");
      return v ? { ...(JSON.parse(v) as Coaching), history: this.coachHistory() } : undefined;
    } catch {
      return undefined;
    }
  }
  setCoaching(c: Coaching) {
    const { history: _, ...plain } = c;
    const prev = this.store.kv("coaching");
    const next = JSON.stringify(plain);
    if (prev === next) return;
    this.store.setKv("coaching", next);
    this.emit({ type: "coaching", data: { ...plain, history: this.coachHistory() } });
  }
  /**
   * What became of the last `n` moves, newest first, from the closed "M5 move" cards (key `coach:<date>`).
   * A move whose card was never asked (stale reflection, server off) isn't counted.
   * A move handed to an agent stays "agent" until its `coach:move:<date>` item closes: done → "done", dropped → "not".
   */
  coachHistory(n = 5): CoachOutcome[] {
    const seen = new Set<string>();
    const out: CoachOutcome[] = [];
    for (const q of this.store.closedByPrefix("coach:", 100)) {
      const date = q.key.slice("coach:".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) continue;
      seen.add(date);
      if (q.status === "expired") {
        out.push({ date, outcome: "missed" });
        continue;
      }
      const a = q.answer ?? "";
      const opt = q.options.find((o) => a === o.label || a.startsWith(`${o.label} — `));
      const id = opt?.id;
      const note = opt && a.length > opt.label.length ? a.slice(opt.label.length + 3) : undefined;
      if (id === "agent") {
        const st = this.store.itemBySourceKey(`coach:move:${date}`)?.status;
        if (st === "done" || st === "dropped") {
          out.push({ date, outcome: st === "done" ? "done" : "not", via: "agent", ...(note ? { note } : {}) });
          continue;
        }
      }
      out.push({ date, outcome: id === "done" || id === "agent" || id === "not" ? id : "missed", ...(note ? { note } : {}) });
    }
    return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
  }
  /** The panel shows the move's outcome; re-send it when a coaching card closes. */
  private coachClosed(q: Question) {
    if (!q.key.startsWith("coach:")) return;
    const c = this.coaching();
    if (c) this.emit({ type: "coaching", data: c });
  }

  putSync(s: SyncState) {
    this.store.putSync(s);
    this.emit({ type: "sync", data: s });
  }

  setEvents(events: CalendarEvent[], through?: string) {
    const day = localDay(new Date());
    const last = [through ?? day, ...events.map((e) => e.start.slice(0, 10))].sort().pop()!;
    this.store.replaceEvents(day, last, events);
    this.emit({ type: "events", data: this.todayEvents() });
    this.emit({ type: "upcoming", data: this.upcomingEvents() });
  }

  /** The calendar sweep's out-of-office blocks. Replaced whole on each sweep that sends them; kept when one doesn't,
   *  or when every block it sent is unreadable (a garbled list shouldn't clear a real day off). */
  setAway(blocks: AwayBlock[]) {
    const ok = blocks.filter((b) => b && typeof b.start === "string" && typeof b.end === "string" && awayMs(b.end) > awayMs(b.start));
    if (blocks.length && !ok.length) return;
    const list = ok.slice(0, 200).map((b) => ({ title: String(b.title ?? "").slice(0, 200), start: b.start, end: b.end }));
    this.store.setKv("calendarAway", JSON.stringify(list));
  }

  away(): AwayBlock[] {
    try {
      const v = JSON.parse(this.store.kv("calendarAway") ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  /** The out-of-office block covering `now` that ends last (overlapping blocks: the day off wins over a short one). */
  awayAt(now = new Date()): AwayBlock | undefined {
    const t = now.getTime();
    return this.away()
      .filter((b) => awayMs(b.start) <= t && t < awayMs(b.end))
      .sort((a, b) => awayMs(b.end) - awayMs(a.end))[0];
  }

  // ── agent reports ──────────────────────────────────────────────────────
  ingestReport(r: AgentReport, fallbackSource: Item["source"]["type"] = "agent") {
    const job = r.jobId ? this.store.job(r.jobId) : undefined;
    const created: Item[] = [];
    const asked: Array<{ prompt: string; asked: boolean; options: string[] }> = [];
    // Action agents filed an idea for nearly every passing thought (81 on 10-21, against 1-9 a day a week
    // before). Past IDEA_CAP new ideas per job, fold the rest into the job summary, unless the dispatch note asked for ideas.
    const capIdeas = job?.kind === "action" && !asksForIdeas(job.note);
    let ideasFiled = job?.ideasFiled ?? 0;
    const folded: string[] = [];
    for (const raw of r.items ?? []) {
      const status = (raw.status as ItemStatus | undefined) ?? "inbox";
      const isNewIdea = raw.kind === "idea" && !(raw.source?.key && this.store.itemBySourceKey(raw.source.key));
      if (capIdeas && isNewIdea) {
        if (ideasFiled >= IDEA_CAP) {
          folded.push(raw.title.trim());
          continue;
        }
        ideasFiled++;
      }
      created.push(
        this.createItem({
          ...withoutCheckClosed(raw),
          status,
          source: { type: fallbackSource, label: job?.title, ...(raw.source ?? {}) },
        }),
      );
    }
    for (const u of r.updates ?? []) {
      if (!this.store.item(u.id)) continue;
      const { id, note, ...patch } = u;
      this.updateItem(id, withoutCheckClosed(patch as Partial<Item>));
      if (note || patch.status) this.journal(`${patch.status ? label(patch.status) + ": " : ""}${this.store.item(id)!.title}${note ? ` — ${note}` : ""}`, { itemId: id, who: "agent" });
      // A closed item's agent cards are moot, as with setStatus (which closes every card). Only agent cards here: an
      // agent's "done" shouldn't silently take the owner's own questions with it. Lets the boss check close an item
      // and its stale asks in one update.
      if (patch.status === "done" || patch.status === "dropped") {
        for (const q of this.store.questions("open").filter((q) => q.itemId === id && isAgentCard(q))) this.expireQuestion(q.id, `item ${patch.status}`);
      }
    }
    let closed = 0;
    // Boss check only, and only agent cards: no other job closes cards it didn't raise, and never the owner's own.
    for (const c of job?.kind === "action" && job.name === "boss" ? r.closeQuestions ?? [] : []) {
      const q = this.store.question(c.id);
      if (!q || !isAgentCard(q)) continue;
      this.expireQuestion(q.id, c.reason || "no longer applies");
      this.journal(`Closed card: ${q.prompt.slice(0, 120)}${c.reason ? ` — ${c.reason}` : ""}`, { itemId: q.itemId, who: "agent" });
      closed++;
    }
    for (const q of r.questions ?? []) {
      const opts = q.options?.length ? q.options : ["Yes", "No"];
      const byKey = q.itemKey ? this.store.itemBySourceKey(q.itemKey)?.id : undefined;
      const itemId = byKey ?? (q.itemId && this.store.item(q.itemId) ? q.itemId : job?.itemId);
      const made = this.ask({
        kind: "open",
        badge: job ? AGENT_ASKS : undefined,
        itemId,
        prompt: q.prompt,
        context: q.context,
        priority: q.priority ?? 72,
        key: q.key ?? `agent:${hash(q.prompt)}`,
        once: q.once,
        options: opts.map((o, i) => {
          const label = typeof o === "string" ? o : o.label;
          const effect = typeof o === "string" ? agentStringEffect(o, q.prompt, itemId) : o.url && /^https?:\/\//.test(o.url) ? { type: "open" as const, url: o.url, keep: true } : o.action ? { type: "dispatch" as const, action: o.action, ...(o.note ? { note: o.note } : {}) } : o.status ? { type: "status" as const, status: o.status } : agentStringEffect(o.label, q.prompt, itemId);
          return { id: `o${i}`, label, tone: i === 0 ? "primary" : effect.type === "status" && effect.status === "dropped" ? "danger" : effect.type === "status" && effect.status === "done" ? "good" : "quiet", effect };
        }),
      });
      // Echo what each button will do, so the agent sees a dead or wrong mapping in the same run.
      if (made) {
        const stalled = new Set(stallsOptions(made).map((o) => o.id));
        asked.push({ prompt: q.prompt, asked: true, options: made.options.map((o) => `${o.label} → ${effectText(o.effect)}${stalled.has(o.id) ? STALLS : ""}`) });
      } else asked.push({ prompt: q.prompt, asked: false, options: [] });
    }
    for (const line of r.journal ?? []) this.journal(line, { who: "agent" });
    if (r.events) this.setEvents(r.events, r.eventsThrough);
    if (fallbackSource === "calendar" && Array.isArray(r.away)) this.setAway(r.away);
    if (job) {
      const foldLine = folded.length ? `Could also: ${folded.join("; ")}` : "";
      const summary = r.summary && foldLine ? `${r.summary} ${foldLine}` : r.summary ?? (foldLine ? [job.summary, foldLine].filter(Boolean).join(" ") : undefined);
      const tail = summary ? [...job.tail, `✓ ${summary}`].slice(-12) : job.tail;
      // A job already marked failed (e.g. a cmux turn errored, then the agent recovered) that now
      // reports a result isn't stopped: mark it done and retire the "Agent stopped" card.
      const recovered = job.status === "failed" && r.status !== "failed" && r.status !== "progress";
      const ideas = capIdeas ? { ideasFiled, ...(folded.length ? { ideasFolded: [...(job.ideasFolded ?? []), ...folded] } : {}) } : {};
      this.putJob({ ...job, summary: summary ?? job.summary, tail, reported: true, ...ideas, ...(recovered ? { status: "done" as const, error: undefined } : {}) });
      if (recovered) {
        for (const q of this.store.questions("open").filter((q) => q.key === `after:${job.id}`)) this.expireQuestion(q.id, "agent reported");
      }
    }
    return { created: created.map((i) => i.id), ...(asked.length ? { questions: asked } : {}), ...(folded.length ? { folded } : {}), ...(closed ? { closed } : {}) };
  }
}

/** Appended to an echoed option that approves work but only moves the status (stallsOptions). */
export const STALLS = " (no agent starts)";

/** One line for what tapping a button does: "dispatch work", "status done", "noop (does nothing)". */
export function effectText(e: Effect): string {
  switch (e.type) {
    case "status": return `status ${e.status}`;
    case "dispatch": return `dispatch ${e.action}`;
    case "open": return `open ${e.url}`;
    case "triage": return "triage (re-read as a command-bar note)";
    case "schedule": return `schedule ${e.label}`;
    case "snooze": return `snooze ${e.minutes} min`;
    case "when": return "ask when (needs a note)";
    case "noop": return "noop (does nothing)";
    case "gatewayLogin": return "gateway login";
    case "accessLogin": return `cloudflared access login ${e.app}`;
    case "commitPlan": return "commit the picked items to today";
    case "prepMeetings": return "dispatch prep for each ticked meeting";
    case "donePicks": return e.all ? "mark every listed item done" : "mark each ticked item done";
    case "closePicks": return e.all ? "close every listed card" : "close each ticked card";
    case "retirePicks": return e.keep ? "keep every listed item on proposed" : e.all ? "drop every listed item" : "drop each ticked item, keep the rest";
    case "stoppedPicks": return `${e.act === "check" ? "dispatch verify" : "dispatch the same action again"} for ${e.all ? "every listed item" : "each ticked item"}`;
    case "flushJournal": return "save the journal to memory";
    case "sweep": return `run the ${e.name} sweep`;
    case "focusSession": return "focus the agent session";
    case "multi": return e.effects.map(effectText).join(" + ");
  }
}

/** Starts the item list in a picks job's note (dispatchPicks); pickTargets reads it back to see which items it covers. */
const PICKS_JOB_HEADER = "This one job covers";

/**
 * Might this note leave some of the card's items out ("all but the deploy one", "not Bravo")? Name matching can't
 * subtract, so callers ask for ticks (donePicks) or take every item and pass the words on (dispatchPicks).
 * Fails closed: any word that might leave something out ("skip", "no", "leave", "still") counts.
 */
export function leavesOut(note?: string): boolean {
  return /\b(but|except\w*|exclud\w*|not|no|none|never|neither|nothing|without|minus|apart|aside|besides?|others?|rest|else|skip\w*|omit\w*|ignor\w*|leav\w*|bar|save|spar\w*|still|hold|keep\w*|only|just|cannot|ain't|aint|\w+nt(?<=(?:do|is|are|does|did|wo|ca|should|could|would|has|have|was|were)nt))\b|n['’]t\b/i.test(note ?? "");
}

/**
 * The agent option of a card whose ticks are items (the recheck card: picks + donePicks), when it has no single
 * item. Picking it sends one agent across the items (Hub.dispatchPicks). With `action`, only an option doing that
 * action. Undefined for every other card: the meeting-prep card's picks are events, and a batched card's items are
 * in its options, not its picks.
 */
export function picksDispatchOption(q: Pick<Question, "options"> & Partial<Pick<Question, "picks" | "itemId">>, action?: ActionKind): QuestionOption | undefined {
  if (q.itemId || !q.picks?.length || !q.options.some((o) => o.effect.type === "donePicks")) return undefined;
  return q.options.find((o) => o.effect.type === "dispatch" && (!action || o.effect.action === action));
}

/**
 * The meetings a typed note names on the prep card: "all"/"every" → all of them; otherwise any whose label has a
 * word of 3+ letters from the note ("Kevin", "kuba"). Generic words (prep, sync, meeting) don't count.
 */
export function picksFromNote(picks: Array<{ id: string; label: string; hint?: string }>, note: string): string[] {
  const split = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const words = new Set(split(note).filter((w) => w.length >= 3 && !PICK_STOP.has(w)));
  if (/\b(all|every|each|both)\b/i.test(note) && !/\bnot\s+(all|every|each|both)\b/i.test(note)) return picks.map((p) => p.id);
  // The hint carries attendee names ("10:30 · 1-1" with hint "kevin"), so "prep Kevin" matches either.
  return picks.filter((p) => split(`${p.label} ${p.hint ?? ""}`).some((w) => words.has(w))).map((p) => p.id);
}
const PICK_STOP = new Set(["prep", "brief", "the", "and", "not", "all", "for", "with", "meeting", "meetings", "sync", "please", "just", "one", "only", "today", "call", "chat", "weekly"]);

/** Only local app schemes, web links and markdown/text files; never arbitrary files or commands. */
export function openableUrl(url: string): boolean {
  return /^(obsidian|https?):\/\//.test(url) || /^file:\/\/\/.+\.(md|markdown|txt)$/i.test(url);
}

/** `open <url>` for an openable URL. WORK_HQ_OPEN_BIN swaps the binary: test/setup.ts points it at `true`. */
export function openLocal(url: string) {
  if (!openableUrl(url)) return;
  try {
    Bun.spawn([process.env.WORK_HQ_OPEN_BIN || "open", url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

/**
 * A todo title that asks only for the Access login to `host`: a re-login phrase ("re-login", "re-auth", "log in to",
 * "access login") and the host's full name or its first label, word-bounded. A generic first label (login, auth,
 * sso…) only counts as the full host. A title that names a second thing is false: a joiner word or mark outside a URL
 * ("Jira and x", "Jira / x", "x, then y", any parentheses) or a second URL. A URL's path and query name nothing.
 * It fails closed: a todo left open beside the card is the old behaviour, a live todo closed by mistake is worse.
 */
export function accessLoginTodo(title: string, host: string) {
  if (!/\bre-?(log ?in|login|sign ?-?in|auth\w*)\b|\b(log|sign) ?-?in (again|to)\b|\baccess login\b/i.test(title)) return false;
  // A URL: scheme, host, then path/query up to a separator (`&` only inside a `k=v` pair). A second `://` is a second app.
  if ((title.match(/:\/\//g) ?? []).length > 1) return false;
  const url = /\b[a-z][a-z0-9.-]*:\/\/[^\s/?,;&+|()]+([/?](?:[^\s,;+|()&]|&(?=[\w.-]+=))*)?/gi;
  const urlHosts = (title.match(url) ?? []).map((u) => u.replace(/^[^:]+:\/\//, "").split(/[/?]/)[0] ?? "");
  const rest = title.replace(url, " ");
  if (/(?<![\w-])(and|or|then|vs|with|plus|also)(?![\w-])|[,;&+/|()—–]|\s-\s/i.test(rest)) return false;
  const h = host.toLowerCase().replace(/:\d+$/, "");
  const [label = h] = h.split(".");
  const names = [h, ...(label.length >= 3 && !GENERIC_LABEL.has(label) ? [label] : [])];
  // Names count in the words and as a URL's host, not inside another URL's path or query.
  const t = [rest, ...urlHosts].join(" ").toLowerCase();
  return names.some((n) => new RegExp(`(^|[^a-z0-9-])${n.replace(/[.\-]/g, "\\$&")}($|[^a-z0-9-])`).test(t));
}
const GENERIC_LABEL = new Set(["login", "auth", "sso", "access", "www", "app", "api", "dash", "portal", "gateway", "signin"]);

/**
 * The status a quiet re-import (createItem on a known source key, memory upsert) leaves an item on.
 * Its check closed it as no longer reported (checkClosed, the last status call it had) and it's reported again: back
 * to inbox, so a problem that recurs is back on the board. Otherwise an owner's call (confirmedAt) stands, and a
 * re-import with status "inbox" (a re-report's default, not a decision) never moves an item off another status: an
 * agent's Waiting or Done carries no confirmedAt. Any other status a re-import names still applies.
 */
export function quietStatus(cur: Pick<Item, "status" | "confirmedAt" | "checkClosed">, status: ItemStatus | undefined, quiet?: boolean): ItemStatus {
  if (!quiet || !status) return status ?? cur.status;
  if (status === "inbox" && cur.status === "done" && cur.checkClosed) return status;
  if (cur.confirmedAt || status === "inbox") return cur.status;
  return status;
}

/** checkClosed is Checks.run's to set: agent reports can't mark an item revivable. */
function withoutCheckClosed<T extends { checkClosed?: unknown }>(x: T): Omit<T, "checkClosed"> {
  const { checkClosed: _c, ...rest } = x;
  return rest;
}

/** Item notes keep the last 20. `who` absent = the owner's words; "agent" = an agent posted it over the API. */
export function appendNote(item: Pick<Item, "notes">, text: string, who?: "agent"): Item["notes"] {
  return [...(item.notes ?? []), { at: nowIso(), text, ...(who ? { who } : {}) }].slice(-20);
}

export function label(s: ItemStatus) {
  return {
    inbox: "Captured",
    proposed: "Proposed",
    today: "Committed today",
    scheduled: "Scheduled",
    doing: "Started",
    waiting: "Waiting",
    done: "Done",
    dropped: "Dropped",
  }[s];
}

/** Agents write options in English. Map the obvious ones to real effects. */
export function effectFromLabel(label: string): Effect {
  const l = label.toLowerCase();
  if (/\b(drop|kill|reject|not mine|close it out)\b/.test(l)) return { type: "status", status: "dropped" };
  if (/\b(mark done|done|closed?|resolved|shipped)\b/.test(l) && !/not done/.test(l)) return { type: "status", status: "done" };
  if (/\bwait/.test(l)) return { type: "status", status: "waiting" };
  if (/\btoday\b/.test(l)) return { type: "status", status: "today" };
  if (/\b(file|create|open) (a |the )?(ticket|jira)/.test(l)) return { type: "dispatch", action: "ticket" };
  if (/\b(reply|chase|message|ping)\b/.test(l)) return { type: "dispatch", action: "reply" };
  if (/\bkeep( it)? open\b|\bstill open\b/.test(l)) return { type: "status", status: "proposed" };
  return { type: "noop" };
}

/**
 * An agent's plain-string option. Known labels map via effectFromLabel. An affirmative label
 * that maps to nothing ("Yes", "Send it", "Research it", the bare Yes/No default) used to be a
 * noop: the tap was journaled and nothing ran. Now: on an item it dispatches `work` (or
 * `verify` for check/verify) with the question as the note; with no item it goes back through
 * triage, the way command-bar follow-ups have since 10-17. An object option with only a label
 * ({ label: "Yes, send it" }, no url/action/status) maps the same way.
 */
export function agentStringEffect(label: string, prompt: string, itemId?: string): Effect {
  const yes = promisesAction(label);
  if (itemId) {
    const e = effectFromLabel(label);
    if (e.type !== "noop" || !yes) return e;
    const action: ActionKind = /\b(verify|check)\b/i.test(label) ? "verify" : "work";
    return { type: "dispatch", action, note: `Agent asked: ${prompt}\nThey answered: ${label}` };
  }
  if (yes) return { type: "triage", text: `Agent asked: ${prompt}\nThey answered: ${label}`, mode: "chat" };
  return { type: "noop" };
}

const SENT: Record<ActionKind, string> = {
  ticket: "file the ticket", reply: "send the message", email: "send the email", prep: "prep it",
  work: "do the work", verify: "check", draft: "draft it", publish: "publish it",
};

/** Verbs a drawer note opens with when it's an instruction, not background. */
const IMPERATIVE = /^(please\s+|can you\s+|could you\s+|pls\s+)?(do|go|ask|check|chase|ping|nudge|send|email|message|dm|tell|remind|draft|write|file|raise|open|close|follow[- ]?up|find|look|research|verify|confirm|schedule|book|move|assign|reply|respond|post|share|update|fix|review|dispatch|drop|kill|mark|escalate|investigate|summari[sz]e|prep|set up|sort|handle|get|make|add|create|cancel|loop in|cc)\b/i;

/**
 * Is a drawer note an instruction? The shared AFFIRMATIVE words ("do it", "send", "verify"…) not opened by a no (affirms),
 * or an imperative first word. "context:", "fyi", "note:" and "bg:" prefixes are background whatever follows.
 */
export function isInstruction(text: string): boolean {
  const t = text.trim();
  if (/^(context|fyi|note|bg|background|for context|nb)\b\s*[:\-—,]?/i.test(t)) return false;
  return affirms(t) || IMPERATIVE.test(t) || quickNote(t, { options: [] }) !== undefined || /^(done|drop)\b/i.test(t);
}

/** "Sent an agent to send the message: <title>". True as soon as dispatch() returns: the job exists, nothing has run. */
export function sentAgent(action: ActionKind, title: string) {
  return `Sent an agent to ${SENT[action] ?? action}: ${title}`;
}

/** Effects that hand work to a job that runs after the toast: an agent, the scheduler, triage, a login. */
export function runsLater(e: Effect): boolean {
  if (e.type === "multi") return e.effects.some(runsLater);
  return e.type === "dispatch" || e.type === "stoppedPicks" || e.type === "when" || e.type === "triage" || e.type === "gatewayLogin" || e.type === "accessLogin" || e.type === "sweep" || e.type === "flushJournal";
}

/** How many items a batched card's options act on (its widest multi of per-item status effects, or the picks a donePicks card acts on). 0 for a normal card. */
export function batchedItems(q: Pick<Question, "options" | "picks">): number {
  // The recheck card acts on its picks (donePicks), not a multi.
  const picked = q.options.some((o) => o.effect.type === "donePicks" || o.effect.type === "stoppedPicks" || o.effect.type === "retirePicks") ? (q.picks?.length ?? 0) : 0;
  return Math.max(picked, ...q.options.map((o) => (o.effect.type === "multi" ? o.effect.effects.filter((e) => e.type === "status" && e.itemId).length : 0)));
}

/**
 * What a note decision does, in fixed words, when it only starts work that hasn't run yet. Undefined when the
 * model's reply is safe to show (the state already changed, or it's an answer). Mirrors applyNote's order.
 * 10-16 20:44: the note job's summary said "Asking Maryna in chat…"; the reply agent started 5 s later.
 * Same class as "Booked" (ff3d07e): the model words the outcome, the outcome belongs to the job that runs it.
 */
export function queuedNote(q: Pick<Question, "options"> & Partial<Pick<Question, "picks" | "itemId" | "key">>, d: NoteDecision, title?: string): string | undefined {
  const opt = d.pick ? q.options.find((o) => o.id === d.pick) : undefined;
  if (opt && !((opt.effect.type === "open" || opt.effect.type === "focusSession") && opt.effect.keep)) return runsLater(opt.effect) ? `Noted → ${opt.label}` : undefined;
  if (title && d.dispatch?.action) return sentAgent(d.dispatch.action, title);
  const viaPicks = !title && d.dispatch?.action ? picksDispatchOption(q, d.dispatch.action) : undefined;
  if (viaPicks) return `Noted → ${viaPicks.label}`;
  const own = title ? undefined : itemlessDispatchOption(q, d);
  if (own) return `Noted → ${own.label}`;
  if (title && d.when?.trim()) return `Working out when from “${d.when.trim()}”`;
  return undefined;
}

/**
 * The option a typed "send an agent" goes through on a card with no item, when the card makes its own item on
 * dispatch (applyEffect: a `coach:` card). Prefers the option with the reader's action, else the card's first
 * dispatch option: the typed words go with it, so a "reply"-shaped ask still reaches the agent. Undefined for any
 * other itemless card (batched, recheck, meeting review: no dispatch option or no way to make an item), so
 * applyNote still says no agent started. applyEffect's eventId path is left out: no live eventId card has a
 * dispatch option, and it needs the event to still exist, which this pure check can't see.
 */
export function itemlessDispatchOption(q: Pick<Question, "options"> & Partial<Pick<Question, "key" | "itemId">>, d: NoteDecision): QuestionOption | undefined {
  const action = d.dispatch?.action;
  if (q.itemId || !action || !q.key?.startsWith("coach:")) return undefined;
  const go = q.options.filter((o) => o.effect.type === "dispatch");
  return go.find((o) => o.effect.type === "dispatch" && o.effect.action === action) ?? go[0];
}

/**
 * Short, unambiguous notes don't need pi: "drop", "done", "do it".
 * Anything longer or vaguer goes to the note reader.
 */
export function quickNote(text: string, q: Pick<Question, "options">): NoteDecision | undefined {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/, "");
  if (t.split(/\s+/).length > 4) return undefined;
  const statusOpt = (s: ItemStatus) => q.options.find((o) => setsStatus(o.effect, s))?.id ?? null;
  if (/^(drop|drop it|drop this|drop that|kill|kill it|reject|bin it|not mine|not real|not relevant)$/.test(t)) return { pick: statusOpt("dropped"), status: "dropped" };
  if (/^(done|already done|it'?s done|resolved|handled|sorted|closed)$/.test(t)) return { pick: statusOpt("done"), status: "done" };
  if (/^(do it|go|go ahead|yes,? do it|send an agent)$/.test(t)) {
    const go = q.options.find((o) => o.effect.type === "dispatch")?.id;
    return go ? { pick: go } : undefined;
  }
  return undefined;
}

const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** An away block's time: YYYY-MM-DD is local midnight (Date.parse would read it as UTC); anything else is ISO. NaN if neither. */
export function awayMs(s: string) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!d) return Date.parse(s);
  const t = new Date(+d[1]!, +d[2]! - 1, +d[3]!);
  // 2026-02-31 would roll over to March: not a date.
  return t.getMonth() === +d[2]! - 1 && t.getDate() === +d[3]! ? t.getTime() : NaN;
}

/** A meeting from the notes doc is this calendar event: same (or contained) title, close start, else read after it began. */
export function meetingMatches(m: { title: string; start?: string; at: string }, ev: Pick<CalendarEvent, "title" | "start">) {
  const a = normTitle(m.title);
  const b = normTitle(ev.title);
  if (!a || !b) return false;
  const titled = a === b || (Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a)));
  if (!titled) return false;
  const evStart = Date.parse(ev.start);
  if (m.start && !Number.isNaN(Date.parse(m.start))) return Math.abs(Date.parse(m.start) - evStart) <= 90 * 60_000;
  return Date.parse(m.at) > evStart && Date.parse(m.at) - evStart < 24 * 3600_000;
}

/** Next working morning at the start of work hours (+30 min). After midnight but before work, that's today. */
/** A pi run that died rather than answered: worth one retry. Timeouts and parse failures aren't. */
export function isCrash(e: unknown) {
  return /pi exited|pi killed|\bSIG[A-Z]+\b|server restarted/i.test(errText(e));
}

export function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function nextMorning(now = new Date()) {
  const d = new Date(now);
  if (now.getHours() >= config.sweeps.workHours[0]) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(config.sweeps.workHours[0], 30, 0, 0);
  return d;
}

function fmtDay(d: Date) {
  return d.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
