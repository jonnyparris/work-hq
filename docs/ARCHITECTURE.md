# Work HQ — architecture

## Shape

```
                       ┌──────────────── Chrome (localhost:7717) ────────────────┐
                       │  Focus question · Board · Timeline · Agents · Journal   │
                       │  Command bar (⌘K) · Dictation · 🍍 always-on listener    │
                       └───────────────▲─────────────────────┬───────────────────┘
                                WebSocket (push)        HTTP (answers, say, dispatch)
                       ┌───────────────┴─────────────────────▼───────────────────┐
                       │                  Bun server (one process)                │
                       │  Hub ── state transitions, journal, pub/sub              │
                       │  Prompter ── deterministic "what to ask now" rules       │
                       │  Scheduler ── ticks, sweeps, memory import/flush         │
                       │  Agents ── the only place pi is spawned                  │
                       │  SQLite (~/.local/state/work-hq/work-hq.db)              │
                       └───┬──────────────┬──────────────────┬───────────────────┘
            memory MCP     │   pi --mode rpc (headless, events)│  pi in cmux (beacon)
          (HTTP, token)    │   sweeps + triage                │  dispatched actions
                           ▼              ▼                   ▼
                    markdown memory   your MCPs / CLIs        same tools, human-visible
                                   (via pi's own auth)       ── bin/whq report ──▶ server
```

### Why this split

- **The rules decide when to interrupt; the model decides what things mean.** Prompter is
  plain code — predictable, testable, cheap to run every 30s. The model does extraction
  (transcripts, 🍍), interpretation (what you said), and work (dispatched actions).
- **pi owns all credentials that need OAuth.** Your calendar, chat, tracker and code-review
  MCPs live inside pi; rather than scrape their tokens, Work HQ asks pi sessions to do the
  work and report back over HTTP (`bin/whq`). The memory MCP has a static token, so memory
  I/O is direct.
- **Agents don't file ideas unasked.** The report contract allows a new idea item only when you asked,
  the agent found a defect it didn't fix, or the dispatch note says "file ideas"; anything else is one
  "Could also:" line in the summary. As a backstop, an action job files at most 2 new ideas
  (`src/shared/ideas.ts`); hub folds the rest into its summary. `bin/work-hq usage` shows ideas filed per day.
- **The model login is pi's too.** pi reaches the model through whatever provider `pi.model` names
  (a gateway behind Cloudflare Access, say). When that login lapses, headless pi can't open a browser,
  so every sweep would fail. Work HQ spots the "API key auth failed for provider …" error, asks once
  ("Log in now" runs `cloudflared access login <app>`, one tab), and pauses sweeps. It retries once
  every 30 min until a run works again.
  A local job that needs another Access app (launchd scripts; first user: browser-run-growth) calls
  `whq access-login <app>` instead of a 🍍: one "Log in now" card per app per day
  (`access-login:<host>:<day>`, `Hub.accessLoginCard`), no triage job; `whq access-ok <app>` closes it.
