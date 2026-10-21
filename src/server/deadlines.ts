// Deadlines in to-do text, in two passes.
//
// 1. resolveDue(): deterministic. A cue ("by", "due", "before", "until", "target", "deadline") right before
//    a date phrase ("30 Oct", "10-19", "Friday", "tomorrow", "end of next week"), or a bare "end of
//    November". Resolved against today. Pure; tested in test/deadlines.test.ts.
// 2. ClairicDeadlines: what pass 1 couldn't resolve ("before the offsite", "in two weeks") goes to Workers
//    AI's Clairic extraction model in one batched call. Off unless `deadlines.clairic` is configured.
//
// Measured 10-21 on the real to-do file (64 items): Clairic on whole items returned a date for nearly all
// of them, 4 of 7 at confidence ≥ 0.9 wrong (it copies "filed 10-20", "by DM 10-01"). So it only sees the
// clauses with a cue, only ones pass 1 left unresolved, and an answer that is a date written in the clause
// is dropped: pass 1 already had its chance at those, so a copied date is not the deadline.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DOW = "(mon|tue|wed|thu|fri|sat|sun)(?:day|s|nesday|rsday|urday|sday)?\\b";
const CUE = "(?:by|due(?:\\s+(?:on|by))?|before|until|till|no later than|target(?:ed)?(?:\\s+(?:for|of|is))?|deadline(?:\\s+(?:is|of))?:?)\\s+(?:the\\s+|on\\s+)?";
const ORD = "(?:st|nd|rd|th)?";

/** A date phrase right after a cue word. Order matters: longer forms first. */
const AFTER_CUE: Array<[RegExp, (m: RegExpExecArray, today: Date) => Date | undefined]> = [
  [rx(`(\\d{4})-(\\d{2})-(\\d{2})\\b`), (m) => ymd(+m[1]!, +m[2]!, +m[3]!)],
  [rx(`(\\d{1,2})${ORD}\\s+${MON}(?:\\s+(\\d{4}))?\\b`), (m, t) => near(t, mon(m[2]!), +m[1]!, m[3])],
  [rx(`${MON}\\s+(\\d{1,2})${ORD}\\b(?:,?\\s+(\\d{4}))?`), (m, t) => near(t, mon(m[1]!), +m[2]!, m[3])],
  [rx(`(\\d{2})-(\\d{2})\\b(?![-\\d])`), (m, t) => near(t, +m[1]! - 1, +m[2]!)],
  [rx(`(next\\s+)?${DOW}`), (m, t) => weekday(t, DAYS.indexOf(m[2]!.toLowerCase()), Boolean(m[1]))],
  [rx(`(?:today|tonight|eod|cob|close of (?:business|play))\\b`), (_, t) => t],
  [rx(`tomorrow\\b`), (_, t) => addDays(t, 1)],
  [rx(`${MON}(?!\\s*\\d)\\b`), (m, t) => (m.input.slice(0, m.index).match(/before\s*$/i) ? addDays(monthStart(t, mon(m[1]!)), -1) : undefined)],
];

/** Phrases that are a deadline on their own ("…, end of November"). */
const STANDALONE: Array<[RegExp, (m: RegExpExecArray, today: Date) => Date | undefined]> = [
  [rx(`(?:the\\s+)?end of next week\\b`), (_, t) => addDays(weekday(t, 5, false), 7)],
  [rx(`(?:(?:the\\s+)?end of (?:the |this )?week|eow)\\b`), (_, t) => weekday(t, 5, false)],
  [rx(`(?:the\\s+)?end of next month\\b`), (_, t) => monthEnd(t.getFullYear(), t.getMonth() + 1)],
  [rx(`(?:(?:the\\s+)?end of (?:the |this )?month|eom)\\b`), (_, t) => monthEnd(t.getFullYear(), t.getMonth())],
  [rx(`(?:the\\s+)?end of q([1-4])\\b`), (m, t) => monthEnd(t.getFullYear(), +m[1]! * 3 - 1)],
  [rx(`(?:the\\s+)?end of ${MON}(?!\\s*\\d)`), (m, t) => {
    const start = monthStart(t, mon(m[1]!));
    return monthEnd(start.getFullYear(), start.getMonth());
  }],
];

