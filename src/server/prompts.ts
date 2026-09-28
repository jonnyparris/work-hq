// Prompt assembly for every pi session Work HQ launches.
//
// Two kinds of text:
//   - Instructions about tools and company conventions → markdown templates in ./prompts,
//     overridable per user via `promptsDir` in the config.
//   - Contracts the server parses (report JSON, sweep output shapes) → here, so they can't drift from the code.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ActionKind, CalendarEvent, Item } from "../shared/types.ts";
import { config, ROOT } from "./config.ts";

const WHQ = `${ROOT}/bin/whq`;
const { owner, writing, workspace } = config;
export const WIKI_DRAFTS = writing.wiki.draftsDir;
export const SITE_POSTS = writing.site.postsDir;
/** Site drafts live outside the vault; a symlink next to the wiki drafts lets Obsidian open them. */
export const SITE_LINK = `${WIKI_DRAFTS}/site`;

/** "Alex (Engineering Manager, Acme)". */
export const OWNER_INTRO = `${owner.name}${[owner.role, owner.company].filter(Boolean).length ? ` (${[owner.role, owner.company].filter(Boolean).join(", ")})` : ""}`;

/** A clickable URL that opens a local file for the user: Obsidian if configured, else file://. */
export function openUrl(absPath: string) {
  const vault = workspace.obsidianVault;
  if (!vault) return `file://${encodeURI(absPath)}`;
  const rel = SITE_POSTS && absPath.startsWith(SITE_POSTS) ? absPath.replace(SITE_POSTS, SITE_LINK) : absPath;
  if (!rel.startsWith(`${workspace.dir}/`)) return `file://${encodeURI(absPath)}`;
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(rel.replace(`${workspace.dir}/`, "").replace(/\.md$/, ""))}`;
}
/** @deprecated use openUrl */
export const obsidianUrl = openUrl;

// ── templates ────────────────────────────────────────────────────────────
const baseVars = (): Record<string, string> => ({
  "owner.name": owner.name,
  "owner.role": owner.role,
  "owner.company": owner.company,
  "owner.location": owner.location,
  "owner.timezone": owner.timezone,
  "owner.intro": OWNER_INTRO,
  "workspace.dir": workspace.dir,
  "workspace.scratchDir": workspace.scratchDir,
  tracker: config.labels.tracker,
  chat: config.labels.chat,
  "wiki.name": writing.wiki.name,
  "wiki.draftsDir": writing.wiki.draftsDir,
  "site.name": writing.site.name,
  "site.postsDir": writing.site.postsDir ?? "(no site configured — skip site drafts)",
  "site.repoDir": writing.site.repoDir ?? writing.site.postsDir ?? "(no site configured)",
  journalPath: config.memory.journalPath,
  openFile: workspace.obsidianVault
    ? `obsidian://open?vault=${workspace.obsidianVault}&file=<path relative to ${workspace.dir}, no .md>`
    : "`open <path>`",
  whq: WHQ,
  port: String(config.port),
  root: ROOT,
});

/** Load `prompts/<name>.md` (user override first), strip HTML comments, fill {{vars}}. */
export function template(name: string, vars: Record<string, string> = {}): string {
  const candidates = [config.promptsDir && resolve(config.promptsDir, `${name}.md`), resolve(ROOT, "prompts", `${name}.md`)];
  const file = candidates.find((p): p is string => Boolean(p && existsSync(p)));
  if (!file) throw new Error(`missing prompt template: ${name}`);
  const all = { ...baseVars(), ...vars };
  return readFileSync(file, "utf8")
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k: string) => all[k] ?? m)
    .trim();
}

export const toolRoutes = () => template("tools");

