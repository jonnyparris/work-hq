# work-hq-cloud (scaffold, not deployed)

The always-on half of Work HQ: one Durable Object per person that mirrors items and
questions from the laptop, keeps asking when the laptop is closed, and relays answers back.

Contract with the local server:

| Route | Who calls it | What |
|---|---|---|
| `POST /sync` | local server, every few minutes | Snapshot delta: items, open questions, journal. Also the heartbeat. |
| `GET /answers?since=` | local server, on reconnect | Answers given away from the laptop (chat replies). |
| `POST /agent/report` | cloud agents (Containers, scheduled jobs) | Same `AgentReport` shape as `bin/whq report`. Queued for the laptop. |
| `alarm()` | the DO itself | If the laptop's heartbeat is stale, run the prompter over the mirror and DM the top questions. |

Before deploying: an auth layer in front, a `SYNC_TOKEN` secret, and the prompter lifted into a
shared package so the DO runs the exact rules the laptop does.
