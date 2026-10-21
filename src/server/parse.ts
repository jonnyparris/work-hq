// Turn the memory markdown that reflections write into structured items.
// Pure functions; no I/O. Tested in test/parse.test.ts.

import type { Coaching, ItemKind } from "../shared/types.ts";
import { resolveDue } from "./deadlines.ts";

export interface ParsedItem {
  key: string;
  kind: ItemKind;
  title: string;
  detail: string;
  section: string;
  project?: string;
  links: string[];
  /** Signals the prompter uses to decide what to ask. */
  flags: {
    stateUnknown: boolean;
    killDate?: string; // YYYY-MM-DD
    dueDate?: string; // YYYY-MM-DD
    /** Set when the date came from the Clairic pass, not the text parser. */
    dueFrom?: "clairic";
    lowConfidence: boolean;
    pineapple: boolean;
  };
}

const SKIP_SECTIONS = /recently resolved|queue rules|completed|archive/i;
const TICKET_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;
const MD_LINK = /\[([^\]]*)\]\((https?:[^)\s]+)\)/g;

export function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.replace(/\(.*\)/, ""))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Strip markdown noise for display: links → text, bold/code markers removed. */
export function plain(s: string) {
  return s
    .replace(MD_LINK, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(body: string): { title: string; rest: string } {
  const bold = /^\*\*(.+?)\*\*[.:]?\s*(.*)$/s.exec(body);
  if (bold) {
    const title = plain(bold[1]!).replace(/[.:]$/, "");
    const rest = bold[2]!.trim().replace(/^[—–-]\s*/, "");
    // A bare ticket key says nothing on its own — borrow the first clause of the body.
    if (/^[A-Z][A-Z0-9]+-\d+$/.test(title) && rest) {
      const clause = plain(rest).split(/[;.,(]\s?|\s[—–]\s/)[0]!.trim().slice(0, 70);
      return { title: `${title} · ${clause}`, rest };
    }
    return { title, rest };
  }
  // "[KEY](url) — explanation" or plain sentence: cut at the first dash or sentence end.
  const cut = body.search(/\s[—–-]\s|(?<=[a-z)])\.\s/);
  const head = cut > 0 && cut < 160 ? body.slice(0, cut) : body.slice(0, 120);
  return { title: plain(head), rest: body.slice(head.length).replace(/^\s*[—–.-]\s*/, "").trim() };
}

export interface ProjectRule {
  key: string;
  match?: string;
}

/** A ticket prefix that's a known project wins; then the first project whose `match` regex hits. */
export function projectOf(text: string, projects: ProjectRule[] = []): string | undefined {
  const known = new Set(projects.map((p) => p.key));
  const keys = [...text.matchAll(TICKET_KEY)].map((m) => m[1]!.split("-")[0]!);
  const hit = keys.find((k) => known.has(k));
  if (hit) return hit;
  for (const p of projects) {
    if (!p.match) continue;
    try {
      if (new RegExp(p.match, "i").test(text)) return p.key;
    } catch {}
  }
  return undefined;
}

function kindOf(section: string, text: string): ItemKind {
  if (/delegated|team-owned/i.test(section)) return "followup";
  if (/ticket hygiene/i.test(section)) return "ticket";
  if (/writing/i.test(section)) return "task";
  if (/\b(reply|respond|in-thread)\b/i.test(text)) return "message";
  if (/\b(email|mail)\b/i.test(text) && /\bsend\b/i.test(text)) return "email";
  if (/\b(chase|nudge|ping|ask \w+ to)\b/i.test(text)) return "followup";
  if (/\b(decide|decision|sign-off|approve)\b/i.test(text)) return "decision";
  if (/\bpineapple\b/i.test(text) && /no ticket/i.test(text)) return "ticket";
  if (/\b(review|read)\b.*\b(MR|doc|draft)\b/i.test(text)) return "review";
  if (/\b(interview|1-1|meeting|demo)\b/i.test(text)) return "meeting";
  return "task";
}

function links(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MD_LINK)) out.add(m[2]!);
  return [...out].slice(0, 8);
}

function flags(text: string, today = new Date()) {
  const kill = /\bkill\b[^.]*?(\d{4}-\d{2}-\d{2})/i.exec(text)?.[1];
  // "by 30 Oct", "due 10-10", "before Friday", "end of next week"; then the older loose "by … YYYY-MM-DD".
  const due = resolveDue(plain(text), today) ?? /\b(?:by|target|due)\b[^.]*?(\d{4}-\d{2}-\d{2})/i.exec(text)?.[1];
  return {
    stateUnknown: /state unknown|completion unknown|unconfirmed|not checked|confirm whether|intent unknown/i.test(text),
    killDate: kill,
    dueDate: due,
    lowConfidence: /lower confidence|notes-only/i.test(text),
    pineapple: /pineapple|🍍/i.test(text),
  };
}

/** Parse the to-do list (`memory.todosPath`). Only unchecked checkbox lines become items. */
export function parseActiveTodos(md: string, file = "active-todos", projects: ProjectRule[] = [], today = new Date()): ParsedItem[] {
  const out: ParsedItem[] = [];
  let section = "";
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^##\s+(.+)/.exec(line);
    if (h) {
      section = plain(h[1]!);
      continue;
    }
    if (!section || SKIP_SECTIONS.test(section)) continue;
    const m = /^\s*-\s+\[ \]\s+(.*)$/.exec(line);
    if (!m) continue;
    // Continuation lines (indented, not a new bullet) belong to this item.
    let body = m[1]!;
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!) && !/^\s*-\s/.test(lines[i + 1]!)) {
      body += " " + lines[++i]!.trim();
    }
    const { title, rest } = titleOf(body);
    if (!title) continue;
    out.push({
      key: `memory:${file}:${slug(title)}`,
      kind: kindOf(section, body),
      title,
      detail: rest,
      section,
      project: projectOf(body, projects),
      links: links(body),
      flags: flags(body, today),
    });
  }
  return out;
}

