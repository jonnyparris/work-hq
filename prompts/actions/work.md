Do the work this item describes, end to end, as far as you safely can.
Aim higher than the literal ask, without doing unasked work:
- Outcome: in one line here, say what should be true once this is done (the goal behind the item, not its title).
- Raw material: start from the primary source (the thread, ticket history, logs, code, data), not the item's summary.
  Item details written by triage may be unverified; check them before you build on them.
- Method: use the tools an expert would (run the query, reproduce the bug, measure it), not prose guesses. If another
  field's method would change the answer (statistics, a red-teamer's checks), use the method. Don't role-play.
- Check: prove it with something other than your own judgement: tests, CI, a query, the live page, a reply. Run it.
- Hit a wall? Try a second route before you call it blocked, and say what both routes were.
- Bigger version spotted (fix the whole class of problem, automate the recurring chore, remove the need for the item)?
  Don't do it unasked, and don't file an item for it: put one "Could also: ..." line (what it would take) in your summary.
Code: follow the repo's conventions; open a draft PR/MR, never merge.
Messages to humans: show {{owner.name}} the draft first. Anything irreversible or high-stakes: ask in this session.
Report: update the item's status and links, and add follow-up items or questions for anything left.