- **Headless pi runs over RPC, never with the prompt in argv** (`src/server/pi-rpc.ts`). Endpoint
  security (SentinelOne) SIGKILLs any exec whose argv holds a string over ~1 KB, so prompts go over
  stdin (`pi --mode rpc`) and `assertShortArgs` rejects anything over 512 bytes. Each tool run gets its
  own process (its own env, kill to cancel). Tool-less triage uses a warm worker (`pi.triageWorkers`,
  default 1) that arms a fresh session after every run and retires itself after 50 runs, 30 min idle,
  2 h, a crash, a timeout, or a pi/extension update. A request that finds no idle worker waits for the
  one re-arming, or gets a one-off. Deadlines abort first (the run settles, the session is kept) and
  SIGKILL 15 s later. A tool run with no event for `pi.stallMin` (default 10) is aborted as stalled; a
  headless-fallback work job also stops at a 120 min ceiling (busy, not hung). The ceiling is per
  attempt (a rate-limit retry starts a fresh one). The stall watchdog is rpc-only (`pi.runner: "rpc"`,
  the default); print runs have only the ceiling.
  The rpc deadline and idle clocks count awake time only (print's ceiling is wall clock): a watchdog tick over 30 s late means the laptop slept, and the gap
  moves the deadline and the idle limit out instead of aborting (`sleptMs`, a `☾` line in the job log).
  A sweep that still fails after a sleep says `machine slept mid-run (N min), then …` and is due again on
  the next awake tick. No sweeps start for 3 min after a wake: Power Nap DarkWakes (2–10 s) fire the
  overdue cadence tick and froze the sweep they started (10-19: all four non-restart sweep failures).
  RPC request timeouts (the 60 s prompt ack) follow the same rule: a timer that fires over 30 s late
  waits again instead of failing the run.
  Dialogs (permission asks) are declined, as print mode does. `pi.runner: "print"` brings back the
  old `pi -p @file` path.
- **One gateway token for all pi runs** (`pi.gatewayToken`, `src/server/gateway-token.ts`).
  The server runs the token command once, passes the token in the env var the provider's key command
  prefers, refreshes it 5 min before the JWT's `exp`, and drops it on an auth error. cmux sessions
  get it too (in `launch.sh`, mode 0600), but only with 24 h left: the key command never re-mints
  while the env var is set, and a session can stay open for hours. A cmux turn that ends on an auth
  error raises the same "Login expired" card as a headless one; a clean turn retires it.
  Without the env var, pi-plugin (0.18+, native pi) mints once, keeps the token in-process,
  re-mints 15 min before `exp` and logs in again by itself when the session lapsed. Access JWTs
  last 30 days, so the 24 h cut-off costs one `cloudflared` spawn per session start on the last day.
  A token file the plugin re-reads (proposed 10-21) was dropped: it needs a plugin MR, puts the
  token on disk, and like the env var it is an override the plugin's own re-login can't change, so
  a lapse would wait on the server rewriting the file instead of being fixed in the session.
- **Company-specific instructions are data, not code.** Which tools to call, how tickets are
  filed, what voice replies use: all in `prompts/*.md`, overridable per user (`promptsDir`).
  Output shapes the server parses stay in `src/server/prompts.ts`.
- **Anything that writes to the world is visible.** Dispatched actions run as interactive pi
  in cmux, grouped under "Work HQ", with a small pi extension (`pi/status-beacon.ts`) telling the
  server when a turn settles, blocks on input, or exits. Sweeps are read-only and headless,
  but stream tool calls into the Agents panel. `WORK_HQ_SWEEP_SURFACE=cmux` if you want those
  in cmux too. Every 10 minutes the scheduler closes job workspaces whose session has been idle
  (beacon `idle`/`exited`) longer than `cmux.pruneIdleHours` (default 3), or `cmux.pruneDoneMinutes`
  (default 20) when the job finished cleanly and nothing is open on its item. It never touches a
  workspace that is selected, pinned, still working, or waiting on you.
- **Restarts wait for headless runs.** `whq land` and `scripts/worktree.sh land` on the server's own checkout ask the
  server (`POST /api/restart`) instead of kickstarting it. The server runs its repo rule's `restart` once no
  headless job (sweep, triage, work fallback) is live, starts no new sweeps meanwhile, folds several landings into one
  restart, and gives up waiting after 25 min (`src/server/restart.ts`), so a headless work job that
  runs longer dies on a landing (cmux work jobs don't). Boot sweeps only what's due by
  its last good run, so a restart doesn't start a fresh calendar sweep for the next one to kill.
  A cmux job the restart caught before launch goes back on the gate with its saved prompt. If cmux
  doesn't answer the first ping (busy under load), boot keeps pinging every 3 s for up to 60 s, without
  blocking the server, before failing those jobs. No cmux binary configured: they fail at once. Server
  `console.log/info/warn/error/debug` lines in `~/Library/Logs/work-hq.log` start (after any blank spacer lines) with an ISO timestamp
  (crash output from bun itself doesn't).
- **Provider rate limits are waited out, not fatal.** Every pi launch with tools (cmux actions,
  sweeps) goes through one launch gate (`src/server/launch-gate.ts`) that spaces starts at least
  `pi.launchSpacingSec` apart (default 20). Tool-less triage skips the gate. If a run still dies
  on a rate limit, 429, 503 or "overloaded" (e.g. the per-org "Grammar compilation rate limit",
  20/min), Work HQ waits 60–90 s (`pi.rateLimitBackoffSec`) and retries up to `pi.rateLimitRetries`
  (default 2) times. A cmux session is nudged in place ("carry on"); a headless tool run resumes
  its own session so finished tool calls aren't repeated. pi's own retries (2/4/8 s) sit inside
  this and don't outlast a per-minute limit on their own.
- **Network blips get one retry.** A cmux turn that ends on "Request timed out.", "Connection error."
  or a cut stream (`isTransient` in `src/server/launch-gate.ts`) leaves pi idle for good. Unless the
  agent already reported, Work HQ nudges the session once after 60 s (`TRANSIENT_RETRY_MS`, through the
  launch gate so a burst of blips doesn't come back at once). If the retried turn blips too, the job
  fails at once with "(again after one retry)" and a notification, instead of sitting out the 3-min
  error grace. A turn you type before the nudge goes out drops it and gets its own retry. A restart
  between the nudge and its turn waits up to 120 s for that turn rather than failing it as a second
  blip. Nudges sent are kept on the job (`job.nudges`) and `bin/work-hq usage` counts them under
  "Agent runs". 10-19 and 10-22: the owner typed "retry" into 13 stalled sessions by hand.
  Tool-less triage gets one retry too: a blip whose attempt ran under 60 s, machine sleep excluded and
  rate-limit backoff included (`TRIAGE_BLIP_MAX_FIRST_MS`), reruns once after 10 s (`TRIAGE_BLIP_RETRY_MS`); a second failure
  puts the words on a Retry / Drop card. No card on the first blip, just a journal and job-log line;
  not counted in `job.nudges`.
- **At most 8 action agents work at once.** The launch gate spaces starts but doesn't cap them: on
  10-21 a burst had 20-25 pi sessions working together, load hit 255 on 12 cores and test suites
  everywhere timed out. `RunCap` (`src/server/launch-gate.ts`) holds launches past
  `pi.maxRunningJobs` (default 8, 0 = off) as "queued" in the Agents panel, oldest first, until a
  running one finishes, fails, is stopped or blocks on you. Blocked and finished-but-open sessions
  don't count; sweeps and triage aren't capped. A blocked session you resume counts again at once,
  so the count can go over the cap until a session finishes; a job stuck on "running" holds its slot until you Stop it.
- **Load is logged, and can gate launches.** The job count is a proxy; load is what hurts. The
  scheduler samples `os.loadavg()` once a minute into the `load` table (8 days kept) with the number
  of action jobs running (`src/server/load.ts`). The Agents header shows the latest 1-min load (gold
  above the core count). `GET /api/load?hours=24` returns the samples plus a summary (peak, minutes
  over the core count, Pearson r between running jobs and load, mean load per job count), and
  `bin/work-hq usage` prints the same as "Machine load". `pi.maxLoad` (default 0 = off) makes
  `RunCap` also hold launches while the 1-min load is above it, but only while one of ours is
  running, so outside load can't stall an empty queue. A 15 s timer re-checks held launches.
- **Human decisions are the source of truth.** `confirmedAt` is set whenever the owner decides
  something. Memory re-imports refresh text but never undo a confirmed status.

## Data model (src/shared/types.ts)

- **Item** — the unit of work. `kind` (task, ticket, message, email, followup, decision,
  review, meeting, idea) decides which action fits; `status` walks inbox → proposed →
  today/scheduled → doing/waiting → done/dropped. `signals` carries what the parser found
  in memory text (state unknown, kill date, due date, pineapple). Due dates come from
  `src/server/deadlines.ts`: a cue ("by", "due", "before", "target") right before a date phrase
  ("30 Oct", "10-19", "Friday", "end of next week"), resolved against today. With
  `deadlines.clairic` set, what that leaves unresolved goes to Workers AI's Clairic model in one
  batched call per import (cue clauses only, confidence ≥ 0.9, a date copied from the text refused).
- **Question** — one ask with 2–6 options. Each option has an **Effect** (status, schedule,
  snooze, dispatch). Keyed for dedupe with cooldowns, so answering "Doing it today" doesn't
  bring the same question back tomorrow morning.
- **Notes** — what you typed about an item (`item.notes`). Kept apart from `detail`, so memory
  re-imports can't wipe them. They go into every agent prompt and show under the next question.
- **Job** — a pi run. `sweep` / `triage` headless, `action` in cmux.
- **JournalEntry** — every decision, correction, and agent fact. Flushed to memory.

## The memory loop

```
nightly reflection ──writes──▶ active-todos.md, *-improvement-proposals.md
        ▲                                   │ import every 30 min
        │                                   ▼
work-hq-journal.md ◀──flush 5 min── Journal ◀── your answers, corrections, agent facts
```

The journal (`memory.journalPath`) is capped at ~20 KB (older days spill to
`…-archive-YYYY-MM.md`) to stay under typical embedding size limits. Its header
(`prompts/journal-header.md`) tells reflections it outranks stale state.

### Duplicates across sources (src/server/dedupe.ts)

Each source has its own stable key (`memory:active-todos:<slug>`, `transcript:<doc>:<slug>`, a check's key),
so re-imports update in place. The same work can still arrive under two keys: memory rewords a todo, a
transcript sweep finds what an agent already filed, a proposal comes back as a todo. Before creating an
item, `findTwin` compares title tokens with the open items and with anything you closed in the last 14 days.
The thresholds are strict on purpose: titles that name different tickets never match.

- Twin is open → the new one is merged into it (links and people added, title and status kept).
- Twin is one you closed → it isn't re-added. The journal says so (`Not re-adding …`).
- Either way the new key becomes an **alias** (`item_keys` table), so the next import goes to the same item.
- Voice and 🍍 never match a closed item: saying it again means it's live again. Checks, calendar
  items and manual adds are never merged.
- After each memory import, `dedupeExisting` merges duplicates that already exist. It only ever drops
  the copy you haven't confirmed.

Paths are config: `memory.todosPath`, `memory.proposalsDir`, `memory.learnProposalsPath`, `memory.journalPath`. No memory
server? Work HQ still runs; you just lose import and the flush.

## Proactive rules (src/server/prompter.ts)

| Rule | When | Priority |
|---|---|---|
| Morning plan | first tick in work hours before noon | 95 |
| It's time | scheduled item's time has passed | 90 (notifies) |
| Wrap up | 90 min before end of day | 88 |
| M5 move | the coaching move's time has passed (day: MM-DD, weekday or next workday after the reflection; time: last HH:MM, else 09:30); once per reflection date, never > 2 days late; a newer reflection expires it; journaled as `M5 move: … → answer` | 85 (notifies) |
| 🍍 capture triage | new pineapple item | 82 |
| Today's prep | work-hours morning (with the plan), weekday, today has 1-1s / 2–4 person meetings still to start; one card per day (`prep:<date>`), tick-boxes per meeting, each tick dispatches `prep`; the list follows the calendar and the card expires once they've all started. Replaced the per-meeting card 20 min before (17 of 19 expired, 10-22) | 75 |
| Kill date | ≤ 2 days to a reflection kill date | 72–78 |
| Agent asks | a dispatched agent needs a decision | 72 |
| Meeting ended | ≤ 45 min after a meeting with others | 70 |
| Capture triage | new transcript item | 65 |
| Still on it? | `doing`, no live job, no open card for the item, 4 work hours (weekdays, `sweeps.workHours`) since its last update / job finish / answered card; 24 h cooldown; expires when it leaves `doing` or a job starts | 62 (max 3 open) |
| State unknown | memory admits it doesn't know | 60 (max 3 open) |
| PR / MR merged · Ticket done (batched) | waiting items whose MRs all merged and JIRA tickets are all done (`jira-state.ts`: REST + cloudflared token, 30 min cache; a failed lookup is unknown, never done); one card, ≤ once per 20 h; "Keep waiting" stops it re-listing them | 55 |
| Still waiting | waiting > 3 days | 50 |
| Reflection proposal | unconverted proposal (kept across nights until answered) | 45 (max 2 open) |
| Draft to review / post idea | `post` item, proposed | 42 / 38 (max 2 open) |

**Meeting ended** is skipped once a transcript sweep has read that meeting's notes. The sweep reports every
meeting it read (`meetings` in its JSON) plus the meeting named on each item it made. Those are matched to the
calendar by title and start time, and an open card closes with "transcript scanned". So the sweep runs 10–25 min
after a meeting with others ends, and again at 45–60 min if that meeting is still unscanned (`NOTES_WINDOWS_MIN`),
not only on its 30-min cadence. Gemini notes often land after 25 min: of 10 cards a scan closed in October, 3 closed
by 25 min and 9 by 60. The card is held until 60 min (`REVIEW_HOLD_MIN`); the meeting row takes dictation meanwhile.

**Typed notes are answers.** ⌘↵ in a question's note field posts to `/api/questions/:id/note`. "drop", "done"
and "do it" map straight to an option. Anything else goes to a tool-less pi call (`notePrompt`). It returns one
decision: one of the question's options, a status, a time (handled like "Scheduled for…"), or an agent with
your words as the instruction, plus a corrected title if you fixed one. A note that's only background stays on
the item, and the question waits until the next working morning. While pi reads the note, the question is
hidden for 15 min, so it can't come straight back. **Next →** / `→` and **← Back** / `←` only move between cards.

Total open questions are capped at 14 so it asks rather than nags. Deferred questions (see below) don't count
against the 14, but still count against their own kind's cap.

### Clear the deck (batch triage)

`b` swaps the focus card for every open question at once, grouped by how much of you it needs
([`src/shared/batch.ts`](../src/shared/batch.ts)):

| Effort | Groups | Bulk ops |
|---|---|---|
| one tap | meetings that ended, captured, still waiting, it's time | clear all, all later, chase all, send agents, push |
| hand off | state unknown / kill date, reflection proposals | check all for me (verify), send agents, reject all |
| needs you | agents asking, blog posts | defer, drop all |

Plan / wrap / prep are never touched in bulk. A bulk op runs each question's **own** option (same effects
and journal as answering one at a time) and writes one `Batch — …` journal line. Bulk dispatch never uses
`publish` or `draft`. **Defer** hides a question until 09:30 on the day picked (tomorrow, the rest of this
week, next Monday). An item that's already scheduled gets its time moved instead. With a `kind` (e.g. posts),
scheduled items of that kind that haven't come due yet move as well. "Push everything that needs your head to…"
defers every *needs you* group in one go.

A batch defer asks once before it moves anything, and shows the two facts about the slot it lands in:
how many open items already sit in that 30-minute slot, and any meeting it clashes with (solo holds like "Focus time" don't count)
(`Mon 09:30: 19 items already · clashes with CluePoints 09:30`). If there's a clash it offers the next free
30-minute gap that day as a second button. Nothing is blocked. To make this work, the calendar sweep reads from
today to the furthest defer target (`deferHorizon`), not only today. Later days go to `snapshot.upcoming`;
prep, review and triage still only look at today. If the sweep hasn't read that day, the line says so instead
of calling the slot free. The single-row Defer menu shows the same count and clash next to each day.

`q` sorts the normal one-at-a-time queue quick-first (one tap → hand off → needs you).

The command bar does the same in words: "skip all blog posts till Thursday", "clear the meeting ones",
"check all the unknowns for me", "push the rest to tomorrow". Triage sees the open groups and returns
`bulk: [{ op, group | kind | ids, until }]`. All of these go through `POST /api/questions/bulk`.

### "Scheduled for…"

Most item questions carry a **Scheduled for…** option (`{ type: "when" }`). Picking it opens a "When?" box and
borrows the command bar's recogniser. Say "booked it Thu 2pm", "put it in Friday morning" or "remind me Monday" and
it submits when you stop talking. `Agents.scheduleFromWords` asks a no-tools pi for `{ at, calendar }`:

- `exists`: you already booked it. The item goes to `scheduled` and the app reminds you at that time.
- `none` ("remind me"): same, reminder only.
- `create` (you asked for it in the calendar): also creates a private block in your own calendar via your
  calendar MCP (`prompts/sweeps/calendar-write.md`), with no attendees and no invites. The event link is added to the item.

The reminder is rule 1 ("It's time"), which already notifies. The command bar supports the same thing through
triage's `calendar` field.

### Replies never claim queued work

Triage, the note reader and `scheduleFromWords` write their `reply` before the work they asked for runs. A reply
that words the outcome ("Booked…", "Asking Maryna in chat…") is shown as a green toast and a job summary while
the job that does it hasn't started, and sometimes fails. So:

- Note → dispatch, a picked option that dispatches / schedules / re-triages, or a `when`: the note job summary
  and toast are fixed words from `queuedNote()` in `hub.ts` ("Sent an agent to send the message: X",
  "Noted → Ask her", "Working out when from “Thursday”"). The model's reply is only used when the state has
  already changed (status) or it's an answer (context only).
- `when` with `calendar: create`: "Scheduled X — adding a private block". `calendarBlock` toasts the real result.
- Triage: the prompt asks for dispatched work to be worded as handed off. If a dispatch it asked for didn't
  start (unknown id), the reply says so.
- The job that runs the work reports its own outcome. Tests: `test/claim-before-run.test.ts`,
  `test/schedule-reply.test.ts`.
- New sites can't slip in: `test/reply-sinks.test.ts` finds every `toast(`, `summary:` and `setReply(` line in
  `src/server` and `src/web` that uses a `reply`, and fails unless it's on the test's allowlist and has a
  `// reply-safe: <why>` comment at the site. Not caught: a reply copied to another variable first, and a triage
  reply that claims a dispatch when `dispatch[]` is empty.

### Writing scout

Weekly, `Agents.postSweep` reads memory (accomplishments, projects, learnings, the journal and any ideas
backlog), checks the wiki for posts from the last year so it doesn't suggest things someone already wrote,
and returns 3–5 `post` items. Each has a venue: `wiki`, `site` (your public site) or `both`. It also
returns full drafts for the top two. **The server writes the drafts, not the agent**, and never overwrites a file:

- wiki → `writing.wiki.draftsDir/<date>-<slug>.md`
- site → `writing.site.postsDir/<slug>.md` with `draft: true` (skipped if no site is configured). With an
  Obsidian vault configured, a `site` symlink next to the wiki drafts lets Obsidian open them.

The questions: **Open draft** (opens Obsidian and leaves the question open), **Publish…** (a cmux agent that shows
the final version and waits for your yes before `create_blog_post` or a push), **Revise** (uses the note),
Scheduled for…, and Not for me. Saying "I should blog about X" in the command bar creates a `post` item as well.

## Voice

Now: Chrome Web Speech, continuous, `owner.speechLang` (default `en-GB`). The 🍍 listener keeps ~2.5 minutes of
transcript; on the keyword it waits 7 s for the sentence to finish, then sends it to triage
in `pineapple` mode.

Dictation (command-bar mic, "Scheduled for…") uses `voice.dictation`, resolved on every press
([`transcribe.ts`](../src/server/transcribe.ts)):

- **hex** — [HEX](https://hex.kitlangton.dev)'s local API. HEX writes
  `~/Library/Application Support/voice-control/local-api.json` (port + bearer token); the server
  checks `/health`, then posts the WAV to `/transcriptions?model=<HEX's selected model>`.
- **command** — any shell command that reads `{file}` and prints text (whisper.cpp, parakeet-mlx, …).
- **browser** — Web Speech, sharing the 🍍 recogniser. Live interim text.
- **auto** (default) — hex if it's up, else command if set, else browser.

For hex/command the browser records (AudioWorklet → 16 kHz mono WAV), stops on `voice.silenceMs` of
quiet or ↵ / ⌘↵, **releases the mic before uploading**, and posts to `/api/transcribe`. No interim text;
the prompt shows "Transcribing…" instead. If HEX has quit, the next press falls back to Web Speech.

Next:
- **Speaker separation.** The laptop mic hears the call. Options: route the Meet tab's audio
  and the mic separately (two `MediaStream`s → a Whisper worker), or use Gemini's live
  transcript when it becomes available mid-meeting.
  Proposal for any meeting, not just Meet (a local mic + sound-output helper, RealtimeKit compared):
  [`proposals/local-meeting-listener.md`](proposals/local-meeting-listener.md).
- **Conversation mode.** Read the focus question aloud (SpeechSynthesis), accept a spoken
  answer ("two", "done", "push it to tomorrow"), confirm with a chime. The option ids and
  triage already support it; it's a UI mode.

## What moves to the cloud, and how

The laptop limitation is real: sweeps stop when the lid closes, and nothing reaches you
away from the desk. Two routes, in order.

### 1. A scheduled agent — cheapest, soonest

Most companies now have *something* that runs code on a schedule with access to memory and chat
(an internal agent platform, a cron'd container, a CI schedule). The first job worth building there:
**"Work HQ away mode"**, twice a day.

1. Read the to-do list + journal from memory.
2. Run the same prompter rules (they're pure — lift `prompter.ts` + `parse.ts` into a
   shared package, swap `Store` for an in-memory one).
3. If the laptop hasn't checked in for > 30 min (the local server writes a heartbeat),
   DM the owner the top three questions.
4. Read the replies and write them to the journal, so answers made on the phone land in
   memory before the laptop opens.

Guardrails: messages only ever go to the owner's own DM, one idempotency key per day, and
preview-then-send until it has earned trust.

### 2. A Durable Object — the permanent home

`cloud/` has the scaffold (not deployed). One DO per person, SQLite-backed:

- **Mirror.** The local server pushes item/question/journal deltas (`POST /sync`) and pulls
  answers made elsewhere (`GET /answers?since=`). Local stays authoritative while online.
- **Alarm loop.** When the laptop is offline, `alarm()` runs the prompter over the mirror
  and fans out via a chat webhook — the same rules, one codebase.
- **Long-running agents.** Work that doesn't need the laptop (transcript sweeps with a
  service identity, ticket hygiene, review nudges) moves to Containers kicked by the DO, reporting
  through the same `AgentReport` contract `bin/whq` uses today.
- **Surface abstraction.** `Job.surface` is `headless | cmux` today; `scheduled` and `do` slot in
  beside them. The UI already renders any surface; only `agents.ts` needs a new launcher.

The seam is deliberately `AgentReport` + the Hub's state transitions: anything that can POST
JSON can be an agent, anywhere.

## Plugging it into your own setup

- Whatever writes your to-do list and proposals (a nightly reflection agent, a briefing prompt, you
  by hand) should read the journal first and treat it as higher authority than its own last output.
- Put your house rules in prompt overrides, not code: `prompts/actions/ticket.md` is where "search
  for dupes, use this project, this template" lives; `prompts/tools.md` is where your MCP servers
  and CLIs are described.
- The status beacon is a standalone pi extension; reuse it for any "run pi in a terminal and know
  when it's done" job.

## Usage digest (src/cli/usage.ts)

`bin/work-hq usage [--since] [--until] [--db]` reads the database read-only and prints markdown for a reflection
to work from. The "nothing happened" check looks for a state change, schedule or dispatch on the same item within
5 minutes of a note typed while its card was open. Notes added from the item drawer with no card open are
reported as context. Lines an agent posted (`PATCH /api/items/:id` with `who: "agent"`) journal as `agent`, so
the digest's typed-input sections leave them out.

## Files

```
src/shared/types.ts       shared model + AgentReport contract
src/server/index.ts       Bun.serve: routes, websocket
src/server/hub.ts         state transitions, journal, agent-report ingest, typed notes, scanned meetings
src/server/dedupe.ts      cross-source duplicate check (title tokens)
src/server/prompter.ts    proactive rules
src/server/scheduler.ts   heartbeat + cadences
src/server/agents.ts      pi spawning: headless, cmux, triage
src/server/pi-rpc.ts      pi RPC client, warm triage pool, argv guard
src/server/gateway-token.ts shared model-gateway token (JWT-expiry aware)
src/server/launch-gate.ts launch spacing + rate-limit detection/backoff
src/server/cmux.ts        cmux workspace + beacon plumbing
src/server/config.ts      config file + env → typed config
src/server/prompts.ts     prompt assembly + the JSON contracts the server parses
prompts/                  instruction templates (override per user with promptsDir)
src/server/memory.ts      agent-memory MCP client
src/server/memory-sync.ts memory import, journal flush
src/server/parse.ts       active-todos / proposals markdown → items
src/web/*                 React UI (Bun HTML import, no build step)
pi/status-beacon.ts       pi extension: session state → JSON file
bin/work-hq               run / install / uninstall (launchd)
bin/whq                   CLI for agents and terminals
src/cli/demo.ts           `bin/work-hq demo`: sandbox with made-up data
src/server/demo.ts        demo seed data + scripted agents/sweeps (WORK_HQ_DEMO=on)
src/server/demo-sandbox.ts the live dashboard's Demo toggle: runs demo.ts as a child process
src/cli/demo-agent.ts     plays a scripted agent run in a cmux terminal
src/cli/config.ts         `bin/work-hq config`: print the resolved config
src/cli/usage.ts          `bin/work-hq usage`: usage digest for reflections
cloud/                    Durable Object scaffold (not deployed)
```
