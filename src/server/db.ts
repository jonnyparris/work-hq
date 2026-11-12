// SQLite store. Each entity is a JSON document with a few indexed columns —
// the shapes are still moving, and a document store keeps migrations cheap.

import type { LoadSample } from "./load.ts";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CalendarEvent, Effect, Item, Job, JournalEntry, Question, SyncState,
} from "../shared/types.ts";

type Table = "items" | "questions" | "jobs" | "events" | "journal" | "sync";

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, status TEXT, source_key TEXT, updated TEXT, doc TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS items_source_key ON items(source_key) WHERE source_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, status TEXT, key TEXT, updated TEXT, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS questions_key ON questions(key, status);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT, updated TEXT, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, status TEXT, updated TEXT, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, status TEXT, updated TEXT, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync (id TEXT PRIMARY KEY, status TEXT, updated TEXT, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS load (t INTEGER PRIMARY KEY, l1 REAL, l5 REAL, l15 REAL, jobs INTEGER);
      -- Extra source keys that point at an existing item (a duplicate from another source was merged into it).
      CREATE TABLE IF NOT EXISTS item_keys (key TEXT PRIMARY KEY, item_id TEXT NOT NULL);
    `);
    this.upgradeRouteEffects();
  }

  /**
   * Until 10-20 plan/flush/scan/look were noop options the answer route special-cased by id.
   * That code now lives in hub.applyEffect behind real Effect types, so an open card asked
   * before the change would do nothing when tapped. Rewrite those effects in place. Idempotent;
   * delete once no pre-10-20 card can still be open. Also gives a pre-10-21 focusSession its `keep`.
   */
  private upgradeRouteEffects() {
    const legacy = (kind: string, id: string): Effect | undefined =>
      kind === "plan" && id === "plan" ? { type: "commitPlan" }
      : kind === "wrap" && id === "flush" ? { type: "flushJournal" }
      : kind === "review" && id === "scan" ? { type: "sweep", name: "transcripts" }
      : id === "look" ? { type: "focusSession", keep: true }
      : undefined;
    for (const q of this.questions("open")) {
      let changed = false;
      const options = q.options.map((o) => {
        const e: Effect | undefined =
          o.effect.type === "noop" ? legacy(q.kind, o.id)
          // 10-21: "Show me the session" keeps the card open; cards drawn before that close it and strand the item on doing.
          : o.effect.type === "focusSession" && !o.effect.keep ? { type: "focusSession", keep: true }
          : undefined;
        if (!e) return o;
        changed = true;
        return { ...o, effect: e };
      });
      if (changed) this.putQuestion({ ...q, options });
    }
  }

  private all<T>(table: Table, where = "", ...params: any[]): T[] {
    return this.db
      .query(`SELECT doc FROM ${table} ${where}`)
      .all(...params)
      .map((r: any) => JSON.parse(r.doc) as T);
  }

  private one<T>(table: Table, id: string): T | undefined {
    const r: any = this.db.query(`SELECT doc FROM ${table} WHERE id = ?`).get(id);
    return r ? (JSON.parse(r.doc) as T) : undefined;
  }

  // ── items ──────────────────────────────────────────────────────────────
  items(): Item[] {
    return this.all<Item>("items", "ORDER BY updated DESC");
  }
  item(id: string) {
    return this.one<Item>("items", id);
  }
  /** By its own source key, or by a key merged into it (see aliasKey). */
  itemBySourceKey(key: string): Item | undefined {
    // A merged key wins: the item that owned it was dropped as a duplicate of the alias target.
    const a: any = this.db.query("SELECT item_id FROM item_keys WHERE key = ?").get(key);
    const aliased = a ? this.item(a.item_id) : undefined;
    if (aliased) return aliased;
    const r: any = this.db.query("SELECT doc FROM items WHERE source_key = ?").get(key);
    return r ? JSON.parse(r.doc) : undefined;
  }
  aliasKey(key: string, itemId: string) {
    this.db.query("INSERT INTO item_keys (key, item_id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET item_id=excluded.item_id").run(key, itemId);
  }
  aliasesFor(itemId: string): string[] {
    return this.db.query("SELECT key FROM item_keys WHERE item_id = ?").all(itemId).map((r: any) => r.key);
  }
  putItem(item: Item) {
    this.db
      .query(`INSERT INTO items (id, status, source_key, updated, doc) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET status=excluded.status, source_key=excluded.source_key,
              updated=excluded.updated, doc=excluded.doc`)
      .run(item.id, item.status, item.source.key ?? null, item.updatedAt, JSON.stringify(item));
    return item;
  }

  // ── questions ──────────────────────────────────────────────────────────
  questions(status?: Question["status"]): Question[] {
    return status
      ? this.all<Question>("questions", "WHERE status = ? ORDER BY updated DESC", status)
      : this.all<Question>("questions", "ORDER BY updated DESC LIMIT 400");
  }
  question(id: string) {
    return this.one<Question>("questions", id);
  }
  /** One item's open cards. Filters in SQL, so only that item's docs are parsed (Hub.closeStateCards runs on each dispatch). */
  openQuestionsFor(itemId: string): Question[] {
    return this.db
      .query("SELECT doc FROM questions WHERE status = 'open' AND json_extract(doc, '$.itemId') = ?")
      .all(itemId)
      .map((r: any) => JSON.parse(r.doc));
  }
  openQuestionByKey(key: string): Question | undefined {
    const r: any = this.db.query("SELECT doc FROM questions WHERE key = ? AND status = 'open'").get(key);
    return r ? JSON.parse(r.doc) : undefined;
  }
  /** Most recent answered question for a key — used to avoid re-asking too soon. */
  lastAnswered(key: string): Question | undefined {
    const r: any = this.db
      .query("SELECT doc FROM questions WHERE key = ? AND status != 'open' ORDER BY updated DESC LIMIT 1")
      .get(key);
    return r ? JSON.parse(r.doc) : undefined;
  }
  /** Closed (answered or expired) questions whose key starts with `prefix`, newest first. */
  closedByPrefix(prefix: string, limit = 50): Question[] {
    const esc = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.db
      .query("SELECT doc FROM questions WHERE key LIKE ? ESCAPE '\\' AND status != 'open' ORDER BY updated DESC LIMIT ?")
      .all(`${esc}%`, limit)
      .map((r: any) => JSON.parse(r.doc));
  }
  /** Answered questions whose key starts with `prefix`, answered at or after `since` (ISO). */
  answeredByPrefix(prefix: string, since: string): Question[] {
    const esc = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.db
      .query("SELECT doc FROM questions WHERE key LIKE ? ESCAPE '\\' AND status = 'answered' AND updated >= ?")
      .all(`${esc}%`, since)
      .map((r: any) => JSON.parse(r.doc));
  }
  /** Answered questions about `itemId` (any key), answered at or after `since` (ISO). */
  answeredForItem(itemId: string, since: string): Question[] {
    return this.db
      .query("SELECT doc FROM questions WHERE json_extract(doc, '$.itemId') = ? AND status = 'answered' AND updated >= ?")
      .all(itemId, since)
      .map((r: any) => JSON.parse(r.doc));
  }
  putQuestion(q: Question) {
    this.db
      .query(`INSERT INTO questions (id, status, key, updated, doc) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET status=excluded.status, key=excluded.key,
              updated=excluded.updated, doc=excluded.doc`)
      .run(q.id, q.status, q.key, q.answeredAt ?? q.createdAt, JSON.stringify(q));
    return q;
  }

  // ── generic docs ───────────────────────────────────────────────────────
  private put(table: Table, id: string, status: string, updated: string, doc: unknown) {
    this.db
      .query(`INSERT INTO ${table} (id, status, updated, doc) VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated=excluded.updated, doc=excluded.doc`)
      .run(id, status, updated, JSON.stringify(doc));
  }

  jobs(limit = 60): Job[] {
    return this.all<Job>("jobs", `ORDER BY updated DESC LIMIT ${limit}`);
  }
  private lastJobAt?: Map<string, string>;
  /**
   * item id → when the latest job on it was created. Every job, not just the last `jobs()` page. Read on the 30 s
   * prompter tick (stale-proposals.ts): the full scan runs once, then putJob keeps the map current. Jobs are never
   * deleted, except by the demo reset (forgetJobCache).
   */
  lastJobAtByItem(): ReadonlyMap<string, string> {
    if (!this.lastJobAt) {
      const rows = this.db
        .query("SELECT json_extract(doc, '$.itemId') AS item, MAX(json_extract(doc, '$.createdAt')) AS at FROM jobs WHERE json_extract(doc, '$.itemId') IS NOT NULL GROUP BY item")
        .all() as Array<{ item: string; at: string | null }>;
      this.lastJobAt = new Map(rows.filter((r) => r.at).map((r) => [r.item, r.at!]));
    }
    return this.lastJobAt;
  }
  /** Every job of one kind, not just the last `jobs()` page. A full scan: boot-time one-offs only. */
  jobsOfKind(kind: Job["kind"]): Job[] {
    return this.all<Job>("jobs", "WHERE json_extract(doc, '$.kind') = ?", kind);
  }
  /** Anything that deletes jobs behind putJob's back (the demo reset) calls this. */
  forgetJobCache() {
    this.lastJobAt = undefined;
  }
  /** Jobs still in flight (queued, running or blocked). Not limited, unlike `jobs()`. */
  liveJobs(): Job[] {
    return this.all<Job>("jobs", "WHERE status IN ('queued', 'running', 'blocked')");
  }
  job(id: string) {
    return this.one<Job>("jobs", id);
  }
  putJob(job: Job) {
    this.put("jobs", job.id, job.status, job.finishedAt ?? job.startedAt ?? job.createdAt, job);
    if (this.lastJobAt && job.itemId && job.createdAt && job.createdAt > (this.lastJobAt.get(job.itemId) ?? "")) this.lastJobAt.set(job.itemId, job.createdAt);
    return job;
  }

  events(): CalendarEvent[] {
    return this.all<CalendarEvent>("events", "ORDER BY updated ASC");
  }
  /** Replace every event whose local start day is in [from, to] (YYYY-MM-DD). */
  replaceEvents(from: string, to: string, events: CalendarEvent[]) {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM events WHERE substr(updated, 1, 10) BETWEEN ? AND ?").run(from, to);
      for (const e of events) this.put("events", e.id, "", e.start, e);
    });
    tx();
  }

  journal(limit = 200): JournalEntry[] {
    return this.all<JournalEntry>("journal", `ORDER BY updated DESC LIMIT ${limit}`);
  }
  unsyncedJournal(): JournalEntry[] {
    return this.all<JournalEntry>("journal", "WHERE status = 'pending' ORDER BY updated ASC");
  }
  putJournal(e: JournalEntry) {
    this.put("journal", e.id, e.synced ? "synced" : "pending", e.at, e);
    return e;
  }

  syncStates(): SyncState[] {
    return this.all<SyncState>("sync");
  }
  syncState(name: string): SyncState {
    return this.one<SyncState>("sync", name) ?? { name };
  }
  putSync(s: SyncState) {
    this.put("sync", s.name, s.error ? "error" : "ok", s.lastRunAt ?? "", s);
    return s;
  }

  /** Load-average samples (src/server/load.ts), oldest first. */
  loadSamples(sinceMs = 0): LoadSample[] {
    return this.db.query("SELECT t, l1, l5, l15, jobs FROM load WHERE t >= ? ORDER BY t").values(sinceMs) as LoadSample[];
  }
  putLoad(s: LoadSample, keepSinceMs: number) {
    this.db.query("INSERT OR REPLACE INTO load (t, l1, l5, l15, jobs) VALUES (?, ?, ?, ?, ?)").run(...s);
    this.db.query("DELETE FROM load WHERE t < ?").run(keepSinceMs);
  }

  kv(k: string): string | undefined {
    const r: any = this.db.query("SELECT v FROM kv WHERE k = ?").get(k);
    return r?.v;
  }
  setKv(k: string, v: string) {
    this.db.query("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
  }
}

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
