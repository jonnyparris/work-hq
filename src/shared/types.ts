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
    dueFrom?: "clairic";
    lowConfidence?: boolean;
    pineapple?: boolean;
  };
  /** Blog-post ideas only. */
  post?: PostInfo;
  /** Last time the owner confirmed the state themselves. The whole point of the app. */
  confirmedAt?: string;
  /** What the owner typed about it (plus Work HQ's replies and agents' notes, marked by `who`). Kept apart from
   *  `detail` so memory re-imports never wipe it. */
  notes?: ItemNote[];
  /**
   * Set when a reflection proposal merged into this item (same title as an active-todos line, or a twin from
   * another source). Holds the proposal's section label, "Proposals 2026-10-19 · High Priority (…)". The item keeps
   * its own source, so without this the proposal card (prompter §8) never fires for it.
   */
  proposalOf?: string;
  /** "Explain simply" in the drawer: a plain-English read of title + detail + quote. `for` = what it was written from. */
  explain?: ItemExplain;
  createdAt: string;
  updatedAt: string;
}

export interface ItemExplain {
  at: string;
  /** Fingerprint of the title, detail and quote it explained. A mismatch means the item changed since. */
  for: string;
  /** What this is, in one or two plain sentences. */
  what: string;
  /** Why it matters / why it's on your list. */
  why?: string;
  /** What "done" looks like. */
  done?: string;
  /** Jargon from the item, each explained in a few words. */
  terms?: Array<{ term: string; meaning: string }>;
}

