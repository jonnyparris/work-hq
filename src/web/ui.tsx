import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { ActionKind, ItemKind, QuestionKind } from "../shared/types.ts";

const P: Record<string, ReactNode> = {
  task: <path d="M4 12l5 5L20 6" />,
  ticket: <><path d="M3 8a2 2 0 002-2h14a2 2 0 002 2v2a2 2 0 000 4v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2a2 2 0 000-4z" /><path d="M13 6v12" strokeDasharray="2 2" /></>,
  message: <path d="M4 5h16v11H9l-5 4z" />,
  email: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  followup: <><path d="M5 12h12" /><path d="M13 6l6 6-6 6" /></>,
  decision: <><path d="M12 3v18" /><path d="M5 7h10l3 3-3 3H5z" /></>,
  review: <><circle cx="12" cy="12" r="3" /><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /></>,
  meeting: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  idea: <><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 00-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0012 3z" /></>,
  check: <path d="M4 12l5 5L20 6" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" /></>,
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></>,
  wait: <><circle cx="12" cy="12" r="9" /><path d="M9 10v4M15 10v4" /></>,
  sat: <><path d="M4 20l4-4" /><rect x="9" y="3" width="6" height="6" rx="1" transform="rotate(45 12 6)" /><path d="M13 11l4 4M6 13a5 5 0 005 5" /></>,
  link: <><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /></>,
  verify: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  prep: <><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h5" /></>,
  work: <><path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" /></>,
  reply: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 016 6v5" />,
};

export function Icon({ name, size }: { name: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {P[name] ?? P.task}
    </svg>
  );
}

let TRACKER = "";
/** Where ticket keys link to (config labels.trackerUrl). Unset = keys stay plain text. */
export function setTracker(url?: string) {
  TRACKER = url ?? "";
}
/** Not ticket keys, even though they look like one. */
const NOT_TICKETS = new Set(["UTF", "ISO", "SHA", "RFC", "GPT", "COVID", "MP", "HTTP", "TLS", "IPV", "AES", "RSA", "WCAG"]);
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;

export function ticketUrl(key: string) {
  const prefix = key.split("-")[0]!;
  return TRACKER && !NOT_TICKETS.has(prefix) ? `${TRACKER}${key}` : undefined;
}

/** Ticket keys in a text, in order, deduped. Empty when no tracker URL is configured. */
export function ticketKeys(text = ""): string[] {
  if (!TRACKER) return [];
  return [...new Set([...text.matchAll(TICKET_RE)].map((m) => m[0]).filter((k) => ticketUrl(k)))];
}

const stopClick = (e: ReactMouseEvent) => e.stopPropagation();

