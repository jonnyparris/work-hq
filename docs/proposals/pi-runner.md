# Proposal: a sturdier way to run headless pi

Status: shipped 2026-10-15 except resume-after-restart and UI steering (see below) · Owner: Work HQ · Related: `runHeadless` in `src/server/agents.ts`

## TL;DR

- **Don't embed the pi SDK in the server.** It works under Node, but the model gateway plugin can't
  load under Bun. The plugin also leaves MCP work running after a session closes. The perms config
  comes from `process.env`. The gain is about 1 s per triage.
- **Use `pi --mode rpc` instead.** Keep a warm worker pool for triage and start one RPC process per
  tool run. Prompts go over stdin, so long prompts never touch argv. Each run keeps its own process
  (kill to cancel, own env, crashes stay contained), and we get a proper abort, live events and steering.
- Add a supervisor, deadlines, an inactivity watchdog, resume after a server restart, and one shared
  gateway token. That covers most of the failures from the last 7 days.

## What fails today (last 7 days, headless only)

| Runs | Kind | Avg | Max | Failed |
|---|---|---|---|---|
| 129 | transcripts sweep | 116 s | 37 min | 17 |
| 57 | note triage | 4.5 s | 12 s | 9 |
| 43 | calendar sweep | 294 s | 36 min | 11 |
| 28 | chat triage | 6.4 s | 15 s | 4 |
| 19 | when / review triage | 4–9 s | 15 s | 0 |

Failure causes: 15 gateway login lapsed, 13 SentinelOne SIGKILL (prompt in argv, fixed in `0c3b3a6`),
4 SIGTERM, 3 server restarted mid-run, 3 request timed out, 2 agent-perms "stale ctx", 1 connection error.

## What the spikes showed (2026-10-15)

**SDK in-process** (`createAgentSession`, in-memory sessions, only the internal gateway plugin extension):

- Under **Bun** (what the server runs on): the plugin fails to load with
  `Cannot find package '@earendil-works/pi-ai'`. Bun imports TypeScript natively, so pi's jiti
  aliases never apply. Without the plugin there is no gateway provider, so no model.
- Under **Node** it works: 18 KB triage in 4.4 s, first session ready in 209 ms, later sessions in
  2–4 ms. `abort()` stops cleanly in ~500 ms. 3 concurrent sessions are fine.
- But each session logs `MCP initialization failed: This extension ctx is stale` after `dispose()`.
  The plugin starts MCP work in the background for each session, and that work outlives the session.
  In a long-lived host this piles up. There is no env switch to turn the plugin's MCP off.
- agent-perms reads `AGENT_PERMS_PI_CONFIG_JSON` from `process.env`. That is process-wide, so
  "perms on for sweeps, off for triage" can't run concurrently in one process.
- The plugin updates itself (`CF_AUTO_UPDATE`), so a long-lived host would keep running old code.

**RPC worker** (`RpcClient` from Bun → `pi --mode rpc -nt -nc -ns -np --no-session`):

- Works from Bun. The 18 KB prompt goes over stdin. Start takes 104 ms; `newSession()` takes
  0.7–1.4 s (extensions reload); triage ends in 4–5.5 s.
- `abort()` → `agent_settled { aborted: true }` in ~1.5 s, and the same worker serves the next run.
- `RpcClient` splits JSONL correctly (not `readline`) and `stop()` escalates SIGTERM → SIGKILL.

## Design

### Triage: warm pool

- `PiPool` holds 2 RPC workers (triage, no tools). Each worker keeps a **pre-armed session**: right
  after a run settles it calls `newSession()`, so the ~1 s reload happens off the critical path.
- A request takes an idle worker, runs `prompt` and waits for `agent_settled`, reads the last
  assistant text, then re-arms the worker.
- Deadline per request (today's `timeoutMin`): call `abort()`. If it hasn't settled 5 s later, run
  `stop()` (SIGKILL) and respawn.
- Recycle a worker after 50 runs, 30 min idle, or a pi/plugin version change (compare `pi --version`
  and the plugin's `package.json` mtime). This keeps auto-updates and slow leaks in check.
- Supervisor: on an unexpected exit, respawn with backoff (1 s, 5 s, 30 s). If the pool is down,
  **fall back to the current cold `pi -p @file` path**, so triage never depends on the pool.
- Health: a `get_state` ping before handing out a worker that has been idle for more than 5 min.

### Tool runs: one RPC process each

- Same `RpcClient`, one per run, with per-run env (perms, `WORK_HQ_JOB`) and the existing flags
  (`-a -n … -xt …`). Cancel = `abort()`, then `stop()`.
- **Inactivity watchdog:** abort if no event arrives for 10 min (separate from the overall timeout).
  Sweeps peaking at 37 min look like stalls, not work.
- **Steering:** "nudge" from the UI becomes `steer()` on a running sweep, instead of cancelling and
  starting again.
- Read cost and tokens from `get_session_stats` instead of scraping events.

### Shared

- **One gateway token.** The provider's key command already prefers `OPENCODE_CF_TOKEN`. The server
  runs `cloudflared access token -app=https://opencode.cloudflare.dev` once, caches the token, passes
  it to every worker, and refreshes it on 401 or every 30 min. That leaves one place to notice a
  lapsed login (today it's 15 failures spread across runs), and stops each run forking `cloudflared`.
- **Resume after restart.** On boot, tool jobs still marked `running` with a `session` id get
  requeued with `--session <id>` and `RESUME_NUDGE`, instead of failing as "server restarted mid-run".
  Triage jobs simply rerun (no side effects).
- **Guard argv.** `spawnPi()` throws if any argument is over 512 bytes. That catches the next prompt
  someone puts in argv in the tests, not in production.

## Revisit in-process SDK when

- the server moves to Node, or Bun honours jiti aliases, **and**
- the gateway plugin stops starting MCP work per session (or offers a switch to turn it off), **and**
- agent-perms takes its config per session rather than from `process.env`.

## What shipped vs. this plan

- Shipped: argv guard, `PiRpc` for tool runs with inactivity watchdog, warm triage pool (size 1,
  waits for a re-arming worker before spawning), shared gateway token, `pi.runner` switch.
- Not yet: **resume after restart.** The code that handles a run's output lives in the caller that
  started it (sweep, triage, note reader), so a run restarted on boot has nowhere to deliver its result.
  Sweeps run again on their own schedule; triage has nobody waiting. Doing this properly means
  persisting "what to do with the result" per job.
- Not yet: **steering from the UI.** `PiRpc` can send `steer`; there is no nudge button for headless runs.

## Rollout

1. Token cache + argv guard + resume on restart (small, independent).
2. Tool runs on per-run RPC + inactivity watchdog. Run alongside `-p` behind `pi.runner: "rpc"`.
3. Triage pool with cold fallback. Compare latency and failures in `bin/work-hq usage` for a week.
