// Configuration. Three layers, later wins:
//   1. defaults below (generic — nothing company-specific)
//   2. a JSON config file (comments allowed), first found of:
//        $WORK_HQ_CONFIG · ./work-hq.config.json · ~/.config/work-hq/config.json
//   3. WORK_HQ_* environment variables (handy for sandboxes and launchd)
//
// Paths may start with "~". Relative paths resolve against the config file's folder.
// See work-hq.config.example.json for every key with a comment.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

const HOME = homedir();
const env = (k: string) => process.env[k] || undefined;

export const ROOT = resolve(import.meta.dir, "../..");

/** JSON with // and /* *\/ comments and trailing commas. String-aware. */
export function parseJsonc(text: string): any {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function findConfigFile(): string | undefined {
  if (env("WORK_HQ_CONFIG") === "none") return undefined; // tests and demos: defaults only
  const candidates = [env("WORK_HQ_CONFIG"), resolve(ROOT, "work-hq.config.json"), resolve(HOME, ".config/work-hq/config.json")];
  return candidates.find((p): p is string => Boolean(p && existsSync(p)));
}

export const CONFIG_FILE = findConfigFile();
const raw: any = CONFIG_FILE ? parseJsonc(readFileSync(CONFIG_FILE, "utf8")) : {};
// Follow symlinks so a config kept in a dotfiles/notes repo resolves ./paths next to the real file.
const base = CONFIG_FILE ? dirname(realpathSync(CONFIG_FILE)) : process.cwd();

/** "~/x" → home, "./x" → next to the config file, absolute stays. */
export function path(p: string): string;
export function path(p: string | undefined): string | undefined;
export function path(p: string | undefined) {
  if (!p) return undefined;
  if (p === "~" || p.startsWith("~/")) return resolve(HOME, p.slice(2));
  return isAbsolute(p) ? p : resolve(base, p);
}

function readToken(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const get = (obj: any, keys: string) => keys.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const pick = <T>(envKey: string | undefined, key: string, fallback: T): T => {
  const e = envKey ? env(envKey) : undefined;
  if (e !== undefined) return (typeof fallback === "number" ? Number(e) : e) as T;
  const v = get(raw, key);
  return v === undefined || v === null ? fallback : (v as T);
};

export interface Project {
  /** Short label shown on cards, e.g. "PAY". Also the ticket prefix it matches. */
  key: string;
  /** Optional case-insensitive regex; text matching it is tagged with this project too. */
  match?: string;
}

export interface RepoRule {
  /** Item project this repo belongs to (case-insensitive), e.g. "work-hq". */
  project?: string;
  /** Or: case-insensitive regex on the item title. */
  match?: string;
  /** The main checkout. Worktrees go next to it as <dir>-job-<id>. */
  dir: string;
  /** Run before landing, in the worktree, e.g. "bun test && bun run typecheck". */
  check?: string;
  /** Run in the worktree after landing, e.g. "scripts/publish.sh github". */
  publish?: string;
  /** Run after landing when non-doc files changed, e.g. a launchctl kickstart. */
  restart?: string;
  /** Action kinds that get a worktree. Default ["work"]. */
  actions?: string[];
}

const STATE_DIR = path(pick("WORK_HQ_STATE", "stateDir", "~/.local/state/work-hq"));
const WORKSPACE = path(pick("WORK_HQ_WORKSPACE", "workspace.dir", "~"));
const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const memoryTokenFile = path(pick<string | undefined>("WORK_HQ_MEMORY_TOKEN_FILE", "memory.tokenFile", undefined));
const memoryToken = env("WORK_HQ_MEMORY_TOKEN") ?? get(raw, "memory.token") ?? readToken(memoryTokenFile);

const clairicTokenFile = path(pick<string | undefined>("WORK_HQ_CLAIRIC_TOKEN_FILE", "deadlines.clairic.tokenFile", undefined));
const clairicToken = env("WORK_HQ_CLAIRIC_TOKEN") ?? readToken(clairicTokenFile);

const caFile = path(pick<string | undefined>("WORK_HQ_CA_FILE", "tls.caFile", undefined));

/** labels.trackerUrl "https://jira.example.com/browse/" → ["jira.example.com"]; a non-JIRA tracker → []. */
function jiraHostFromTracker(u: string): string[] {
  try {
    const url = new URL(u);
    return /^\/browse\/?$/.test(url.pathname) ? [url.host] : [];
  } catch {
    return [];
  }
}

export const config = {
  file: CONFIG_FILE,
  /** Demo mode: made-up data, scripted agents, nothing real reached. Set by `bin/work-hq demo`. */
  demo: env("WORK_HQ_DEMO") === "on",
  /** In demo mode: where "Exit demo" goes back to. */
  liveUrl: env("WORK_HQ_LIVE_URL") ?? "http://localhost:7717",
  /** Port the demo toggle starts the sandbox on. */
  demoPort: Number(env("WORK_HQ_DEMO_PORT") ?? 7718),
  port: pick("WORK_HQ_PORT", "server.port", 7717),
  dbPath: path(pick("WORK_HQ_DB", "server.db", resolve(STATE_DIR, "work-hq.db"))),
  stateDir: STATE_DIR,

  /** Who this dashboard works for. Goes into every prompt. */
  owner: {
    name: pick("WORK_HQ_OWNER", "owner.name", "the user"),
    role: pick<string>(undefined, "owner.role", ""),
    company: pick<string>(undefined, "owner.company", ""),
    location: pick<string>(undefined, "owner.location", ""),
    timezone: pick("WORK_HQ_TZ", "owner.timezone", systemTz),
    /** Names / email prefixes that mean "me" — hidden from attendee lists. */
    aliases: [] as string[], // filled below: owner.aliases + owner.name
    /** Speech recognition language for dictation and 🍍. */
    speechLang: pick<string>(undefined, "owner.speechLang", "en-GB"),
  },

  /** Where agents run (cwd) and where scratch files go. Your notes vault or agent home. */
  workspace: {
    dir: WORKSPACE,
    scratchDir: path(pick<string>(undefined, "workspace.scratchDir", resolve(WORKSPACE, "scratch"))),
    /** Obsidian vault name whose root is workspace.dir. Unset → drafts open as plain files. */
    obsidianVault: pick<string | undefined>(undefined, "workspace.obsidianVault", undefined),
  },

  memory: {
    /** An MCP server with read/write/list/search tools over markdown files. Unset → memory off. */
    url: pick<string | undefined>("WORK_HQ_MEMORY_URL", "memory.url", undefined),
    token: memoryToken as string | undefined,
    journalPath: pick<string>(undefined, "memory.journalPath", "memory/workload/work-hq-journal.md"),
    todosPath: pick<string>(undefined, "memory.todosPath", "memory/workload/active-todos.md"),
    /** Folder with dated `*-improvement-proposals.md` files (only the newest is read). */
    proposalsDir: pick<string>(undefined, "memory.proposalsDir", "memory/workload/plans"),
    /** Proposals queued by the `learn` skill at the end of pi sessions. Missing file → none. */
    learnProposalsPath: pick<string>(undefined, "memory.learnProposalsPath", "memory/workload/learn-proposals.md"),
    /** Sandboxes must set this off — test statements are not facts. Defaults off for a non-default DB. */
    write: (env("WORK_HQ_MEMORY_WRITE") ?? (env("WORK_HQ_DB") ? "off" : get(raw, "memory.write") === false ? "off" : "on")) !== "off",
    importEveryMin: pick("WORK_HQ_MEMORY_EVERY", "memory.importEveryMin", 30),
    flushEveryMin: pick("WORK_HQ_JOURNAL_EVERY", "memory.flushEveryMin", 5),
  },

  pi: {
    bin: path(pick("WORK_HQ_PI", "pi.bin", "~/.local/bin/pi")),
    /** Empty → pi's own default model. */
    model: pick<string>("WORK_HQ_MODEL", "pi.model", ""),
    triageThinking: pick("WORK_HQ_TRIAGE_THINKING", "pi.triageThinking", "low"),
    sweepThinking: pick("WORK_HQ_SWEEP_THINKING", "pi.sweepThinking", "medium"),
    /** Extra env for headless tool runs (e.g. a permissions config your pi extensions read). */
    headlessEnv: pick<Record<string, string>>(undefined, "pi.headlessEnv", {}),
    /** Tools headless sweeps must never use. */
    headlessDenyTools: pick<string>(undefined, "pi.headlessDenyTools", "edit,write,ask_user_question,cmux_open_terminal"),
    /** Minimum gap between pi launches (headless and cmux). Keeps bursts under per-minute provider limits. 0 = off. */
    launchSpacingSec: Number(pick("WORK_HQ_LAUNCH_SPACING", "pi.launchSpacingSec", 20)),
    /**
     * Most action jobs (cmux or headless) working at once; more wait in the queue, oldest first. "Blocked"
     * (waiting for you) and finished-but-open sessions don't count. 10-21: 20-25 at once drove load to 255. 0 = off.
     */
    maxRunningJobs: Number(pick("WORK_HQ_MAX_RUNNING_JOBS", "pi.maxRunningJobs", 8)),
    /** On a provider rate-limit / 503 error, retry this many times. 0 = off. */
    rateLimitRetries: Number(pick("WORK_HQ_RATE_LIMIT_RETRIES", "pi.rateLimitRetries", 2)),
    /** Wait a random time in this range (seconds) before each rate-limit retry. */
    rateLimitBackoffSec: pick<[number, number]>(undefined, "pi.rateLimitBackoffSec", [60, 90]),
    /** How headless pi runs: "rpc" (prompt over stdin, warm triage workers) or "print" (the old `pi -p @file`). */
    runner: pick<string>("WORK_HQ_PI_RUNNER", "pi.runner", "rpc") === "print" ? ("print" as const) : ("rpc" as const),
    /** Warm pi workers kept for triage (rpc runner). 0 = start one per request. */
    triageWorkers: Number(pick("WORK_HQ_TRIAGE_WORKERS", "pi.triageWorkers", 1)),
    /** Abort a headless tool run that has sent no event for this long. 0 = off. */
    stallMin: Number(pick("WORK_HQ_STALL_MIN", "pi.stallMin", 10)),
    /**
     * Fetch the model-gateway token once and pass it to every run in `env`, instead of each run forking
     * the provider's key command. Only useful if that key command reads `env` first. Unset = off.
     */
    gatewayToken: pick<{ env: string; command: string } | undefined>(undefined, "pi.gatewayToken", undefined),
  },

  sweeps: {
    transcriptsEveryMin: pick("WORK_HQ_TRANSCRIPTS_EVERY", "sweeps.transcriptsEveryMin", 30),
    calendarEveryMin: pick("WORK_HQ_CALENDAR_EVERY", "sweeps.calendarEveryMin", 120),
    /** Writing scout cadence (blog-post ideas + drafts). 0 = off. */
    postsEveryDays: pick("WORK_HQ_POSTS_EVERY_DAYS", "sweeps.postsEveryDays", 7),
    /** Local hours [start, end) when background sweeps run. */
    workHours: [pick("WORK_HQ_DAY_START", "sweeps.dayStart", 8), pick("WORK_HQ_DAY_END", "sweeps.dayEnd", 19)] as [number, number],
    /** Sweeps can be made visible in cmux too; default headless (they're read-only). */
    surface: pick("WORK_HQ_SWEEP_SURFACE", "sweeps.surface", "headless") as "headless" | "cmux",
    /** Turn individual sweeps off by listing them here, or everything with WORK_HQ_SWEEPS=off. */
    enabled: env("WORK_HQ_SWEEPS") ? env("WORK_HQ_SWEEPS") !== "off" : get(raw, "sweeps.enabled") !== false,
    disabled: pick<string[]>(undefined, "sweeps.disabled", []),
  },

  /** Checks: shell commands that print `{ items: [...] }` JSON, run once per workday (from dayStart, or `after` "HH:MM"), or every `everyMin` minutes in work hours. See src/server/checks.ts. */
  checks: pick<{ name: string; command: string; timeoutSec?: number; after?: string; everyMin?: number }[]>(undefined, "checks", []),

  /**
   * Repos many agents edit at once. A work job on an item of `project` (or whose title matches `match`) gets its own
   * worktree of `dir`, made by the server, and lands it with `whq land <jobId>`. See src/server/worktrees.ts.
   */
  repos: pick<RepoRule[]>(undefined, "repos", []).map((r) => ({ ...r, dir: path(r.dir) })),

  /** Ticket prefixes / keywords that tag items with a project. */
  projects: pick<Project[]>(undefined, "projects", []),

  /** Names used in the UI and prompts. */
  labels: {
    tracker: pick<string>(undefined, "labels.tracker", "issue tracker"),
    chat: pick<string>(undefined, "labels.chat", "team chat"),
    /** Ticket keys (ABC-123) anywhere in the UI link to `<trackerUrl><KEY>`, e.g. "https://linear.app/acme/issue/". */
    trackerUrl: pick<string>("WORK_HQ_TRACKER_URL", "labels.trackerUrl", ""),
  },

  jira: {
    /** Hosts whose /browse/KEY links are looked up (cloudflared Access token) for the "Ticket done" card. */
    hosts: pick<string[]>(undefined, "jira.hosts", jiraHostFromTracker(pick<string>("WORK_HQ_TRACKER_URL", "labels.trackerUrl", ""))),
  },

  writing: {
    wiki: {
      name: pick<string>(undefined, "writing.wiki.name", "internal wiki"),
      draftsDir: path(pick<string>(undefined, "writing.wiki.draftsDir", resolve(WORKSPACE, "scratch/blog-drafts"))),
    },
    /** Your public site. Unset postsDir → site drafts are skipped. */
    site: {
      name: pick<string>(undefined, "writing.site.name", "personal site"),
      postsDir: path(pick<string | undefined>(undefined, "writing.site.postsDir", undefined)),
      repoDir: path(pick<string | undefined>(undefined, "writing.site.repoDir", undefined)),
    },
  },

  /** Folder of prompt overrides. Same file names as ./prompts; missing files fall back to the defaults. */
  promptsDir: path(pick<string | undefined>("WORK_HQ_PROMPTS", "promptsDir", undefined)),

  cmux: {
    bin: [env("CMUX_BIN"), "/Applications/cmux.app/Contents/Resources/bin/cmux"].find((p) => p && existsSync(p)),
    group: pick<string>(undefined, "cmux.group", "Work HQ"),
    /** Close a job's cmux workspace once its pi session has been idle this long. 0 = never. The pi session file stays, so `pi --resume` brings it back. */
    pruneIdleHours: Number(pick("WORK_HQ_CMUX_PRUNE_HOURS", "cmux.pruneIdleHours", 3)),
    /** Sooner for a job that finished cleanly with nothing left to ask: close after this many idle minutes. 0 = use pruneIdleHours. */
    pruneDoneMinutes: Number(pick("WORK_HQ_CMUX_PRUNE_DONE_MINUTES", "cmux.pruneDoneMinutes", 20)),
  },

  /** Push-to-talk dictation ("Scheduled for…", the command-bar mic). See src/server/transcribe.ts. */
  voice: {
    /** auto = HEX if running, else `command` if set, else Chrome Web Speech. */
    dictation: pick("WORK_HQ_DICTATION", "voice.dictation", "auto") as "auto" | "browser" | "hex" | "command",
    /** Shell command that transcribes {file} (a 16 kHz mono WAV) and prints the text. */
    command: pick<string | undefined>("WORK_HQ_DICTATION_COMMAND", "voice.command", undefined),
    hex: {
      /** Empty → whatever model HEX has selected. */
      model: pick<string>(undefined, "voice.hex.model", ""),
      discoveryFile: path(pick<string | undefined>(undefined, "voice.hex.discoveryFile", undefined)),
    },
    /** Silence that ends a recorded dictation. */
    silenceMs: Number(pick(undefined, "voice.silenceMs", 1400)),
  },

  /**
   * Deadlines the to-do text states in words ("before the offsite", "within two weeks") that the built-in
   * parser can't resolve: one batched call per import to Workers AI's Clairic model. Needs an account ID
   * and a token with Workers AI Read only. Unset = off. See src/server/deadlines.ts.
   */
  deadlines: {
    clairic: {
      accountId: pick<string | undefined>("WORK_HQ_CLAIRIC_ACCOUNT", "deadlines.clairic.accountId", undefined),
      token: clairicToken,
      minConfidence: Number(pick(undefined, "deadlines.clairic.minConfidence", 0.9)),
    },
  },

  /** Corporate TLS interception? Point at the root CA bundle; exported to every child process. */
  caFile: caFile && existsSync(caFile) ? caFile : undefined,
};

config.owner.aliases = [...new Set([...(get(raw, "owner.aliases") ?? []), config.owner.name].map((a: string) => a.toLowerCase()))];

export type Config = typeof config;

export const memoryOn = () => Boolean(config.memory.url && config.memory.token);
export const sweepOn = (name: string) => config.sweeps.enabled && !config.sweeps.disabled.includes(name);
