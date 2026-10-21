// Block structure for item details and card context. Md used to render everything inline, so newlines,
// bullet lists and "**Problem**: …\n**Solution**: …" all ran together, and agent-written details (avg ~550
// chars, max 2.5k, mostly one paragraph) read as a wall of text in the drawer's "Why this exists".
// Pure, so the splitting is testable without a DOM.

export type Block = { type: "p"; lines: string[] } | { type: "ul" | "ol"; items: string[] } | { type: "h"; text: string };

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d{1,2}[.)]\s+/;
const HEADING = /^\s*#{1,4}\s+/;

/** Markdown-ish blocks: blank lines split paragraphs; "- ", "1. " and "# " lines become lists and headings. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ type: "p", lines: para });
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const list = BULLET.test(line) ? "ul" : NUMBERED.test(line) ? "ol" : undefined;
    if (list) {
      flush();
      const text = line.replace(list === "ul" ? BULLET : NUMBERED, "");
      const prev = out[out.length - 1];
      if (prev && prev.type === list) prev.items.push(text);
      else out.push({ type: list, items: [text] });
    } else if (HEADING.test(line)) {
      flush();
      out.push({ type: "h", text: line.replace(HEADING, "") });
    } else {
      // A wrapped continuation of the last bullet ("- foo\n  bar") stays with it.
      const prev = out[out.length - 1];
      if (!para.length && /^\s+/.test(raw) && prev && (prev.type === "ul" || prev.type === "ol")) prev.items[prev.items.length - 1] += ` ${line.trim()}`;
      else para.push(line.trim());
    }
  }
  flush();
  return out;
}

// Abbreviations whose dot isn't a sentence end.
const ABBREV = /\b(e\.g|i\.e|vs|etc|approx|cf|incl|esp|eg|ie)\.$/i;

/** Split prose into sentences. Conservative: only at ". " / "! " / "? " followed by a capital, digit, quote or bracket. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  const re = /[.!?](?=\s+["'(\[`*A-Z0-9])/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + 1;
    const chunk = text.slice(start, end);
    if (ABBREV.test(chunk)) continue;
    // Inside an unclosed bracket or backtick span: not a sentence end.
    if ((chunk.match(/\(/g)?.length ?? 0) > (chunk.match(/\)/g)?.length ?? 0) || (chunk.match(/`/g)?.length ?? 0) % 2) continue;
    out.push(chunk.trim());
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/**
 * Blocks for a detail shown on its own (the drawer). Same as `blocks`, plus: one long prose paragraph becomes
 * a lead sentence and a bullet per remaining sentence, so it can be skimmed.
 */
export function detailBlocks(text: string, o: { minChars?: number; minSentences?: number } = {}): Block[] {
  const b = blocks(text);
  const minChars = o.minChars ?? 240;
  const minSentences = o.minSentences ?? 3;
  return b.flatMap((x): Block[] => {
    if (x.type !== "p" || x.lines.length > 1) return [x];
    const line = x.lines[0]!;
    if (line.length < minChars) return [x];
    const s = sentences(line);
    if (s.length < minSentences) return [x];
    return [{ type: "p", lines: [s[0]!] }, { type: "ul", items: s.slice(1) }];
  });
}

/** What an "Explain simply" was written from: title, detail and quote. Changes when any of them does. */
export function explainKey(it: { title: string; detail?: string; source?: { quote?: string } }) {
  const text = `${it.title}\u0000${it.detail ?? ""}\u0000${it.source?.quote ?? ""}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
