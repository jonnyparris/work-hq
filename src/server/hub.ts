// The hub owns state transitions. Everything that changes an item, a question
// or the journal goes through here so the UI stays in sync and every human
// decision lands in the journal (and from there, in memory).

import type {
  AgentReport, CalendarEvent, Effect, Item, ItemKind, ItemStatus, Job, JournalEntry, NoteDecision, Question,
  QuestionOption, ServerEvent, Snapshot, SyncState,
} from "../shared/types.ts";
import { type BulkRequest, deckGroup, deferHorizon, localDay, optionFor } from "../shared/batch.ts";
import { config, memoryOn } from "./config.ts";
import { newId, nowIso, type Store } from "./db.ts";
import { findTwin, isOpen } from "./dedupe.ts";

type Listener = (e: ServerEvent) => void;

export interface Dispatcher {
  dispatch(itemId: string, action: import("../shared/types.ts").ActionKind, note?: string): Promise<Job | undefined>;
  scheduleFromWords(itemId: string, words: string): Promise<void>;
  /** Read a typed note against the question it was typed on. Throws if the read failed; undefined = question gone. */
  readNote?(questionId: string, text: string): Promise<NoteDecision | undefined>;
  gatewayLogin?(app: string): Promise<void>;
  triage?(text: string, mode: "chat" | "pineapple" | "review"): Promise<unknown>;
}

export class Hub {
  private listeners = new Set<Listener>();
  dispatcher?: Dispatcher;