export const REPORT_CONTRACT = (jobId: string) => `REPORTING BACK TO WORK HQ

Work HQ (${owner.name}'s live dashboard, ${ROOT}) launched you as job ${jobId}. Report results by piping JSON:

  ${WHQ} report ${jobId} <<'JSON'
  { "summary": "one line", "status": "done", "updates": [...], "items": [...], "questions": [...], "journal": [...] }
  JSON

Fields (all optional):
- summary: one plain sentence of what happened.
- status: "done" | "failed" | "progress" (use progress for mid-run notes).
- updates: [{ "id": "<item id>", "status": "done|waiting|today|dropped|...", "links": ["https://..."], "detail": "...", "note": "why" }]
- items: new items [{ "title", "kind": "task|ticket|message|email|followup|decision|review|meeting|idea",
  "detail", "project", "people": [], "links": [], "status": "inbox",
  "source": { "type": "agent", "label", "url", "quote": "verbatim words", "key": "stable-dedupe-key" } }]
- questions: things only ${owner.name} can answer [{ "prompt", "context", "itemId",
  "options": [{ "label": "Mark done", "status": "done" }, { "label": "File the ticket", "action": "ticket" }, { "label": "Keep open", "status": "proposed" }] }]
  (status: any item status; action: ticket|reply|email|prep|work|verify — an action dispatches another agent)
- journal: facts worth remembering, one line each ("PAY-123 closed by ${owner.name} 09-25").

Report once at the end; progress reports are welcome on long runs.`;

