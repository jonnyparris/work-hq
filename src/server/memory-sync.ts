// Two directions:
//   import  — memory (R2) → items. active-todos + latest improvement proposals.
//   flush   — journal → memory/workload/work-hq-journal.md, so the nightly
//             reflection and daily briefing see the owner's corrections first-hand.

import type { Item, JournalEntry } from "../shared/types.ts";
import { config } from "./config.ts";
import { nowIso } from "./db.ts";
import type { Hub } from "./hub.ts";
import type { MemoryClient } from "./memory.ts";
import { parseActiveTodos, parseProposals, type ParsedItem } from "./parse.ts";
import { template } from "./prompts.ts";


export class MemorySync {
  constructor(private hub: Hub, private memory: MemoryClient) {}

  async importAll() {
    const s = { ...this.hub.store.syncState("memory"), lastRunAt: nowIso() };
    try {
      const todos = await this.memory.read(config.memory.todosPath);
      const parsed: ParsedItem[] = todos ? parseActiveTodos(todos, "active-todos", config.projects) : [];
      let proposalsLabel = "";
      const plans = (await this.memory.list(config.memory.proposalsDir))
        .filter((f) => /\d{4}-\d{2}-\d{2}.*improvement-proposals\.md$/.test(f.path))
        .sort((a, b) => a.path.localeCompare(b.path));
      const latest = plans.at(-1);
      if (latest) {
        const md = await this.memory.read(latest.path);
        const date = /(\d{4}-\d{2}-\d{2})/.exec(latest.path)![1]!;
        proposalsLabel = date;
        if (md) parsed.push(...parseProposals(md, date));
      }
      const seen = this.upsert(parsed);
      const dropped = this.retire(seen);
      this.hub.putSync({ ...s, lastOkAt: nowIso(), error: undefined, cursor: `${parsed.length} items · proposals ${proposalsLabel}` });
      return { imported: parsed.length, dropped };
    } catch (e) {
      this.hub.putSync({ ...s, error: String((e as Error).message ?? e) });
      throw e;
    }
  }

  private upsert(parsed: ParsedItem[]): Set<string> {
    const seen = new Set<string>();
    for (const p of parsed) {
      seen.add(p.key);
      const existing = this.hub.store.itemBySourceKey(p.key);
      const patch: Partial<Item> & { title: string } = {
        title: p.title,
        detail: p.detail,
        kind: existing?.kind ?? p.kind,
        project: p.project,
        links: p.links.length ? p.links : undefined,
        confidence: p.flags.lowConfidence ? 0.5 : 0.8,
        signals: p.flags,
        source: {
          type: "memory",
          label: p.section.startsWith("Proposals") ? p.section : `active-todos · ${p.section}`,
          key: p.key,
        },
      };
      if (existing) {
        // Memory is allowed to refresh the text, never to undo the owner's call.
        this.hub.updateItem(existing.id, patch, { quiet: true });
      } else {
        this.hub.createItem({ ...patch, status: "proposed" });
      }
    }
    return seen;
  }

  /**
   * Items memory no longer lists. Unconfirmed ones quietly retire.
   * Proposals are exempt: only the latest proposals file is read, so an older
   * proposal vanishing from memory is not a signal. It stays until the owner answers it.
   */
  private retire(seen: Set<string>) {
    let n = 0;
    for (const item of this.hub.store.items()) {
      const key = item.source.key;
      if (!key?.startsWith("memory:") || seen.has(key)) continue;
      if (key.startsWith("memory:proposals:")) continue;
      if (item.confirmedAt || !["proposed", "inbox"].includes(item.status)) continue;
      this.hub.updateItem(item.id, { status: "dropped" });
      this.hub.journal(`No longer in memory, retired: ${item.title}`, { itemId: item.id, who: "hq" });
      n++;
    }
    return n;
  }

  // ── journal → memory ───────────────────────────────────────────────────
  async flushJournal() {
    const pending = this.hub.store.unsyncedJournal();
    if (!pending.length) return { written: 0 };
    if (!config.memory.write) {
      this.hub.putSync({ ...this.hub.store.syncState("journal"), lastRunAt: nowIso(), error: "memory writes off (sandbox)" });
      return { written: 0 };
    }
    const s = { ...this.hub.store.syncState("journal"), lastRunAt: nowIso() };
    try {
      const current = (await this.memory.read(config.memory.journalPath)) ?? "";
      const { body, overflow } = mergeJournal(current, pending, (id) => this.hub.store.item(id));
      await this.memory.write(config.memory.journalPath, body);
      if (overflow) {
        const archivePath = config.memory.journalPath.replace(/\.md$/, `-archive-${new Date().toISOString().slice(0, 7)}.md`);
        const prev = (await this.memory.read(archivePath)) ?? `---\ntags: [workload, work-hq, journal, archive]\n---\n\n# Work HQ Journal — archive\n`;
        await this.memory.write(archivePath, `${prev.trimEnd()}\n\n${overflow}\n`);
      }
      for (const e of pending) this.hub.store.putJournal({ ...e, synced: true });
      this.hub.putSync({ ...s, lastOkAt: nowIso(), error: undefined, cursor: `${pending.length} entries` });
      return { written: pending.length };
    } catch (e) {
      this.hub.putSync({ ...s, error: String((e as Error).message ?? e) });
      throw e;
    }
  }
}

/** Header of the journal file in memory. Override with prompts/journal-header.md. */
export const JOURNAL_HEADER = `---
tags: [core, workload, work-hq, journal]
---

${template("journal-header")}
`;

const MAX_BYTES = 20_000; // stay well under the embedding ceiling (see active-todos warning)

export function mergeJournal(
  current: string,
  entries: JournalEntry[],
  itemOf: (id: string) => Item | undefined,
): { body: string; overflow?: string } {
  // Existing day sections, newest first.
  const days = new Map<string, string[]>();
  const order: string[] = [];
  const sectionRe = /^## (\d{4}-\d{2}-\d{2})\s*$/gm;
  const marks = [...current.matchAll(sectionRe)];
  marks.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : current.length;
    const lines = current.slice(start, end).split("\n").filter((l) => l.startsWith("- "));
    days.set(m[1]!, lines);
    order.push(m[1]!);
  });
  for (const e of entries) {
    const d = new Date(e.at);
    const day = localDate(d);
    const time = d.toTimeString().slice(0, 5);
    const item = e.itemId ? itemOf(e.itemId) : undefined;
    const ref = item?.links?.find((l) => /^https?:/.test(l) && !/calendar\.google/.test(l));
    const line = `- ${time} · ${e.who} · ${e.text.replace(/\n+/g, " ")}${ref ? ` ([ref](${ref}))` : ""}`;
    if (!days.has(day)) {
      days.set(day, []);
      order.push(day);
    }
    days.get(day)!.push(line);
  }
  order.sort().reverse();
  const render = (ds: string[]) => ds.map((d) => `## ${d}\n\n${days.get(d)!.join("\n")}\n`).join("\n");
  let keep = [...order];
  let body = `${JOURNAL_HEADER}\n${render(keep)}`;
  const spill: string[] = [];
  while (new TextEncoder().encode(body).length > MAX_BYTES && keep.length > 1) {
    spill.unshift(keep.pop()!);
    body = `${JOURNAL_HEADER}\n${render(keep)}`;
  }
  return { body, overflow: spill.length ? render(spill.reverse()) : undefined };
}

export function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
