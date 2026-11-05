// Two directions:
//   import  — memory (R2) → items. active-todos + latest improvement proposals + learn proposals.
//   flush   — journal → memory/workload/work-hq-journal.md, so the nightly
//             reflection and daily briefing see the owner's corrections first-hand.

import type { Item, JournalEntry } from "../shared/types.ts";
import { config } from "./config.ts";
import { nowIso } from "./db.ts";
import type { Hub } from "./hub.ts";
import type { MemoryClient } from "./memory.ts";
import { resolve } from "node:path";
import { parseActiveTodos, parseCoaching, parseLearnProposals, parseProposals, plain, type ParsedItem } from "./parse.ts";
import { ClairicDeadlines } from "./deadlines.ts";
import { openUrl, template } from "./prompts.ts";


export class MemorySync {
  constructor(
    private hub: Hub,
    private memory: MemoryClient,
    private clairic: ClairicDeadlines | undefined = clairicFromConfig(),
  ) {}

  async importAll() {
    const s = { ...this.hub.store.syncState("memory"), lastRunAt: nowIso() };
    try {
      const todos = await this.memory.read(config.memory.todosPath);
      const parsed: ParsedItem[] = todos ? parseActiveTodos(todos, "active-todos", config.projects) : [];
      const blocker = retireBlocker(todos, parsed.length);
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
        // The coaching block rides in the same file. If the newest one lacks it, look back two more.
        for (const f of plans.slice(-3).reverse()) {
          const text = f === latest ? md : await this.memory.read(f.path);
          const c = text ? parseCoaching(text, /(\d{4}-\d{2}-\d{2})/.exec(f.path)![1]!) : undefined;
          if (!c) continue;
          this.hub.setCoaching({ ...c, file: f.path, url: openUrl(resolve(config.workspace.dir, f.path)) });
          break;
        }
      }
      const learn = await this.memory.read(config.memory.learnProposalsPath).catch(() => undefined);
      if (learn) {
        const lp = parseLearnProposals(learn);
        parsed.push(...lp);
        if (lp.length) proposalsLabel += ` + ${lp.length} learn`;
      }
      const extra = await this.fillDeadlines(parsed);
      const seen = this.upsert(parsed);
      // An empty or broken file says nothing about which to-dos are gone: don't retire on it.
      const dropped = blocker ? 0 : this.retire(seen);
      this.hub.dedupeExisting();
      this.markMergedProposals(parsed);
      // A blocked retire is not a good run: keep the last good time, as other syncs do on failure.
      this.hub.putSync({ ...s, lastOkAt: blocker ? s.lastOkAt : nowIso(), error: blocker, cursor: `${parsed.length} items · proposals ${proposalsLabel}${extra}` });
      return { imported: parsed.length, dropped };
    } catch (e) {
      this.hub.putSync({ ...s, error: String((e as Error).message ?? e) });
      throw e;
    }
  }

  /** Second pass on to-dos the parser left undated (Clairic). Sets flags.dueDate in place; returns a cursor note. */
  private async fillDeadlines(parsed: ParsedItem[]): Promise<string> {
    if (!this.clairic) return "";
    const undated = parsed.filter((p) => !p.flags.dueDate && !p.key.startsWith("memory:proposals:"));
    const found = await this.clairic.fill(undated.map((p) => ({ key: p.key, text: plain(`${p.title}. ${p.detail}`) })));
    for (const p of undated) {
      const d = found.get(p.key);
      if (d) p.flags = { ...p.flags, dueDate: d, dueFrom: "clairic" };
    }
    if (this.clairic.lastError) return ` · deadlines: ${this.clairic.lastError.slice(0, 80)}`;
    return found.size ? ` · ${found.size} deadline${found.size === 1 ? "" : "s"} read by Clairic` : "";
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
      if (existing && existing.source.key !== p.key) {
        // This todo was merged into an item from another source (or an older wording). Leave it be.
        continue;
      }
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
   * A proposal whose key now resolves to an item with another source key was merged into that item (upsert's
   * `continue`, createItem's twin, or dedupeExisting). Tag the item so §8 still asks it as a proposal.
   * 10-19: #1 (token rotation) and #5 (/noassign) merged this way and were never asked.
   */
  private markMergedProposals(parsed: ParsedItem[]) {
    for (const p of parsed) {
      if (!p.key.startsWith("memory:proposals:")) continue;
      const item = this.hub.store.itemBySourceKey(p.key);
      if (!item || item.source.key === p.key || item.proposalOf === p.section) continue;
      this.hub.updateItem(item.id, { proposalOf: p.section }, { quiet: true });
    }
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
      // Memory still lists it under a newer wording that was merged into this item.
      if (this.hub.store.aliasesFor(item.id).some((k) => seen.has(k))) continue;
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

/**
 * Retire only on an active-todos that reads as a to-do file: front matter or a heading first, and at least one
 * open to-do. Otherwise returns the sync error to show. A file with every to-do ticked off also blocks (rare, safe).
 * 11-04 16:58Z an agent wrote the file back wrapped in the MCP read envelope; it parsed to zero to-dos and
 * retire() dropped ~40 live items at 17:17.
 */
export function retireBlocker(body: string | undefined, count: number): string | undefined {
  if (body === undefined) return "active-todos missing: 0 items, nothing retired";
  const head = body.trimStart();
  if (count > 0 && (head.startsWith("---") || /^#{1,6}\s/.test(head))) return undefined;
  return `active-todos unparseable: ${new TextEncoder().encode(body).length} bytes, ${count} items`;
}

function clairicFromConfig() {
  const c = config.deadlines.clairic;
  if (config.demo || !c.accountId || !c.token) return undefined;
  return new ClairicDeadlines({ accountId: c.accountId, token: c.token, minConfidence: c.minConfidence });
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