function itemBlock(it: Item) {
  return [
    `Item id: ${it.id}`,
    `Title: ${it.title}`,
    `Kind: ${it.kind} · Status: ${it.status}${it.project ? ` · Project: ${it.project}` : ""}`,
    it.people?.length ? `People: ${it.people.join(", ")}` : "",
    it.source.label ? `Source: ${it.source.type} — ${it.source.label}${it.source.url ? ` (${it.source.url})` : ""}` : "",
    it.source.quote ? `Verbatim: “${it.source.quote}”` : "",
    it.links?.length ? `Links: ${it.links.join(" ")}` : "",
    it.post ? `Post: venue ${it.post.venue}${it.post.why ? ` · why: ${it.post.why}` : ""}${it.post.gap ? ` · gap check: ${it.post.gap}` : ""}` : "",
    it.post?.wikiDraft ? `Wiki draft: ${it.post.wikiDraft}` : "",
    it.post?.siteDraft ? `Site draft: ${it.post.siteDraft}` : "",
    it.detail ? `\nDetail:\n${it.detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function actionPrompt(jobId: string, it: Item, action: ActionKind, note?: string) {
  return `You are a Work HQ action agent for ${OWNER_INTRO}. They just confirmed this in their dashboard.
They can see this session and may answer questions here.

TASK: ${action.toUpperCase()}
${template(`actions/${action}`)}
${note ? `\n${owner.name}'s note: ${note}\n` : ""}
${itemBlock(it)}

${toolRoutes()}

${REPORT_CONTRACT(jobId)}`;
}

export function transcriptSweepPrompt(jobId: string, since: string, known: string[]) {
  return `You are Work HQ's transcript watcher: a headless, READ-ONLY sweep. ${owner.name} is working; find what they
committed to or were asked to do in meetings that have produced notes or transcripts since ${since}.

${template("sweeps/transcripts", { since, sinceSlash: since.slice(0, 10).replace(/-/g, "/") })}

Each item: status "inbox"; title = the action in ≤12 words; kind; people; project if clear;
source = { type: "transcript", label: "<Meeting> HH:MM", url: "<doc url>", quote: "<verbatim words, ≤40>",
key: "transcript:<docId>:<short-slug>" }; confidence 0-1.

Known items (don't duplicate):
${known.slice(0, 120).map((t) => `- ${t}`).join("\n") || "- (none)"}

${toolRoutes()}

OUTPUT: your final message must be ONLY a JSON object (no prose, no fences):
{ "summary": "N meetings scanned, M items", "items": [...], "cursor": "<newest modifiedTime you saw, ISO>" }
Do not write files or send anything. Job id: ${jobId}.`;
}

export function calendarSweepPrompt(jobId: string, day: string) {
  return `You are Work HQ's calendar reader: headless and READ-ONLY.
${template("sweeps/calendar", { day })}

Skip all-day OOO/holiday markers. For each event output:
{ "id", "title", "start": ISO with offset, "end": ISO with offset, "attendees": [first names or emails, max 8],
  "oneOnOne": true if exactly 2 humans, "url": meeting link or htmlLink, "response": "accepted|declined|tentative|needsAction" }

${toolRoutes()}

OUTPUT: final message must be ONLY JSON (no prose, no fences): { "summary": "N events", "events": [...] }
Job id: ${jobId}.`;
}

export interface TriageContext {
  now: Date;
  items: Item[];
  events: CalendarEvent[];
}

export function triagePrompt(utterance: string, ctx: TriageContext, mode: "chat" | "pineapple" | "review") {
  const me = owner.name;
  const active = ctx.items
    .filter((i) => !["done", "dropped"].includes(i.status))
    .slice(0, 150)
    .map((i) => `${i.id} | ${i.status} | ${i.kind} | ${i.project ?? "-"} | ${i.title}${i.when ? ` | when: ${i.when}` : ""}`)
    .join("\n");
  const events = ctx.events.map((e) => `${e.start.slice(11, 16)}–${e.end.slice(11, 16)} ${e.title}`).join("\n");
  const framing = {
    chat: `${me} typed or said this to their dashboard. It may be a correction ("X is done", "that's not mine"),
a new commitment ("remind me to reply to Sam after standup"), a scheduling instruction, a question, or a request
to act ("file a ticket for…"). Explicit requests to act count as confirmation — include them in "dispatch".`,
    pineapple: `${me} said "pineapple" 🍍 during a live conversation — their trigger to capture what was just discussed.
Below is the rolling live transcript up to the trigger (laptop mic; other voices may be in it). Extract the
action(s) from the discussion immediately before the keyword. Mark new items with signals {"pineapple": true},
status "inbox", and put the verbatim words in source.quote. One item is typical; zero is fine if nothing is actionable.`,
    review: `A meeting just ended and ${me} jotted what came out of it. Turn it into items (status "today" if they say
they'll do it today, else "inbox"), and correct any existing items they mention.`,
  }[mode];

  return `You are Work HQ's triage brain. You turn ${me}'s words into precise state changes.
${framing}

Now: ${ctx.now.toString()} (timezone ${owner.timezone})

Today's calendar:
${events || "(unknown)"}

Active items (id | status | kind | project | title):
${active || "(none)"}

Statuses: inbox, proposed, today, scheduled, doing, waiting, done, dropped.
Kinds: task, ticket, message, email, followup, decision, review, meeting, idea, post.
"post" = a blog post they should write ("I should blog about X"): status "proposed", add "post": {"venue": "wiki|site|both"}
(wiki = ${writing.wiki.name}; site = their public ${writing.site.name}; default "wiki" unless they say external/public/personal site, "both" if they say both).
Actions you may dispatch (only when asked): ticket, reply, email, prep, work, verify, draft (blog draft), publish.

Rules:
- Match existing items generously by meaning; prefer updating over creating duplicates.
- Times: resolve "after standup", "this afternoon", "tomorrow" to an absolute ISO timestamp using the calendar.
- Calendar: only when asked ("put it in my calendar", "block time", "book a slot") add a "calendar" entry.
  "Remind me" alone means an in-app reminder (scheduledFor), no calendar event. "I've booked it" = scheduledFor only.
- Never invent facts. If it's ambiguous, ask ONE short question.
- reply: ≤2 short sentences, dry, no fluff — you're a bot in a terminal, not a butler.

INPUT:
"""
${utterance}
"""

OUTPUT: ONLY a JSON object, no prose, no fences:
{
  "reply": "what you did, briefly",
  "items": [{ "title", "kind", "status", "detail", "project", "people", "post": {"venue", "why"},
              "when": "short human phrase, e.g. 'after standup'", "scheduledFor": "ISO timestamp",
              "signals": {"pineapple": true}, "source": {"type": "${mode === "pineapple" ? "pineapple" : "voice"}", "quote", "label"} }],
  "updates": [{ "id", "status", "title", "detail", "when", "scheduledFor", "note" }],
  "dispatch": [{ "id": "<existing id, or 'new:<index into items>'>", "action": "ticket|reply|email|prep|work|verify|draft|publish", "note" }],
  "calendar": [{ "id": "<existing id, or 'new:<index>'>", "start": "ISO", "durationMin": 30 }],
  "journal": ["facts worth keeping, e.g. '${me}: PAY-123 closed 09-25'"],
  "question": { "prompt", "options": ["...", "..."] } | null
}`;
}

/** Turn "booked it for Thursday 2pm" / "put it in Friday morning" into a time. No tools. */
export function schedulePrompt(it: Item, words: string, ctx: { now: Date; events: CalendarEvent[] }) {
  const events = ctx.events.map((e) => `${e.start.slice(11, 16)}–${e.end.slice(11, 16)} ${e.title}`).join("\n");
  return `You resolve when ${owner.name} wants something to happen. Timezone ${owner.timezone}. Work hours ${config.sweeps.workHours.join("–")}h.
Now: ${ctx.now.toString()}
Today's calendar:
${events || "(unknown)"}

Item: ${it.title}${it.detail ? `\n${it.detail.slice(0, 400)}` : ""}

They said:
"""
${words}
"""

Rules:
- "at": the absolute ISO timestamp (with offset) when it should happen or when they want the reminder.
  Vague times: morning 09:30, afternoon 14:00, end of day 17:30, "next week" = Monday 09:30. Skip past times.
- "calendar":
  "create" — they asked for it in the calendar / to block time / book a slot / hold time.
  "exists" — they say THEY already booked or scheduled it (a meeting, a slot, an invite). Don't create anything.
  "none"   — anything else, including "remind me". The app reminds them at "at".
- "durationMin": only for "create"; what they said, else 30 (60 for writing/deep work).
- "label": short human phrase for the time, e.g. "Thu 14:00".
- If there's no time in what they said, "at": null and a one-line "reply" asking when.

OUTPUT: ONLY JSON, no prose, no fences:
{ "at": "ISO" | null, "label": "...", "calendar": "create|exists|none", "durationMin": 30, "reply": "≤1 short sentence of what you did" }`;
}

/** Create a private block in the owner's own calendar. No attendees, no invites. */
export function calendarPrompt(jobId: string, it: Item, start: string, end: string) {
  const description = `Booked by Work HQ (http://localhost:${config.port}) · item ${it.id}${it.links?.length ? `\n${it.links.join("\n")}` : ""}${it.detail ? `\n\n${it.detail.slice(0, 600)}` : ""}`;
  return `You are Work HQ's calendar writer. Create ONE event in ${owner.name}'s primary calendar, then stop.

${template("sweeps/calendar-write", { summary: JSON.stringify(it.title.slice(0, 120)), start, end, description: JSON.stringify(description) })}

OUTPUT: final message ONLY JSON (no prose, no fences):
{ "summary": "one line", "status": "done|failed", "eventId": "...", "eventUrl": "htmlLink" }
Job id: ${jobId}.`;
}

/** Weekly: what should the owner write, and draft the best two. Read-only; the server writes the files. */
export function postSweepPrompt(jobId: string, known: Item[], today: string, inFlight: string[]) {
  const list = known
    .map((i) => `- ${i.id} | ${i.status} | ${i.post?.venue ?? "?"} | ${i.title}${i.post?.wikiDraft || i.post?.siteDraft ? " | HAS DRAFT" : " | no draft"}`)
    .join("\n");
  const facts = [owner.role, owner.company, owner.location].filter(Boolean);
  const who = `${owner.name}${facts.length ? ` (${facts.join(", ")})` : ""}`;
  return `You are Work HQ's writing scout. Find small posts ${who} can and SHOULD
publish, then draft the best ones. Headless and READ-ONLY: don't write files or publish anything; return everything as JSON.

${template("sweeps/posts", {
  inFlight: inFlight.map((f) => `   - ${f}`).join("\n") || "   - (none)",
  known: list || "- (none)",
  today,
})}

${toolRoutes()}

OUTPUT: final message ONLY JSON (no prose, no fences):
{ "summary": "N ideas, M drafted",
  "ideas": [{ "id": "<known item id if it's one of those, else omit>", "title": "working title", "slug": "kebab-case",
    "venue": "wiki|site|both", "why": "one line: career/team/gap", "gap": "what the wiki check found",
    "angle": "2-3 sentences: the point and the story", "evidence": ["links or memory paths"],
    "wikiDraft": "full markdown or omit", "siteDraft": "full markdown incl. frontmatter (draft: true, date: ${today}) or omit" }] }
Job id: ${jobId}.`;
}
