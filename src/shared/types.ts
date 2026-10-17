// Shared between server and web. Keep it dependency-free.

/** What kind of work an item represents. Drives which action a dispatch uses. */
export type ItemKind =
  | "task" // something the owner does themselves
  | "ticket" // should become (or already is) a tracker ticket
  | "message" // reply in a chat thread / DM
  | "email" // send or draft an email
  | "followup" // chase someone else
  | "decision" // a call the owner has to make
  | "review" // MR / doc to read
  | "meeting" // prep or book something
  | "idea" // not a commitment yet
  | "post"; // a blog post worth writing (internal wiki and/or public site)

export type ItemStatus =
  | "inbox" // captured, not triaged
  | "proposed" // an agent suggested it; the owner hasn't agreed
  | "today" // committed for today
  | "scheduled" // committed for a specific time
  | "doing" // an agent (or the owner) is on it right now
  | "waiting" // blocked on someone else
  | "done"
  | "dropped";

export type SourceType =
  | "memory" // active-todos / pineapple log / proposals in agent-memory
  | "transcript" // meeting notes / transcripts
  | "pineapple" // 🍍 spoken or typed
  | "voice" // dictated into the command bar
  | "manual" // typed into the command bar
  | "agent" // a dispatched agent created it
  | "check" // a configured morning check command (src/server/checks.ts)
  | "calendar";

export interface ItemSource {
  type: SourceType;
  /** Human label: "Delta Weekly 09-24", "active-todos § Immediate". */
  label?: string;
  url?: string;
  /** Verbatim words that justify the item. Never paraphrased. */
  quote?: string;
  /** Stable key for re-import dedupe (e.g. memory path + heading). */
  key?: string;
}

export interface Item {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  title: string;
  detail?: string;
  project?: string; // short project key, e.g. PAY (see config.projects)
  people?: string[];
  source: ItemSource;
  /** ISO timestamp when the owner wants it to happen. */
  scheduledFor?: string;
  /** Free-text "when" if it's relative ("after standup"). */
  when?: string;
  /** JIRA key / MR ref / chat link once something concrete exists. */
  links?: string[];
  /** 0-1: how sure the extractor was that this is real and owner-owned. */
  confidence?: number;
  /** Hints parsed from memory text that drive which questions get asked. */
  signals?: {
    stateUnknown?: boolean;
    killDate?: string;
    dueDate?: string;
    lowConfidence?: boolean;
    pineapple?: boolean;
  };
  /** Blog-post ideas only. */
  post?: PostInfo;
  /** Last time the owner confirmed the state themselves. The whole point of the app. */
  confirmedAt?: string;
  /** What the owner typed about it. Kept apart from `detail` so memory re-imports never wipe it. */
  notes?: ItemNote[];
  createdAt: string;
  updatedAt: string;
}

export interface ItemNote {
  at: string;
  text: string;
}

/** What a typed note on a question means. Produced by the note reader (pi) or the cheap pattern match. */
export interface NoteDecision {
  /** One of the question's own option ids. Wins over everything below. */
  pick?: string | null;
  status?: ItemStatus | null;
  /** Words with a time in them ("tomorrow", "Thursday"), resolved by the scheduler. */
  when?: string | null;
  dispatch?: { action: ActionKind; note?: string } | null;
  /** The owner corrected the title ("it's Joan, not Jon"). */
  title?: string | null;
  /** What to pass to the picked option (agent instruction, status note). Defaults to the note itself. */
  note?: string | null;
  reply?: string;
}

export interface PostInfo {
  /** Where it should live. "site" = the public site (config.writing.site). */
  venue: "wiki" | "site" | "both";
  /** Why it's worth writing: career, team, nobody else is saying it. */
  why?: string;
  /** What the wiki search turned up — the "is anyone already saying this?" check. */
  gap?: string;
  /** Local markdown draft for the internal wiki (config.writing.wiki.draftsDir). */
  wikiDraft?: string;
  /** Site draft in config.writing.site.postsDir (draft: true). */
  siteDraft?: string;
}

export type QuestionKind =
  | "confirm" // is this real / do you agree?
  | "when" // when should this happen?
  | "state" // what's the real state of this?
  | "dispatch" // shall I send an agent?
  | "prep" // meeting coming up — prep?
  | "review" // meeting just ended — review captures
  | "plan" // morning planning
  | "wrap" // end of day
  | "open" // free-form from an agent
  | "post"; // blog-post idea / draft to review

export interface QuestionOption {
  id: string;
  label: string;
  /** Hint shown under the label. */
  hint?: string;
  /** Tone for the button. */
  tone?: "primary" | "good" | "warn" | "danger" | "quiet";
  /** What happens when chosen. Interpreted by the server. */
  effect: Effect;
}

export type Effect =
  | { type: "status"; status: ItemStatus; note?: string }
  /** `inMin` is relative to when it's answered (wins over `at`, which is fixed when asked). */
  | { type: "schedule"; at: string; label: string; inMin?: number }
  | { type: "snooze"; minutes: number }
  /** `note` goes to the agent when the owner typed none (e.g. which of several dispatch options was picked). */
  | { type: "dispatch"; action: ActionKind; note?: string }
  | { type: "open"; url: string; /** keep the question open afterwards */ keep?: boolean }
  /** The owner says when, in words ("booked Thu 14:00", "put it in Friday morning"). Needs the note. */
  | { type: "when" }
  | { type: "noop" }
  /** Run `cloudflared access login <app>` for the model gateway pi uses (one browser tab). */
  | { type: "gatewayLogin"; app: string }
  /** Run triage again on words a failed triage kept (command bar, 🍍, review notes). */
  | { type: "triage"; text: string; mode: "chat" | "pineapple" | "review" }
  | { type: "multi"; effects: Effect[] };