  constructor(readonly store: Store) {}

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
      // Don't let a re-import clobber a status the owner already set.
      status: opts.quiet && cur.confirmedAt ? cur.status : patch.status ?? cur.status,
      // An item keeps its own source key; other keys that reach it are aliases (Store.aliasKey).
      source: { ...cur.source, ...(patch.source ?? {}), key: cur.source.key ?? patch.source?.key },
      createdAt: cur.createdAt,
      updatedAt: nowIso(),
    };
    this.store.putItem(next);
    this.emit({ type: "item", data: next });
    return next;
  }

  /** A human-driven change. Records confirmation + journal. */
  setStatus(id: string, status: ItemStatus, note?: string, who: JournalEntry["who"] = "you") {
    const item = this.updateItem(id, { status, confirmedAt: who === "you" ? nowIso() : undefined });
    this.journal(`${label(status)}: ${item.title}${note ? ` — ${note}` : ""}`, { itemId: id, who });
    // Anything open about this item is now moot.
    if (["done", "dropped"].includes(status)) this.closeQuestionsFor(id, `item ${status}`);
    return item;
  }

  schedule(id: string, at: string, labelText: string) {
    const item = this.updateItem(id, { status: "scheduled", scheduledFor: at, when: labelText, confirmedAt: nowIso() });
    this.journal(`Scheduled ${labelText}: ${item.title}`, { itemId: id });
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
    return question;
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

  expireQuestion(id: string, reason = "expired") {
    const q = this.store.question(id);
    if (!q || q.status !== "open") return;
    q.status = "expired";
    q.answer = reason;
    q.answeredAt = nowIso();
    this.store.putQuestion(q);
    this.emit({ type: "question", data: q });
  }

  async answer(questionId: string, optionId: string, note?: string) {
    const q = this.store.question(questionId);
    if (!q || q.status !== "open") throw new Error("question not open");
    const opt = q.options.find((o) => o.id === optionId);
    if (!opt) throw new Error("no such option");
    q.status = "answered";
    q.answer = opt.label + (note ? ` — ${note}` : "");
    q.answeredAt = nowIso();
    this.store.putQuestion(q);
    this.emit({ type: "question", data: q });
    this.rememberAnswer(q, opt.label, note);
    await this.applyEffect(opt.effect, q, opt, note);
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

  async applyEffect(effect: Effect, q: Question | undefined, opt: QuestionOption | undefined, note?: string) {
    let itemId = q?.itemId;
    // Meeting questions have no item until the owner wants something done about them.
    if (!itemId && q?.eventId && effect.type === "dispatch") {
      const ev = this.store.events().find((e) => e.id === q.eventId);
      if (ev) {
        itemId = this.createItem({
          title: `Prep: ${ev.title}`,
          kind: "meeting",
          status: "doing",
          people: ev.attendees,
          detail: `${new Date(ev.start).toTimeString().slice(0, 5)}–${new Date(ev.end).toTimeString().slice(0, 5)}${ev.url ? ` · ${ev.url}` : ""}`,
          source: { type: "calendar", label: ev.title, key: `cal:prep:${ev.id}`, url: ev.url },
        }).id;
      }
    }
    switch (effect.type) {
      case "status":
        if (itemId) this.setStatus(itemId, effect.status, note ?? effect.note);
        else this.journal(`${q?.prompt} → ${opt?.label}${note ? ` — ${note}` : ""}`);
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
          await this.dispatcher.dispatch(itemId, effect.action, note?.trim() ? note : effect.note);
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
        else if (q && !itemId) this.journal(`${q.prompt} → ${opt?.label}${note ? ` — ${note}` : ""}`);
        break;
      case "noop":
        if (q && !itemId) this.journal(`${q.prompt} → ${opt?.label}${note ? ` — ${note}` : ""}`);
        break;
      case "gatewayLogin":
        void this.dispatcher?.gatewayLogin?.(effect.app);
        break;
      case "triage":
        // Not awaited: triage takes seconds and the card has already been answered.
        void this.dispatcher?.triage?.(effect.text, effect.mode)?.catch((e) => this.toast(`Triage failed again: ${errText(e)}`, "warn"));
        break;
      case "multi":
        for (const e of effect.effects) await this.applyEffect(e, q, opt, note);
        break;
    }
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
    this.journal(item ? `Note on ${item.title}: ${t}` : `Re "${q.prompt}": ${t}`, { itemId: item?.id, questionId: q.id });
    if (item) this.updateItem(item.id, { notes: [...(item.notes ?? []), { at: nowIso(), text: t }].slice(-20), confirmedAt: nowIso() });
    this.park(q, new Date(Date.now() + 15 * 60_000).toISOString());

    const quick = quickNote(t, q);
    if (quick || !this.dispatcher?.readNote) {
      await this.applyNote(q.id, quick ?? {}, t);
      return { pending: false };
    }
    const read = this.dispatcher.readNote.bind(this.dispatcher);
    void (async () => {
      let d: NoteDecision | undefined;
      try {
        d = await read(q.id, t).catch((e) => {
          if (!isCrash(e)) throw e;
          this.journal(`Note reader crashed (${errText(e)}), retrying once`, { itemId: item?.id, questionId: q.id, who: "hq" });
          return read(q.id, t);
        });
      } catch (e) {
        // Never apply an empty decision here: a crash is not "you typed background".
        this.park(q, new Date(Date.now() + 15 * 60_000).toISOString());
        this.journal(`Couldn't read note (${errText(e)}), card back in 15 min`, { itemId: item?.id, questionId: q.id, who: "hq" });
        this.toast(`Couldn't read that note (${errText(e)}). Card back in 15 min.`, "warn");
        return;
      }
      if (!d) return; // question gone
      await this.applyNote(q.id, d, t).catch((e) => this.toast(`Couldn't act on that note: ${errText(e)}`, "warn"));
    })();
    return { pending: true };
  }

  async applyNote(questionId: string, d: NoteDecision, text: string, now = new Date()) {
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
    // "Open the link" keeps the question open; that's not an answer.
    if (opt && !(opt.effect.type === "open" && opt.effect.keep)) {
      const words = opt.effect.type === "when" ? d.when?.trim() || text : note;
      await this.answer(q.id, opt.id, words);
      this.toast(d.reply ?? `Noted → ${opt.label}`, "good");
      return;
    }
    if (item && d.dispatch?.action && this.dispatcher) {
      this.closeWithNote(q, text);
      const agentNote = d.dispatch.note?.trim() || text;
      this.journal(`Dispatched ${d.dispatch.action}: ${item.title} — ${agentNote}`, { itemId: item.id });
      this.toast(d.reply ?? `On it: ${item.title}`, "good");
      await this.dispatcher.dispatch(item.id, d.dispatch.action, agentNote);
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
      this.toast(d.reply ?? `${label(d.status)}: ${item.title}`, "good");
      return;
    }
    // Context only. Keep it, ask again next working morning.
    const back = nextMorning(now);
    this.park(q, back.toISOString());
    this.toast(d.reply ? `${d.reply} Back ${fmtDay(back)}.` : `Noted. Back ${fmtDay(back)}.`, "info");
  }

  /** Hide an open question until `until`. */
  private park(q: Question, until: string) {
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
    };
    this.store.putQuestion(again);
    this.emit({ type: "question", data: again });
  }

  // ── meetings the transcript sweep has read ──────────────────────────────
  /**
   * Remember which meetings a transcript sweep covered and close their "just ended" questions:
   * once the notes are scanned, asking "anything you committed to?" is noise.
   */
  markScanned(meetings: Array<{ title: string; start?: string; url?: string }>, now = new Date()) {
    if (!meetings.length) return 0;
    const keep = now.getTime() - 3 * 86400_000;
    const at = now.toISOString();
    const list = [...this.scannedMeetings(), ...meetings.filter((m) => m.title?.trim()).map((m) => ({ title: m.title.trim(), start: m.start, at }))]
      .filter((m) => Date.parse(m.at) > keep)
      .slice(-200);
    this.store.setKv("scannedMeetings", JSON.stringify(list));
    let closed = 0;
    for (const q of this.store.questions("open")) {
      if (q.kind !== "review" || !q.eventId) continue;
      const ev = this.store.events().find((e) => e.id === q.eventId);
      if (ev && this.wasScanned(ev)) {
        this.expireQuestion(q.id, "transcript scanned");
        closed++;
      }
    }
    return closed;
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
  journal(text: string, opts: { itemId?: string; questionId?: string; who?: JournalEntry["who"] } = {}) {
    const e: JournalEntry = {
      id: newId("j"),
      at: nowIso(),
      itemId: opts.itemId,
      ...(opts.questionId ? { questionId: opts.questionId } : {}),
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

  // ── agent reports ──────────────────────────────────────────────────────
  ingestReport(r: AgentReport, fallbackSource: Item["source"]["type"] = "agent") {
    const job = r.jobId ? this.store.job(r.jobId) : undefined;
    const created: Item[] = [];
    for (const raw of r.items ?? []) {
      const status = (raw.status as ItemStatus | undefined) ?? "inbox";
      created.push(
        this.createItem({
          ...raw,
          status,
          source: { type: fallbackSource, label: job?.title, ...(raw.source ?? {}) },
        }),
      );
    }
    for (const u of r.updates ?? []) {
      if (!this.store.item(u.id)) continue;
      const { id, note, ...patch } = u;
      this.updateItem(id, patch as Partial<Item>);
      if (note || patch.status) this.journal(`${patch.status ? label(patch.status) + ": " : ""}${this.store.item(id)!.title}${note ? ` — ${note}` : ""}`, { itemId: id, who: "agent" });
    }
    for (const q of r.questions ?? []) {
      const opts = q.options?.length ? q.options : ["Yes", "No"];
      const byKey = q.itemKey ? this.store.itemBySourceKey(q.itemKey)?.id : undefined;
      const itemId = byKey ?? (q.itemId && this.store.item(q.itemId) ? q.itemId : job?.itemId);
      this.ask({
        kind: "open",
        badge: job ? "Agent asks" : undefined,
        itemId,
        prompt: q.prompt,
        context: q.context,
        priority: q.priority ?? 72,
        key: q.key ?? `agent:${hash(q.prompt)}`,
        once: q.once,
        options: opts.map((o, i) => {
          const label = typeof o === "string" ? o : o.label;
          const effect = typeof o === "string" ? (itemId ? effectFromLabel(o) : { type: "noop" as const }) : o.url && /^https?:\/\//.test(o.url) ? { type: "open" as const, url: o.url, keep: true } : o.action ? { type: "dispatch" as const, action: o.action, ...(o.note ? { note: o.note } : {}) } : o.status ? { type: "status" as const, status: o.status } : { type: "noop" as const };
          return { id: `o${i}`, label, tone: i === 0 ? "primary" : effect.type === "status" && effect.status === "dropped" ? "danger" : effect.type === "status" && effect.status === "done" ? "good" : "quiet", effect };
        }),
      });
    }
    for (const line of r.journal ?? []) this.journal(line, { who: "agent" });
    if (r.events) this.setEvents(r.events, r.eventsThrough);
    if (job) {
      const tail = r.summary ? [...job.tail, `✓ ${r.summary}`].slice(-12) : job.tail;
      this.putJob({ ...job, summary: r.summary ?? job.summary, tail, reported: true });
    }
    return { created: created.map((i) => i.id) };
  }
}

/** Only local app schemes, web links and markdown/text files; never arbitrary files or commands. */
export function openLocal(url: string) {
  const ok = /^(obsidian|https?):\/\//.test(url) || /^file:\/\/\/.+\.(md|markdown|txt)$/i.test(url);
  if (!ok) return;
  try {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
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
 * Short, unambiguous notes don't need pi: "drop", "done", "do it".
 * Anything longer or vaguer goes to the note reader.
 */
export function quickNote(text: string, q: Pick<Question, "options">): NoteDecision | undefined {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/, "");
  if (t.split(/\s+/).length > 4) return undefined;
  const statusOpt = (s: ItemStatus) => q.options.find((o) => o.effect.type === "status" && o.effect.status === s)?.id ?? null;
  if (/^(drop|drop it|drop this|drop that|kill|kill it|reject|bin it|not mine|not real|not relevant)$/.test(t)) return { pick: statusOpt("dropped"), status: "dropped" };
  if (/^(done|already done|it'?s done|resolved|handled|sorted|closed)$/.test(t)) return { pick: statusOpt("done"), status: "done" };
  if (/^(do it|go|go ahead|yes,? do it|send an agent)$/.test(t)) {
    const go = q.options.find((o) => o.effect.type === "dispatch")?.id;
    return go ? { pick: go } : undefined;
  }
  return undefined;
}

const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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

function errText(e: unknown) {
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
