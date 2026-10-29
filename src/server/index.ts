// Work HQ server. Local only (127.0.0.1). One process: HTTP + WebSocket +
// scheduler. The web app is bundled by Bun's HTML import on the fly.

import index from "../web/index.html";
import talk from "../../docs/talk/index.html";
import type { BulkRequest } from "../shared/batch.ts";
import type { ActionKind, AgentReport, ItemStatus } from "../shared/types.ts";
import { Agents } from "./agents.ts";
import { Checks } from "./checks.ts";
import { config, memoryOn } from "./config.ts";
import { resetDemo } from "./demo.ts";
import { DemoSandbox } from "./demo-sandbox.ts";
import { Store, nowIso } from "./db.ts";
import { Hub } from "./hub.ts";
import { stampConsole } from "./log-time.ts";
import { summarise } from "./load.ts";
import { MemoryClient } from "./memory.ts";
import { MemorySync } from "./memory-sync.ts";
import { Prompter, reviewUtterance } from "./prompter.ts";
import { RestartGate } from "./restart.ts";
import { Scheduler } from "./scheduler.ts";
import { dictationEngine, transcribe } from "./transcribe.ts";

stampConsole();
const store = new Store(config.dbPath);
const hub = new Hub(store);
const memory = new MemoryClient();
const memorySync = new MemorySync(hub, memory);
hub.journalFlusher = () => memorySync.flushJournal();
const agents = new Agents(hub);
const prompter = new Prompter(hub);
const checks = new Checks(hub);
const scheduler = new Scheduler(hub, prompter, agents, memorySync, checks);
const sandbox = config.demo ? undefined : new DemoSandbox();
const restart = new RestartGate({ live: () => store.liveJobs(), command: config.demo ? undefined : RestartGate.commandFor() });
scheduler.held = () => Boolean(restart.pending);

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (msg: string, status = 400) => json({ error: msg }, status);
const body = async <T>(req: Request): Promise<T> => (await req.json().catch(() => ({}))) as T;