export interface Question {
  id: string;
  kind: QuestionKind;
  itemId?: string;
  /** Overrides the default badge for the kind ("Kill date", "Agent finished"). */
  badge?: string;
  /** Calendar event this question is about (prep / review). */
  eventId?: string;
  prompt: string;
  /** Extra context shown under the prompt (markdown-lite). */
  context?: string;
  options: QuestionOption[];
  /** Higher = asked sooner. */
  priority: number;
  /** Don't show before this. */
  notBefore?: string;
  status: "open" | "answered" | "expired";
  answer?: string;
  /** Dedupe: one open question per key. */
  key: string;
  createdAt: string;
  answeredAt?: string;
}

export type ActionKind =
  | "ticket" // search dupes + file / comment in the tracker
  | "reply" // reply in the source thread
  | "email" // draft an email (never sent)
  | "prep" // 1-1 / meeting prep brief
  | "work" // general: go do the thing, report back
  | "verify" // check the real state of an item and report
  | "draft" // write or revise a blog-post draft
  | "publish"; // publish a reviewed draft (wiki and/or public site)

export type JobKind = "sweep" | "triage" | "action";
export type JobSurface = "headless" | "cmux";
export type JobStatus = "queued" | "running" | "blocked" | "done" | "failed";

export interface Job {
  id: string;
  kind: JobKind;
  name: string; // "transcripts", "calendar", "triage", "ticket"...
  title: string;
  surface: JobSurface;
  status: JobStatus;
  itemId?: string;
  /** cmux workspace id when surface = cmux. */
  workspace?: string;
  /** Last few tool/progress lines, for the live feed. */
  tail: string[];
  summary?: string;
  error?: string;
  /** The agent called `whq report` at least once. */
  reported?: boolean;
  /** Headless pi session file, for audit. */
  session?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees?: string[];
  oneOnOne?: boolean;
  url?: string;
  response?: "accepted" | "declined" | "tentative" | "needsAction";
}

export interface JournalEntry {
  id: string;
  at: string;
  itemId?: string;
  /** The question a typed note answered, so the usage digest can trace item-less notes. */
  questionId?: string;
  /** "you" = the owner, "hq" = the app, "agent" = a dispatched job. */
  who: "you" | "hq" | "agent";
  text: string;
  /** Written to agent-memory yet? */
  synced: boolean;
}

export interface SyncState {
  name: string; // memory | transcripts | calendar | journal
  lastRunAt?: string;
  lastOkAt?: string;
  cursor?: string;
  error?: string;
  /** calendar only: last local day (YYYY-MM-DD) the last good sweep read. */
  through?: string;
}

export interface Snapshot {
  items: Item[];
  questions: Question[];
  jobs: Job[];
  events: CalendarEvent[];
  /** Events after today, up to the furthest defer target. For the defer slot check. */
  upcoming: CalendarEvent[];
  journal: JournalEntry[];
  sync: SyncState[];
  config: PublicConfig;
}

export interface PublicConfig {
  port: number;
  /** Demo mode: made-up data, scripted agents. The UI shows a banner and an exit. */
  demo: boolean;
  /** Demo mode: the live dashboard to go back to. */
  liveUrl?: string;
  cmux: boolean;
  memory: boolean;
  model: string;
  workHours: [number, number];
  owner: { name: string; aliases: string[]; speechLang: string };
  labels: { tracker: string; chat: string; wiki: string; site: string; trackerUrl?: string };
  journalPath: string;
}

/** Server → client push. */
export type ServerEvent =
  | { type: "snapshot"; data: Snapshot }
  | { type: "item"; data: Item }
  | { type: "item:remove"; id: string }
  | { type: "question"; data: Question }
  | { type: "job"; data: Job }
  | { type: "events"; data: CalendarEvent[] }
  | { type: "upcoming"; data: CalendarEvent[] }
  | { type: "journal"; data: JournalEntry }
  | { type: "sync"; data: SyncState }
  | { type: "toast"; data: { text: string; tone?: "good" | "warn" | "info" } }
  | { type: "notify"; data: { title: string; body: string; questionId?: string } };

/**
 * What a dispatched agent sends back to POST /api/agent/report.
 * Everything optional: a report can be partial and arrive more than once.
 */
export interface AgentReport {
  jobId?: string;
  summary?: string;
  status?: "done" | "failed" | "progress";
  items?: Array<Partial<Item> & { title: string; kind?: ItemKind }>;
  updates?: Array<{ id: string } & Partial<Pick<Item, "status" | "title" | "detail" | "links" | "when" | "scheduledFor" | "project" | "people" | "post">> & { note?: string }>;
  questions?: Array<{
    prompt: string;
    context?: string;
    itemId?: string;
    /** Checks only: the `source.key` of an item in the same report (they can't know its id yet). */
    itemKey?: string;
    /** Stable dedupe key. Default: a hash of the prompt. */
    key?: string;
    /** Ask once per key: never re-ask after it's been answered. */
    once?: boolean;
    /** Plain labels are mapped to effects by keyword; objects say exactly what happens.
     *  `note` rides along with `action` to the dispatched agent.
     *  `url` (http/https) opens the link and keeps the question open, e.g. a deep link to approve something. */
    options?: Array<string | { label: string; status?: ItemStatus; action?: ActionKind; note?: string; url?: string }>;
    priority?: number;
  }>;
  events?: CalendarEvent[];
  /** With `events`: the last local day (YYYY-MM-DD) they cover, so empty days get cleared too. */
  eventsThrough?: string;
  journal?: string[];
  cursor?: string;
  /** Transcript sweep: every meeting whose notes it read, items or not. Closes "X just ended" questions. */
  meetings?: Array<{ title: string; start?: string; url?: string }>;
}
