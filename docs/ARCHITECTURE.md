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
            memory MCP     │   pi -p (headless, JSON events)  │  pi in cmux (beacon)
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
- **Company-specific instructions are data, not code.** Which tools to call, how tickets are
  filed, what voice replies use: all in `prompts/*.md`, overridable per user (`promptsDir`).
  Output shapes the server parses stay in `src/server/prompts.ts`.
- **Anything that writes to the world is visible.** Dispatched actions run as interactive pi
  in cmux, grouped under "Work HQ", with a small pi extension (`pi/status-beacon.ts`) telling the
  server when a turn settles, blocks on input, or exits. Sweeps are read-only and headless,
  but stream tool calls into the Agents panel. `WORK_HQ_SWEEP_SURFACE=cmux` if you want those
  in cmux too. Every 10 minutes the scheduler closes job workspaces whose session has been idle
  (beacon `idle`/`exited`) longer than `cmux.pruneIdleHours` (default 3). It never touches a
  workspace that is selected, pinned, still working, or waiting on you.
- **Provider rate limits are waited out, not fatal.** Every pi launch with tools (cmux actions,
  sweeps) goes through one launch gate (`src/server/launch-gate.ts`) that spaces starts at least
  `pi.launchSpacingSec` apart (default 20). Tool-less triage skips the gate. If a run still dies
  on a rate limit, 429, 503 or "overloaded" (e.g. the per-org "Grammar compilation rate limit",
  20/min), Work HQ waits 60–90 s (`pi.rateLimitBackoffSec`) and retries up to `pi.rateLimitRetries`
  (default 2) times. A cmux session is nudged in place ("carry on"); a headless tool run resumes
  its own session so finished tool calls aren't repeated. pi's own retries (2/4/8 s) sit inside
  this and don't outlast a per-minute limit on their own.
- **Human decisions are the source of truth.** `confirmedAt` is set whenever the owner decides
  something. Memory re-imports refresh text but never undo a confirmed status.

## Data model (src/shared/types.ts)

- **Item** — the unit of work. `kind` (task, ticket, message, email, followup, decision,
  review, meeting, idea) decides which action fits; `status` walks inbox → proposed →
  today/scheduled → doing/waiting → done/dropped. `signals` carries what the parser found
  in memory text (state unknown, kill date, pineapple).
- **Question** — one ask with 2–6 options. Each option has an **Effect** (status, schedule,
  snooze, dispatch). Keyed for dedupe with cooldowns, so answering "Doing it today" doesn't
  bring the same question back tomorrow morning.
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

Paths are config: `memory.todosPath`, `memory.proposalsDir`, `memory.journalPath`. No memory
server? Work HQ still runs; you just lose import and the flush.

## Proactive rules (src/server/prompter.ts)

| Rule | When | Priority |
|---|---|---|
| Morning plan | first tick in work hours before noon | 95 |
| It's time | scheduled item's time has passed | 90 (notifies) |
| Wrap up | 90 min before end of day | 88 |
| Meeting prep | small meeting / 1-1 starts in ≤ 20 min | 85 (notifies) |
| 🍍 capture triage | new pineapple item | 82 |
| Kill date | ≤ 2 days to a reflection kill date | 72–78 |
| Agent asks | a dispatched agent needs a decision | 72 |
| Meeting ended | ≤ 45 min after a meeting with others | 70 |
| Capture triage | new transcript item | 65 |
| State unknown | memory admits it doesn't know | 60 (max 3 open) |
| Still waiting | waiting > 3 days | 50 |
| Reflection proposal | unconverted proposal (kept across nights until answered) | 45 (max 2 open) |
| Draft to review / post idea | `post` item, proposed | 42 / 38 (max 2 open) |

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

## Files

```
src/shared/types.ts       shared model + AgentReport contract
src/server/index.ts       Bun.serve: routes, websocket
src/server/hub.ts         state transitions, journal, agent-report ingest
src/server/prompter.ts    proactive rules
src/server/scheduler.ts   heartbeat + cadences
src/server/agents.ts      pi spawning: headless, cmux, triage
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
cloud/                    Durable Object scaffold (not deployed)
```