function rx(s: string) {
  return new RegExp(s, "iy"); // sticky: matched at a given position
}

/** YYYY-MM-DD of the first deadline the text states, resolved against `today`. */
export function resolveDue(text: string, today = new Date()): string | undefined {
  const t = startOfDay(today);
  const cue = new RegExp(`\\b${CUE}`, "gi");
  const hits: Array<{ at: number; date: Date }> = [];
  for (const m of text.matchAll(cue)) {
    const at = m.index! + m[0].length;
    const d = firstAt(AFTER_CUE, text, at, t) ?? firstAt(STANDALONE, text, at, t);
    if (d) hits.push({ at: m.index!, date: d });
  }
  const bare = /\b(?:the\s+)?(?:end of|eow\b|eom\b)/gi;
  for (const m of text.matchAll(bare)) {
    const d = firstAt(STANDALONE, text, m.index!, t);
    if (d) hits.push({ at: m.index!, date: d });
  }
  hits.sort((a, b) => a.at - b.at);
  return hits[0] ? iso(hits[0].date) : undefined;
}

function firstAt(rules: typeof AFTER_CUE, text: string, at: number, today: Date) {
  for (const [re, fn] of rules) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) continue;
    const d = fn(m, today);
    if (d && !Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

/** Clauses with a deadline cue. What Clairic reads; everything else in an item is noise to it. */
export function cueClauses(text: string): string[] {
  const cue = new RegExp(`\\b(?:by|due|before|until|till|deadline|no later than|target|within|in \\d+ (?:days?|weeks?))\\b|\\bend of\\b`, "i");
  return text
    .split(/(?<=[.;!?])\s+|\s+[—–]\s+|[()]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3 && cue.test(s));
}

/** Dates written out in a clause (ISO, MM-DD, 30 Oct, Oct 30), so a copied one can be refused. */
export function writtenDates(text: string, today = new Date()): Set<string> {
  const t = startOfDay(today);
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(/(?<![\d-])(\d{2})-(\d{2})(?![-\d])/g)) {
    const d = near(t, +m[1]! - 1, +m[2]!);
    if (d) out.add(iso(d));
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})${ORD}\\s+${MON}`, "gi"))) {
    const d = near(t, mon(m[2]!), +m[1]!);
    if (d) out.add(iso(d));
  }
  for (const m of text.matchAll(new RegExp(`\\b${MON}\\s+(\\d{1,2})\\b`, "gi"))) {
    const d = near(t, mon(m[1]!), +m[2]!);
    if (d) out.add(iso(d));
  }
  return out;
}

// ── Clairic ────────────────────────────────────────────────────────────────

export interface ClairicOptions {
  accountId: string;
  token: string;
  /** Below this, an answer is ignored. Default 0.9. */
  minConfidence?: number;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface Answer {
  value: string | null;
  confidence: number;
}

export class ClairicDeadlines {
  private cache = new Map<string, string | null>();
  lastError?: string;
  lastRun?: { asked: number; found: number; ms: number; tokens?: number };

  constructor(private opts: ClairicOptions) {}

  /**
   * Deadlines for texts pass 1 left undated. Returns key → YYYY-MM-DD for the ones it's sure of.
   * Never throws: a failed call just means no extra dates this round (see lastError).
   */
  async fill(texts: Array<{ key: string; text: string }>, today = new Date()): Promise<Map<string, string>> {
    const t = startOfDay(today);
    const day = iso(t);
    const out = new Map<string, string>();
    const ask: Array<{ key: string; clause: string }> = [];
    for (const { key, text } of texts) {
      const clause = cueClauses(text).join(" … ").slice(0, 600);
      if (!clause) continue;
      const ck = `${day}\u0000${clause}`;
      if (this.cache.has(ck)) {
        const v = this.cache.get(ck);
        if (v) out.set(key, v);
        continue;
      }
      ask.push({ key, clause });
    }
    if (!ask.length) return out;
    const started = Date.now();
    try {
      const { answers, tokens } = await this.call(ask.map((a) => a.clause), t);
      let found = 0;
      ask.forEach((a, n) => {
        const v = accept(answers[`d${n}`], a.clause, t, this.opts.minConfidence ?? 0.9);
        this.cache.set(`${day}\u0000${a.clause}`, v ?? null);
        if (v) {
          out.set(a.key, v);
          found++;
        }
      });
      this.lastRun = { asked: ask.length, found, ms: Date.now() - started, tokens };
      this.lastError = undefined;
      if (this.cache.size > 2000) this.cache.clear();
    } catch (e) {
      this.lastError = String((e as Error).message ?? e);
    }
    return out;
  }

  private async call(clauses: string[], today: Date) {
    const fields = Object.fromEntries(
      clauses.map((_, n) => [`d${n}`, { type: "date", instructions: `Deadline (due-by date) for item ${n}, if it states one. Not meeting dates.` }]),
    );
    const state = `Today: ${today.toLocaleDateString("en-GB", { weekday: "long" })} ${iso(today)}.\n` + clauses.map((c, n) => `Item ${n}: ${c}`).join("\n");
    const model = this.opts.model ?? "@cf/cloudflare/clairic";
    const res = await (this.opts.fetch ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${this.opts.accountId}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ state, fields, reference_date: iso(today) }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j?.result?.answers) throw new Error(`clairic ${res.status}: ${JSON.stringify(j?.errors ?? j).slice(0, 200)}`);
    return { answers: j.result.answers as Record<string, Answer | undefined>, tokens: j.result.usage?.input_tokens as number | undefined };
  }
}

/** Gate one Clairic answer. Exported for tests. */
export function accept(a: Answer | undefined, clause: string, today: Date, min = 0.9): string | undefined {
  if (!a?.value || !/^\d{4}-\d{2}-\d{2}$/.test(a.value) || a.confidence < min) return undefined;
  // A date written in the clause that pass 1 didn't take is a filed / sent / meeting date, not a deadline.
  if (writtenDates(clause, today).has(a.value)) return undefined;
  const d = Date.parse(a.value);
  const t = startOfDay(today).getTime();
  if (d < t - 30 * 86400000 || d > t + 180 * 86400000) return undefined;
  return a.value;
}

// ── dates ──────────────────────────────────────────────────────────────────

function mon(s: string) {
  return MONTHS.indexOf(s.slice(0, 3).toLowerCase());
}

function ymd(y: number, m: number, d: number) {
  const out = new Date(y, m - 1, d);
  return out.getMonth() === m - 1 ? out : undefined;
}

/** Month/day with no year: the year that puts it within six months of today. */
function near(today: Date, month: number, day: number, year?: string): Date | undefined {
  if (month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  if (year) return ymd(+year, month + 1, day);
  const y = today.getFullYear();
  const half = 183 * 86400000;
  for (const c of [y, y + 1, y - 1]) {
    const d = ymd(c, month + 1, day);
    if (d && Math.abs(d.getTime() - today.getTime()) <= half) return d;
  }
  return undefined;
}

/** The next `dow` on or after today; `next` = that weekday in the following Monday-based week. */
function weekday(today: Date, dow: number, next: boolean) {
  if (next) {
    const monday = addDays(today, -((today.getDay() + 6) % 7));
    return addDays(monday, 7 + ((dow + 6) % 7));
  }
  return addDays(today, (dow - today.getDay() + 7) % 7);
}

/** First day of `month`, this year or next (whichever hasn't fully passed). */
function monthStart(today: Date, month: number) {
  const y = month < today.getMonth() ? today.getFullYear() + 1 : today.getFullYear();
  return new Date(y, month, 1);
}

function monthEnd(y: number, month: number) {
  return new Date(y, month + 1, 0);
}

function addDays(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