export interface ItemNote {
  at: string;
  text: string;
  /** "hq" = Work HQ's own reply to a note (an ELI5, an answer). "agent" = an agent posted it (PATCH with
   *  who "agent"). Absent = the owner typed it. */
  who?: "hq" | "agent";
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
  /** `itemId` targets another item than the question's (a batched card's "mark all done" is a multi of these). */
  | { type: "status"; status: ItemStatus; note?: string; itemId?: string }
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
  /** Run `cloudflared access login <app>` for any other Access app a local job needs (`whq access-login`). */
  | { type: "accessLogin"; app: string }
  /** Run triage again on words a failed triage kept (command bar, 🍍, review notes). */
  | { type: "triage"; text: string; mode: "chat" | "pineapple" | "review" }
  /** Morning plan: the items picked on the card (sent with the answer as `itemIds`) go to today. */
  | { type: "commitPlan" }
  /** Morning prep card: send a prep agent for each meeting ticked in the card's `picks` (sent with the answer as `picks`). */
  | { type: "prepMeetings" }
  /** Recheck card: mark done each item ticked in the card's `picks` (pick id = item id, hint = what landed), or every pick with `all`. */
  | { type: "donePicks"; all?: boolean }
  /** Stale card: close each card ticked in `picks` (pick id = question id), or every pick with `all`. */
  | { type: "closePicks"; all?: boolean }
  /**
   * Stopped-agents card (server/stopped-fold.ts): for each item ticked in `picks` (or every pick with `all`), `check`
   * sends a verify agent about its stopped job, `rerun` sends that job's action again with its note. `jobs`: item id → job id.
   */
  | { type: "stoppedPicks"; act: "check" | "rerun"; all?: boolean; jobs: Record<string, string> }
  /** Write the journal to memory now (wrap-up). */
  | { type: "flushJournal" }
  /** Run a sweep now ("Scan the transcript now"). `since` (ISO, transcripts only): read from there, not the cursor (the folded card's earlier days). */
  | { type: "sweep"; name: "transcripts" | "calendar"; since?: string }
  /**
   * Focus the cmux session of the question's item's latest job; toast if it was closed. `keep`: the card stays
   * open, like `open` with keep — looking at the session isn't an answer (10-19: the after-card closed, item stuck on doing).
   */
  | { type: "focusSession"; keep?: boolean }
  | { type: "multi"; effects: Effect[] };

export interface Question {
  id: string;
  kind: QuestionKind;
  itemId?: string;
  /** Overrides the default badge for the kind ("Kill date", "Agent finished"). */
  badge?: string;
  /** Calendar event this question is about (prep / review). */
  eventId?: string;
  /** Tick-boxes shown on the card (the morning prep card's meetings). The tapped option gets the ticked ids. */
  picks?: QuestionPick[];
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
  /** Put back by hub.reopen (keep/snooze): the id of the card it copies. Not a new ask (usage digest skips it). */
  reopenedFrom?: string;
}

export interface QuestionPick {
  id: string;
  label: string;
  hint?: string;
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
  /** Action jobs: the one answer that sent this job ("<question> → <option>"). Its prompt scopes the job to it,
   *  so parallel jobs on one item don't each act on every note (10-22: four jobs filed KITE-166/167/168/169). */
  decision?: string;
  /** Action jobs: the instruction passed with the dispatch, kept to spot a double dispatch of the same thing. */
  note?: string;
  /** cmux workspace id when surface = cmux. */
  workspace?: string;
  /** Last few tool/progress lines, for the live feed. */
  tail: string[];
  summary?: string;
  error?: string;
  /** The agent called `whq report` at least once. */
  reported?: boolean;
  /** Action jobs: new idea items this job has filed (capped at IDEA_CAP across all its reports). */
  ideasFiled?: number;
  /** Action jobs: titles of idea items over the cap, folded into the summary instead of filed. */
  ideasFolded?: string[];
  /** cmux jobs: in-place "carry on" nudges sent after a turn failed, by cause (the usage digest counts them). */
  nudges?: {
    rateLimit?: number;
    transient?: number;
    /** Beacon seq of the errored turn the network-blip nudge answered (tells a restart "nudge typed, no turn yet"). */
    transientSeq?: number;
  };
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
  /** On an hq line about a typed note: that note's journal id, so the digest doesn't credit it to a later note on the same card. */
  noteId?: string;
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

/** The nightly reflection's coaching block: this week's signal and the one move to try next. */
export interface Coaching {
  /** Date of the reflection file it came from (YYYY-MM-DD). */
  date: string;
  /** "Mixed", "Strong", … as written. Empty if the block didn't say. */
  signal: string;
  /** The bit after "One thing to try", e.g. "tomorrow (Tue 10-20, before the 09:30 blog slot)". */
  when: string;
  /** Markdown body of "One thing to try": bullets, numbered steps. */
  move: string;
  /** Bold lead of each "what you did well" / "operating below" bullet. */
  wins: string[];
  gaps: string[];
  /** Memory path of the source file, and a link that opens it. */
  file?: string;
  url?: string;
  /** What became of recent moves (the "M5 move: … Did it happen?" card), newest first. Filled by the hub, not stored. */
  history?: CoachOutcome[];
}

/**
 * One reflection's move and its card's answer. "missed": the card expired unanswered (a newer reflection came first).
 * "agent": handed off and its `coach:move:<date>` item is still open; once that item closes the outcome becomes
 * "done" or "not" with `via: "agent"`.
 */
export interface CoachOutcome {
  date: string;
  outcome: "done" | "agent" | "not" | "missed";
  /** The note typed with the answer, if any. */
  note?: string;
  /** Set when the move was handed to an agent and its item has since closed. */
  via?: "agent";
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
  coaching?: Coaching;
  /** Latest load-average sample (src/server/load.ts). */
  load?: LoadNow;
  config: PublicConfig;
}

/** One load-average sample, as the Agents panel shows it. */
export interface LoadNow {
  at: string;
  l1: number;
  l5: number;
  l15: number;
  cores: number;
  /** Action jobs running at the sample. */
  jobs: number;
  /** pi.maxLoad: launches hold while l1 is above it. 0 = off. */
  max: number;
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
  | { type: "coaching"; data: Coaching }
  | { type: "load"; data: LoadNow }
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
  /** Boss check: open questions whose premise no longer holds (the PR merged, the job died). Each is expired with
   *  the reason, no effect runs. To also move the item, send an `updates` entry for it. */
  closeQuestions?: Array<{ id: string; reason: string }>;
  cursor?: string;
  /** Transcript sweep: every meeting whose notes it read, items or not. Closes "X just ended" questions. */
  meetings?: Array<{ title: string; start?: string; url?: string }>;
}