/** Parse the numbered proposals in a `*-improvement-proposals.md` file. */
export function parseProposals(md: string, date: string, today = new Date()): ParsedItem[] {
  const out: ParsedItem[] = [];
  let section = "";
  const blocks = md.split(/\n(?=#{2,3}\s)/);
  for (const block of blocks) {
    const h2 = /^##\s+(.+)/.exec(block);
    if (h2) {
      section = plain(h2[1]!);
      continue;
    }
    const h3 = /^###\s+(\d+)\.\s+(.+)\n?([\s\S]*)$/.exec(block);
    if (!h3 || !/priority/i.test(section)) continue;
    const title = plain(h3[2]!);
    const body = h3[3]!.trim();
    out.push({
      key: `memory:proposals:${slug(title)}`,
      kind: "idea",
      title,
      detail: body.slice(0, 1200),
      section: `Proposals ${date} · ${section}`,
      project: undefined,
      links: links(body),
      flags: { ...flags(body, today), stateUnknown: false },
    });
  }
  return out;
}

/**
 * Parse `memory/workload/learn-proposals.md`, written by the `learn` skill after a pi session:
 *   ## 2026-10-21 · learn 01a16000
 *   ### 1. Title
 *   body
 * Each becomes a proposal labelled "Proposals <date> · Learn (<rest of heading>)", so prompter §8 asks it.
 */
export function parseLearnProposals(md: string, today = new Date()): ParsedItem[] {
  const out: ParsedItem[] = [];
  let date = "";
  let tag = "";
  for (const block of md.split(/\n(?=#{2,3}\s)/)) {
    const h2 = /^##\s+(\d{4}-\d{2}-\d{2})\s*(?:·|-|—)?\s*(.*)/.exec(block);
    if (h2) {
      date = h2[1]!;
      tag = plain(h2[2]!.split("\n")[0]!).replace(/^learn\s*/i, "").trim();
      continue;
    }
    if (/^##\s/.test(block)) {
      date = "";
      continue;
    }
    const h3 = /^###\s+(\d+)\.\s+(.+)\n?([\s\S]*)$/.exec(block);
    if (!h3 || !date) continue;
    const title = plain(h3[2]!);
    const body = h3[3]!.trim();
    out.push({
      key: `memory:proposals:learn-${slug(title)}`,
      kind: "idea",
      title,
      detail: body.slice(0, 1200),
      section: `Proposals ${date} · Learn${tag ? ` (session ${tag})` : ""}`,
      project: undefined,
      links: links(body),
      flags: { ...flags(body, today), stateUnknown: false },
    });
  }
  return out;
}

/**
 * The "## EM Coaching" block the nightly reflection writes into `*-improvement-proposals.md`:
 * the week's signal, the one move to try next, and the bold lead of each win / gap bullet.
 * Undefined when the file has no such block or no "One thing to try".
 */
export function parseCoaching(md: string, date: string): Omit<Coaching, "url" | "file"> | undefined {
  const start = /^##\s+EM Coaching\b.*$/m.exec(md);
  if (!start) return undefined;
  const rest = md.slice(start.index + start[0].length);
  const end = rest.search(/^##\s/m);
  const block = end < 0 ? rest : rest.slice(0, end);
  const lines = block.split("\n");
  // Blocks open on a bold line at column 0: "**What you did well (M5-aligned):**", "**One thing to try tomorrow (…):**".
  const sections: Array<{ head: string; body: string[] }> = [];
  for (const line of lines) {
    const h = /^\*\*(.+?)\*\*\s*(.*)$/.exec(line);
    if (h) sections.push({ head: h[1]!.replace(/:$/, "").trim(), body: h[2]!.trim() ? [h[2]!.trim()] : [] });
    else sections.at(-1)?.body.push(line);
  }
  const signal = /M5 signal:?\s*\**\s*([^*\n]+)/i.exec(block)?.[1]?.trim().replace(/[.:]$/, "");
  const tryIt = sections.find((s) => /^one thing to try/i.test(s.head));
  if (!tryIt) return undefined;
  const move = tryIt.body.join("\n").replace(/^\n+|\s+$/g, "");
  if (!move) return undefined;
  const leads = (re: RegExp) => {
    const s = sections.find((x) => re.test(x.head));
    if (!s) return [];
    return s.body
      .filter((l) => /^-\s+/.test(l)) // top-level bullets only
      .map((l) => {
        const b = /^-\s+\*\*(.+?)\*\*/.exec(l);
        return plain(b ? b[1]! : l.replace(/^-\s+/, "").split(/(?<=[a-z)])\.\s/)[0]!).replace(/[.:]$/, "");
      })
      .filter(Boolean)
      .slice(0, 6);
  };
  return {
    date,
    signal: signal || "",
    when: tryIt.head.replace(/^one thing to try\s*/i, "").replace(/^\((.*)\)$/, "$1").trim(),
    move,
    wins: leads(/did well/i),
    gaps: leads(/below m5|operating below/i),
  };
}