async function handle<T>(fn: () => Promise<T> | T) {
  try {
    return json((await fn()) ?? { ok: true });
  } catch (e) {
    return bad((e as Error).message ?? String(e));
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  development: process.env.NODE_ENV !== "production" ? { hmr: true, console: true } : false,
  idleTimeout: 120,

  routes: {
    "/": index,
    "/journal": index,
    "/board": index,
    "/talk": talk,

    "/api/snapshot": { GET: () => json(hub.snapshot()) },
    // Load-average samples ([epoch ms, l1, l5, l15, action jobs running]) and a summary. ?hours=24 (max 192).
    "/api/load": {
      GET: (req) => {
        const h = Number(new URL(req.url).searchParams.get("hours") ?? 24);
        const hours = Math.min(192, Math.max(0, Number.isFinite(h) && h > 0 ? h : 24));
        const samples = hub.load.samples(Date.now() - hours * 3600_000);
        return json({ hours, maxLoad: config.pi.maxLoad, summary: summarise(samples), samples });
      },
    },

    "/api/voice": { GET: () => handle(async () => ({ engine: await dictationEngine(), silenceMs: config.voice.silenceMs })) },
    "/api/transcribe": {
      POST: (req) => handle(async () => transcribe(new Uint8Array(await req.arrayBuffer()))),
    },

    "/api/items": {
      POST: (req) =>
        handle(async () => {
          const b = await body<{ title: string; kind?: any; status?: ItemStatus; detail?: string }>(req);
          if (!b.title?.trim()) throw new Error("title required");
          const item = hub.createItem({ ...b, status: b.status ?? "today", source: { type: "manual" }, confirmedAt: nowIso() });
          hub.journal(`Added: ${item.title}`, { itemId: item.id });
          return item;
        }),
    },

    "/api/items/:id": {
      GET: (req) =>
        handle(() => {
          const item = hub.store.item(req.params.id);
          if (!item) throw new Error("no such item");
          return item;
        }),
      PATCH: (req) =>
        handle(async () => {
          const b = await body<{ status?: ItemStatus; note?: string; title?: string; detail?: string; kind?: any; project?: string }>(req);
          const { status, note, ...rest } = b;
          let item = hub.store.item(req.params.id);
          if (!item) throw new Error("no such item");
          if (Object.keys(rest).length) {
            item = hub.updateItem(item.id, { ...rest, confirmedAt: nowIso() });
            hub.journal(`Corrected: ${item.title}${rest.kind ? ` (now a ${rest.kind})` : ""}`, { itemId: item.id });
          }
          if (status) {
            if (note?.trim()) item = hub.updateItem(item.id, { notes: [...(item.notes ?? []), { at: nowIso(), text: note.trim() }].slice(-20) });
            return hub.setStatus(item.id, status, note);
          }
          // No status: an instruction goes to the note reader like a card note; background stays on the item.
          if (note?.trim()) await hub.itemNote(item.id, note);
          return hub.store.item(item.id) ?? item;
        }),
    },

    // "Explain simply" in the drawer: waits for the plain-English read (a few seconds, no tools) and returns the item.
    "/api/items/:id/explain": { POST: (req) => handle(() => agents.explainItem(req.params.id)) },

    "/api/items/:id/dispatch": {
      POST: (req) =>
        handle(async () => {
          const b = await body<{ action: ActionKind; note?: string }>(req);
          const item = hub.store.item(req.params.id);
          if (!item) throw new Error("no such item");
          hub.journal(`Dispatched ${b.action}: ${item.title}${b.note ? ` — ${b.note}` : ""}`, { itemId: item.id });
          return agents.dispatch(item.id, b.action, b.note);
        }),
    },

    "/api/items/:id/schedule": {
      POST: (req) =>
        handle(async () => {
          const b = await body<{ at: string; label?: string }>(req);
          return hub.schedule(req.params.id, b.at, b.label ?? new Date(b.at).toLocaleString());
        }),
    },

    // "Save note" (cmd+enter): the note is acted on, not just filed. See Hub.note.
    "/api/questions/:id/note": {
      POST: (req) =>
        handle(async () => {
          const b = await body<{ text: string }>(req);
          const q = hub.store.question(req.params.id);
          if (!q) throw new Error("no such question");
          if (!b.text?.trim()) throw new Error("empty note");
          // After a meeting the note *is* the answer: triage it and close the question.
          if (q.kind === "review") {
            const none = q.options.find((o) => o.id === "none") ?? q.options.at(-1)!;
            await hub.answer(q.id, none.id, b.text.trim());
            void agents.triage(reviewUtterance(q, b.text.trim()), "review");
            return { pending: true };
          }
          return hub.note(q.id, b.text);
        }),
    },

    "/api/questions/:id/answer": {
      POST: (req) =>
        handle(async () => {
          const b = await body<{ optionId: string; note?: string; itemIds?: string[]; picks?: string[] }>(req);
          const q = hub.store.question(req.params.id);
          if (!q) throw new Error("no such question");
          // Option side effects (plan, flush, scan, look) are Effect types run by hub.applyEffect.
          const answered = await hub.answer(q.id, b.optionId, b.note, { journalOpen: true, itemIds: b.itemIds, picks: b.picks });
          if (q.kind === "review" && b.note) void agents.triage(reviewUtterance(q, b.note), "review");
          return answered;
        }),
    },

    "/api/questions/bulk": {
      POST: (req) =>
        handle(async () => {
          const b = await body<BulkRequest>(req);
          if (!["dispatch", "done", "drop", "dismiss", "defer"].includes(b.op)) throw new Error("unknown op");
          const r = await hub.bulk(b);
          if (r.count) hub.toast(`${r.count} handled${r.skipped ? ` · ${r.skipped} didn't fit` : ""}`, "good");
          return r;
        }),
    },

    "/api/say": {
      POST: (req) =>
        handle(async () => {
          const b = await body<{ text: string; mode?: "chat" | "pineapple" | "review"; voice?: boolean }>(req);
          if (!b.text?.trim()) throw new Error("say something");
          const mode = b.mode ?? "chat";
          if (mode !== "pineapple") hub.journal(b.text.trim(), { who: "you" });
          return agents.triage(b.text.trim(), mode);
        }),
    },

    "/api/journal": {
      // A line from an agent outside Work HQ (e.g. the learn skill) — journal only, no triage.
      POST: (req) =>
        handle(async () => {
          const b = await body<{ text: string }>(req);
          if (!b.text?.trim()) throw new Error("text required");
          hub.journal(b.text.trim().slice(0, 500), { who: "agent" });
          return { ok: true };
        }),
    },

    "/api/agent/report": {
      POST: (req) =>
        handle(async () => {
          const r = await body<AgentReport>(req);
          return hub.ingestReport(r, "agent");
        }),
    },

    "/api/jobs/:id/focus": { POST: (req) => handle(() => ({ ok: agents.focus(req.params.id) })) },
    "/api/jobs/:id/cancel": { POST: (req) => handle(() => agents.cancel(req.params.id)) },
    // "Boss check" in the Agents panel: one agent verifies every open agent card and live session, closes the stale ones.
    "/api/agents/boss": { POST: () => handle(async () => ({ job: (await agents.bossCheck()) ?? null })) },

    "/api/sync/:name": {
      POST: (req) =>
        handle(async () => {
          const name = req.params.name as "memory" | "journal" | "calendar" | "transcripts" | "posts";
          if (!["memory", "journal", "calendar", "transcripts", "posts"].includes(name)) throw new Error("unknown sync");
          const since = new URL(req.url).searchParams.get("since") ?? undefined;
          void scheduler.run(name, since).catch((e) => hub.toast(`${name}: ${e.message}`, "warn"));
          return { started: name };
        }),
    },

    "/api/tick": { POST: () => handle(() => prompter.tick()) },
    // "Recheck" chip / `whq recheck`: look up every open item's MRs, PRs and tickets now, one card for what landed.
    // Fire and forget, like the sweeps: a slow glab / JIRA pass can outlast the 120-s idle timeout. The result
    // arrives as a toast, the chip's summary and (if anything landed) the card. recheck() records its own failures.
    "/api/recheck": {
      POST: () =>
        handle(() => {
          void prompter.recheck().catch(() => {});
          return { started: "recheck" };
        }),
    },

    // `whq land` asks here instead of kickstarting: restart once no headless job would die (src/server/restart.ts).
    // 409 = not this server's checkout, or no restart command configured: the caller runs its own.
    "/api/restart": {
      POST: async (req) => {
        const b = await body<{ repo?: string; reason?: string }>(req);
        if (!b.repo || !restart.handles(b.repo)) return bad("not this server's checkout", 409);
        return json(restart.request(b.reason ?? "landing"));
      },
    },

    // Demo toggle. The live server starts the sandbox (a separate process on its own port and
    // database) and the browser hops over; "Exit demo" comes back here and stops it.
    "/api/demo/start": {
      POST: (req) => handle(async () => {
        if (!sandbox) throw new Error("already in demo mode");
        return { url: await sandbox.start(new URL(req.url).searchParams.get("reset") === "1") };
      }),
    },
    "/api/demo/stop": { POST: () => handle(() => ({ stopped: sandbox?.stop() ?? false })) },
    "/api/demo/reset": {
      POST: () => handle(() => {
        if (!config.demo) throw new Error("not in demo mode");
        resetDemo(hub);
        prompter.tick();
        hub.toast("Fresh demo day loaded", "good");
      }),
    },
  },

  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" && srv.upgrade(req)) return undefined;
    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      ws.subscribe("hq");
      ws.send(JSON.stringify({ type: "snapshot", data: hub.snapshot() }));
    },
    message() {},
    close(ws) {
      ws.unsubscribe("hq");
    },
  },
});

