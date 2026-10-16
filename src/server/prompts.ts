// Prompt assembly for every pi session Work HQ launches.
//
// Two kinds of text:
//   - Instructions about tools and company conventions → markdown templates in ./prompts,
//     overridable per user via `promptsDir` in the config.
//   - Contracts the server parses (report JSON, sweep output shapes) → here, so they can't drift from the code.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type DeckGroup, deckGroup, deferTargets, GROUP_ORDER, GROUPS } from "../shared/batch.ts";
import type { ActionKind, CalendarEvent, Item, Question } from "../shared/types.ts";
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
    it.notes?.length ? `\n${owner.name}'s notes on it (newest last):\n${it.notes.map((n) => `- ${n.at.slice(0, 10)}: ${n.text}`).join("\n")}` : "",
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
{ "summary": "N meetings scanned, M items", "items": [...], "cursor": "<newest modifiedTime you saw, ISO>",
  "meetings": [{ "title": "<meeting title as in the notes doc>", "start": "<meeting start, ISO with offset>", "url": "<doc url>" }] }
"meetings" lists EVERY meeting whose notes or transcript you read this run, including ones with no items for ${owner.name}.
Do not write files or send anything. Job id: ${jobId}.`;
}

export function calendarSweepPrompt(jobId: string, day: string, through = day) {
  return `You are Work HQ's calendar reader: headless and READ-ONLY.
${template("sweeps/calendar", { day, through })}

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
  questions?: Question[];
}

export function triagePrompt(utterance: string, ctx: TriageContext, mode: "chat" | "pineapple" | "review") {
  const me = owner.name;
  const active = ctx.items
    .filter((i) => !["done", "dropped"].includes(i.status))
    .slice(0, 150)
    .map((i) => `${i.id} | ${i.status} | ${i.kind} | ${i.project ?? "-"} | ${i.title}${i.when ? ` | when: ${i.when}` : ""}`)
    .join("\n");
  const events = ctx.events.map((e) => `${e.start.slice(11, 16)}–${e.end.slice(11, 16)} ${e.title}`).join("\n");
  const deck = deckSummary(ctx.questions ?? [], ctx.now);
  const framing = {
    chat: `${me} typed or said this to their dashboard. It may be a correction ("X is done", "that's not mine"),
a new commitment ("remind me to reply to Sam after standup"), a scheduling instruction, a question, or a request
to act ("file a ticket for…"). Explicit requests to act count as confirmation — include them in "dispatch".`,
    pineapple: `${me} said "pineapple" 🍍 during a live conversation — their trigger to capture what was just discussed.
Below is the rolling live transcript up to the trigger (laptop mic; other voices may be in it). Extract the
action(s) from the discussion immediately before the keyword. Mark new items with signals {"pineapple": true},
status "inbox", and put the verbatim words in source.quote. One item is typical; zero is fine if nothing is actionable.`,
    review: `A meeting just ended (or, for a list of earlier meetings, one of those) and ${me} jotted what came out of it. Turn it into items (status "today" if they say
they'll do it today, else "inbox"), and correct any existing items they mention.`,
  }[mode];

  return `You are Work HQ's triage brain. You turn ${me}'s words into precise state changes.
${framing}

Now: ${ctx.now.toString()} (timezone ${owner.timezone})

Today's calendar:
${events || "(unknown)"}

Active items (id | status | kind | project | title):
${active || "(none)"}

Open questions waiting on ${me}, by group (group · effort · count · examples):
${deck || "(none)"}

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
- Batch: "skip all blog posts till Thursday", "clear the meeting ones", "check all the unknowns for me",
  "push the rest to tomorrow" → a "bulk" entry. Select by "group" (above) and/or item "kind", or "ids" (question ids).
  ops: defer (hide until "until"; scheduled items move to it), dismiss (one-tap "nothing new / later / keep waiting"),
  dispatch (send agents — only when asked), done, drop. Defer times: 09:30 local on the day they name;
  "later this week" = ${laterThisWeek(ctx.now)}. Prefer "kind" for kinds of work ("blog posts" → kind "post").
  "Push the rest / everything else to tomorrow" = one defer per group they didn't just handle, never "day".
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
  "bulk": [{ "op": "defer|dismiss|dispatch|done|drop", "group": "review|inbox|waiting|due|state|proposal|agent|post", "kind": "post", "ids": ["q_…"], "until": "ISO", "label": "Thu 09:30" }],
  "journal": ["facts worth keeping, e.g. '${me}: PAY-123 closed 09-25'"],
  "question": { "prompt", "options": ["...", "..."] } | null
}`;
}

