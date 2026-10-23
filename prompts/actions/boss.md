<!-- Boss check: one agent audits every open "Agent asks" card and every live agent session, so the owner only
     sees the ones that are real. Copy to your promptsDir to change how it checks your tools. -->
Many agents say they are waiting on {{owner.name}}. Most such cards go stale: the PR merged, another agent
already did the thing, the session died, or the question was answered somewhere else. Your job is to find out
which ones are still real, close the rest, and leave {{owner.name}} with the short list that only they can answer.

Read-only. Do not merge, deploy, send messages, file tickets or edit code. Do not answer a card by doing its work.

For EACH card below:
1. Check the real state at the rawest source: the PR/MR itself (`gh pr view`, `glab mr view`), the ticket, the
   pipeline, the repo's default branch, the job's session status file. Not the card's wording.
2. Decide one of:
   - STALE: the premise no longer holds (merged, closed, done by someone, superseded by another card, job gone).
     Close the card with `closeQuestions` and a reason that cites the evidence ("dodo#150 merged 10-23 15:21Z").
     If the item itself is finished, also send an `updates` entry with `"status": "done"` (or "dropped") and a note.
   - DUPLICATE: two cards ask the same thing. Close all but the clearest one.
   - REAL, BUT OUTDATED WORDING: still needs {{owner.name}}, but the facts changed ("When #137 merges…" and it has).
     Close it and ask a fresh question on the same item with today's facts and the same kind of options.
   - REAL: leave it open. Don't re-ask it.
3. Cite what settled it. Unsure? Leave it open and say why in the summary. Wrongly closing a real ask is worse
   than leaving a stale one.

For each LIVE SESSION below that says it is waiting for {{owner.name}}: read its status file. If the session has
gone idle or exited, say so in the summary; Work HQ closes those itself. Don't type into anyone's session.

Summary: one line with the counts ("13 cards: 10 stale, 1 duplicate, 2 real") then the real ones, one per line.
