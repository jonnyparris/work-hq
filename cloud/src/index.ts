// Work HQ cloud — scaffold. Not deployed; see ../README.md.
// Types are declared loosely so this compiles without pulling workers-types into the Bun app.

import { DurableObject } from "cloudflare:workers";

interface Env {
  HQ: DurableObjectNamespace<WorkHQ>;
  SYNC_TOKEN: string;
  /** Where "while you're away" nudges go: any endpoint that accepts { text } JSON (Slack/Chat webhook, relay…). */
  NOTIFY_WEBHOOK_URL: string;
  NOTIFY_WEBHOOK_TOKEN?: string;
  OWNER_ID: string;
}

const STALE_MS = 30 * 60_000;

export class WorkHQ extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS docs (kind TEXT, id TEXT, doc TEXT, updated TEXT, PRIMARY KEY (kind, id));
      CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, question_id TEXT, option_id TEXT, note TEXT, at TEXT);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  /** Laptop → cloud. Upserts documents and records the heartbeat. */
  async sync(delta: { items?: any[]; questions?: any[]; journal?: any[] }) {
    const now = new Date().toISOString();
    for (const [kind, list] of Object.entries(delta)) {
      for (const d of (list as any[]) ?? []) {
        this.sql.exec("INSERT OR REPLACE INTO docs VALUES (?, ?, ?, ?)", kind, d.id, JSON.stringify(d), now);
      }
    }
    this.sql.exec("INSERT OR REPLACE INTO kv VALUES ('heartbeat', ?)", now);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + STALE_MS);
    return { ok: true };
  }

  async answersSince(since: string) {
    return this.sql.exec("SELECT * FROM answers WHERE at > ? ORDER BY at", since).toArray();
  }

  /** Laptop gone quiet? Ask the owner wherever they are instead. */
  async alarm() {
    const hb = this.sql.exec("SELECT v FROM kv WHERE k = 'heartbeat'").toArray()[0]?.v as string | undefined;
    if (hb && Date.now() - Date.parse(hb) > STALE_MS) {
      const open = this.sql
        .exec("SELECT doc FROM docs WHERE kind = 'questions'")
        .toArray()
        .map((r) => JSON.parse(r.doc as string))
        .filter((q) => q.status === "open")
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 3);
      const sentKey = `sent:${new Date().toISOString().slice(0, 13)}`;
      const already = this.sql.exec("SELECT v FROM kv WHERE k = ?", sentKey).toArray().length;
      if (open.length && !already) {
        // TODO: interactive card with buttons; plain text for now.
        await fetch(this.env.NOTIFY_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.env.NOTIFY_WEBHOOK_TOKEN ? { authorization: `Bearer ${this.env.NOTIFY_WEBHOOK_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            text: `Work HQ has ${open.length} question(s) while you're away:\n${open.map((q, i) => `${i + 1}. ${q.prompt}`).join("\n")}`,
          }),
        });
        this.sql.exec("INSERT OR REPLACE INTO kv VALUES (?, '1')", sentKey);
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + STALE_MS);
  }
}

export default {
  async fetch(req: Request, env: Env) {
    if (req.headers.get("authorization") !== `Bearer ${env.SYNC_TOKEN}`) return new Response("no", { status: 401 });
    const hq = env.HQ.get(env.HQ.idFromName(env.OWNER_ID || "me"));
    const url = new URL(req.url);
    if (url.pathname === "/sync" && req.method === "POST") return Response.json(await hq.sync(await req.json()));
    if (url.pathname === "/answers") return Response.json(await hq.answersSince(url.searchParams.get("since") ?? ""));
    return new Response("Not found", { status: 404 });
  },
};