/** Inline markdown: links, bold, code, bare URLs, ticket keys. Enough for memory text. */
export function Md({ text, className = "md", inline }: { text?: string; className?: string; inline?: boolean }) {
  if (!text) return null;
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\((https?:[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(https?:\/\/[^\s)]+)|\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    const ticket = m[6] ? ticketUrl(m[6]) : undefined;
    if (m[6] && !ticket) continue; // looks like a key, isn't (or no tracker configured): leave as text
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<a key={k++} href={m[2]} target="_blank" rel="noreferrer" onClick={stopClick}>{m[1]}</a>);
    else if (m[3]) out.push(<strong key={k++}>{m[3]}</strong>);
    else if (m[4]) out.push(<code key={k++}>{m[4]}</code>);
    else if (m[5]) out.push(<a key={k++} href={m[5]} target="_blank" rel="noreferrer" onClick={stopClick}>{shortUrl(m[5])}</a>);
    else if (ticket) out.push(<a key={k++} className="ticket" href={ticket} target="_blank" rel="noreferrer" onClick={stopClick} title={`Open ${m[6]}`}>{m[6]}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return inline ? <span className={className}>{out}</span> : <div className={className}>{out}</div>;
}

export function shortUrl(u: string) {
  try {
    const url = new URL(u);
    const jira = /\/browse\/([A-Z]+-\d+)/.exec(url.pathname);
    if (jira) return jira[1]!;
    const mr = /\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url.pathname);
    if (mr) return `${mr[1]!.split("/").pop()}!${mr[2]}`;
    if (url.hostname.includes("chat.google")) return "chat thread";
    if (url.hostname.includes("docs.google")) return "doc";
    return url.hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

export function ago(iso?: string, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 0) return `in ${fmtDur(-s)}`;
  if (s < 45) return "just now";
  return `${fmtDur(s)} ago`;
}

function fmtDur(s: number) {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

export function whenLabel(iso?: string, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
  const t = hhmm(iso);
  if (days === 0) return `today ${t}`;
  if (days === 1) return `tomorrow ${t}`;
  if (days === -1) return `yesterday ${t}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${t}`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ` ${t}`;
}

export const KIND_LABEL: Record<ItemKind, string> = {
  task: "Task", ticket: "Ticket", message: "Message", email: "Email", followup: "Follow-up",
  decision: "Decision", review: "Review", meeting: "Meeting", idea: "Idea", post: "Post",
};

export const Q_BADGE: Record<QuestionKind, [string, string]> = {
  confirm: ["Captured", "gold"],
  when: ["It's time", "coral"],
  state: ["State unknown", "sky"],
  dispatch: ["Proposal", "violet"],
  prep: ["Meeting soon", "sky"],
  review: ["Meeting ended", "leaf"],
  plan: ["Morning plan", "gold"],
  wrap: ["Wrap up", "violet"],
  open: ["Question", "quiet"],
  post: ["Post idea", "leaf"],
};

export const ACTIONS: Array<{ action: ActionKind; label: string; hint: string }> = [
  { action: "ticket", label: "File ticket", hint: "Dedupe-search, file or comment in the tracker" },
  { action: "reply", label: "Reply / chase", hint: "Draft in the thread, you approve" },
  { action: "email", label: "Draft email", hint: "Email draft, you send" },
  { action: "verify", label: "Check state", hint: "Read-only: what's actually true?" },
  { action: "prep", label: "Prep brief", hint: "People, history, what to raise" },
  { action: "work", label: "Just do it", hint: "End to end, asks when unsure" },
  { action: "draft", label: "Draft post", hint: "Write or revise the blog draft" },
  { action: "publish", label: "Publish post", hint: "Wiki / public site — asks first" },
];

/** Ask the command bar's recogniser to dictate into someone else (Chrome allows one at a time). */
export function dictateInto(onText: (text: string, final: boolean) => void) {
  window.dispatchEvent(new CustomEvent("whq:dictate", { detail: onText }));
}
/** Cancel: mic off, words dropped. */
export function stopDictation() {
  window.dispatchEvent(new CustomEvent("whq:dictate-stop"));
}
/** Done talking: mic off, deliver the words now. */
export function finishDictation() {
  window.dispatchEvent(new CustomEvent("whq:dictate-finish"));
}
/** "listening" | "transcribing" | "idle" — broadcast so borrowers can show it. */
export type DictationPhase = "listening" | "transcribing" | "idle";

/** Who's using the dashboard. Filled from the server snapshot (config.owner). */
export const profile = { name: "", aliases: [] as string[], speechLang: "en-GB" };
export function setProfile(p: Partial<typeof profile>) {
  Object.assign(profile, p);
}

/** "sam.lee@example.com" → "Sam Lee". Drops the owner (config.owner.aliases). */
export function people(list?: string[]) {
  const me = profile.aliases.map((a) => a.toLowerCase());
  return (list ?? [])
    .map((p) => (p.includes("@") ? p.split("@")[0]!.split(/[._-]/).map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ") : p))
    .filter((p) => !me.some((a) => p.toLowerCase() === a || p.toLowerCase().startsWith(`${a} `)));
}