/** A note typed on a question: which answer is it? No tools. The server applies the result. */
export function notePrompt(q: Question, it: Item | undefined, note: string, ctx: { now: Date }) {
  const me = owner.name;
  const effect = (e: Question["options"][number]["effect"]): string =>
    e.type === "status" ? `set status ${e.status}`
    : e.type === "dispatch" ? `send an agent (${e.action})`
    : e.type === "schedule" ? `schedule ${e.label}`
    : e.type === "when" ? "schedule at a time they name"
    : e.type === "snooze" ? `ask again in ${e.minutes} min`
    : e.type === "open" ? "open a link (not an answer)"
    : e.type === "multi" ? e.effects.map(effect).join(" + ")
    : "acknowledge, nothing else";
  const options = q.options.map((o) => `- ${o.id}: "${o.label}" \u2192 ${effect(o.effect)}`).join("\n");
  return `You are Work HQ's note reader. ${me} was shown a question in their dashboard and, instead of pressing a button,
typed a note. Work out what the note means and turn it into ONE decision. Until now these notes were ignored and the
same question kept coming back \u2014 that is the bug you are fixing. Act on what they said.

Now: ${ctx.now.toString()} (timezone ${owner.timezone})

Question: ${q.prompt}${q.context ? `\nContext: ${q.context.slice(0, 600)}` : ""}
Options:
${options}

${it ? itemBlock(it) : "(no item attached)"}

Their note:
"""
${note}
"""

How to decide (first match wins):
0. The note moves the target: a different place, channel, audience or person than the question assumes ("instead",
   "to X not Y", "just share it in\u2026", "actually, post it in X", "send it to X rather than\u2026") \u2192 "dispatch" with
   action reply (sharing, posting or sending it somewhere) or work (anything else), never "pick". The options were
   written for the old target, so a matching-sounding one ("Publish\u2026", "Send") would go to the wrong place.
   "note" = the new target, what not to do any more (the old target), and every other detail they gave.
1. The note clearly matches an option ("yes", "they do", "keep that date", "already approved", "not relevant") \u2192 "pick" its id.
   If the note adds instructions on top ("yes, and also\u2026"), still pick it and put the full instruction in "note".
2. The note asks for something to be done ("send a message to X", "make it shorter first", "improve it", "chase them")
   \u2192 "dispatch" with action reply (messages / chasing people), email, ticket, draft (blog drafts), verify (find out), or work
   (anything else). "note" = a clear instruction for the agent, keeping every detail and correction they gave.
   If one of the options already dispatches the right action to the same target, "pick" it instead.
3. The note names a time for it ("tomorrow", "Thursday", "next Monday in the X meeting", "I'll do that tomorrow",
   "chase on Thursday") \u2192 "when" = the time words as they said them. If a "Scheduled for\u2026" option exists, pick it too.
4. The note settles the state \u2192 "status": done ("nothing else for us to do", "already handled"), dropped ("drop",
   "no", "we're doing it anyway", "merge it into X", "not needed", "I'll share it in chat myself"),
   waiting ("assigned to X", "X owns it now", "waiting on X"), today ("doing it now").
5. Pure background with no action, time or state in it \u2192 leave everything null.
- "title": only if they corrected a name or fact that's in the title (e.g. "it's Joan, not Jon"); the corrected title.
- Never invent facts. reply: \u22641 short sentence saying what you did, dry, no fluff.

OUTPUT: ONLY a JSON object, no prose, no fences:
{ "pick": "<option id>" | null, "status": "done|dropped|waiting|today|proposed" | null, "when": "time words" | null,
  "dispatch": { "action": "reply|email|ticket|draft|verify|work", "note": "instruction" } | null,
  "title": "corrected title" | null, "note": "instruction or reason to pass on" | null, "reply": "..." }`;
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

/** One line per deck group so triage can do "skip all X till Y". */
function deckSummary(questions: Question[], now: Date) {
  const by = new Map<DeckGroup, Question[]>();
  for (const q of questions) {
    if (q.notBefore && Date.parse(q.notBefore) > now.getTime()) continue;
    const g = deckGroup(q);
    by.set(g, [...(by.get(g) ?? []), q]);
  }
  return GROUP_ORDER.filter((g) => by.has(g))
    .map((g) => {
      const qs = by.get(g)!;
      return `${g} · ${GROUPS[g].effort} · ${qs.length} · ${qs.slice(0, 4).map((q) => `${q.id}: ${q.prompt.slice(0, 60)}`).join(" | ")}`;
    })
    .join("\n");
}

function laterThisWeek(now: Date) {
  // Mon/Tue → Thu, Wed → Fri, Thu/Fri/weekend → next Monday.
  const want = [1, 4, 4, 5, 1, 1, 1][now.getDay()]!;
  const t = deferTargets(now).find((x) => new Date(x.at).getDay() === want) ?? deferTargets(now).at(-1)!;
  return `${t.label} (${t.at})`;
}