hub.subscribe((e) => {
  // While the demo is on screen, real notifications stay quiet.
  if (e.type === "notify" && sandbox?.running) return;
  server.publish("hq", JSON.stringify(e));
});
scheduler.start();
// Warm triage workers a few seconds after boot, off the startup path.
setTimeout(() => void agents.warm().catch((e) => console.warn(`[pi] warm-up failed: ${(e as Error).message}`)), 3000);

if (config.demo) console.log(`\n  ◆ DEMO MODE — made-up data, scripted agents, nothing real touched`);
console.log(`\n  ◆ Work HQ  →  http://localhost:${server.port}\n`);
console.log(`    config: ${config.file ?? "defaults (no config file — see work-hq.config.example.json)"}`);
console.log(`    owner: ${config.owner.name} · memory: ${memoryOn() ? `MCP (${config.memory.write ? "read+write" : "READ-ONLY"})` : "OFF (set memory.url + token)"} · cmux: ${config.cmux.bin ? "yes" : "no"} · model: ${config.pi.model || "pi default"}`);
console.log(`    sweeps: ${config.sweeps.enabled ? `on, ${config.sweeps.workHours.join("–")}h` : "off"} · db: ${config.dbPath}\n`);

if (config.demo) setTimeout(() => prompter.tick(), 300);

const shutdown = () => {
  sandbox?.stop();
  void agents.stop(); // closes worker stdin; pi exits on its own even if we don't wait
};
process.on("exit", shutdown);
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  shutdown();
  scheduler.stop();
  process.exit(0);
});
