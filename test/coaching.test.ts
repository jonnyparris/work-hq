import { describe, expect, test } from "bun:test";
import { parseCoaching, parseProposals } from "../src/server/parse.ts";

const MD = `# Improvement Proposals — 2026-10-19

## High Priority

### 1. Fix the thing
Body.

## EM Coaching: M5 Assessment

**This week's M5 signal: Mixed**

**What you did well (M5-aligned):**
- **You cleared the batch with decisions, not snoozes.** In 33 minutes:
  - booked the Sam 1-1
- **You drew a manager's boundary out loud.** After the Priya 1-1 you wrote…

**Where you're operating below M5:**
- **None of last night's three hand-offs happened.** Each takes under five minutes.
  - **Tom's staffing question** has 0 replies.
- Written judgement is unchanged. 69 of 70 comments came from your agent.

**One thing to try tomorrow (Tue 10-20, before the 09:30 blog slot):**
- Spend ten minutes on the two things only you can do:
  1. Reply to Tom's \`AAACI3KC3Q4\` thread.
  2. Book the Priya Q4 session for this week.

## Brag Sheet Updates

- not coaching
`;

describe("parseCoaching", () => {
  const c = parseCoaching(MD, "2026-10-19")!;
  test("signal, when and the move", () => {
    expect(c.signal).toBe("Mixed");
    expect(c.when).toBe("tomorrow (Tue 10-20, before the 09:30 blog slot)");
    expect(c.move.split("\n")).toEqual([
      "- Spend ten minutes on the two things only you can do:",
      "  1. Reply to Tom's `AAACI3KC3Q4` thread.",
      "  2. Book the Priya Q4 session for this week.",
    ]);
    expect(c.move).not.toContain("Brag");
  });
  test("bold leads of top-level wins and gaps only", () => {
    expect(c.wins).toEqual(["You cleared the batch with decisions, not snoozes", "You drew a manager's boundary out loud"]);
    expect(c.gaps).toEqual(["None of last night's three hand-offs happened", "Written judgement is unchanged"]);
  });
  test("inline move on the heading line", () => {
    const x = parseCoaching("## EM Coaching: M5 Assessment\n\n**M5 signal: Strong**\n\n**One thing to try:** Reply to Sam.\n", "2026-10-01")!;
    expect(x.signal).toBe("Strong");
    expect(x.when).toBe("");
    expect(x.move).toBe("Reply to Sam.");
  });
  test("no block, or no move → undefined", () => {
    expect(parseCoaching("## High Priority\n\n### 1. X\n", "2026-10-01")).toBeUndefined();
    expect(parseCoaching("## EM Coaching: M5 Assessment\n\n**This week's M5 signal: Mixed**\n", "2026-10-01")).toBeUndefined();
  });
  test("proposals parsing is unaffected", () => {
    expect(parseProposals(MD, "2026-10-19").map((p) => p.title)).toEqual(["Fix the thing"]);
  });
});
