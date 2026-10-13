// SQLite store. Each entity is a JSON document with a few indexed columns —
// the shapes are still moving, and a document store keeps migrations cheap.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CalendarEvent, Item, Job, JournalEntry, Question, SyncState,
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
      -- Extra source keys that point at an existing item (a duplicate from another source was merged into it).
      CREATE TABLE IF NOT EXISTS item_keys (key TEXT PRIMARY KEY, item_id TEXT NOT NULL);
    `);
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
  job(id: string) {
    return this.one<Job>("jobs", id);
  }
  putJob(job: Job) {
    this.put("jobs", job.id, job.status, job.finishedAt ?? job.startedAt ?? job.createdAt, job);
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
