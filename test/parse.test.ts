import { describe, expect, test } from "bun:test";
import { parseActiveTodos, parseProposals, plain } from "../src/server/parse.ts";

const TODOS = `---
tags: [core]
---
# Active Todos

## Immediate

- [ ] **Q3/Q4 planning with Priya and Tom.** Still the only \`Next\` item.
- [ ] **[CHG-4012](https://tracker.example.com/browse/CHG-4012)** — still In Review. Close the CR or record why.
- [ ] **Share Ana's catalog ideas** (Sep 15 Leo transcript). State unknown.
- [ ] **Load-test stakeholder review** — demo. **Kill 2026-09-29** if no decision is recorded.
- [x] **Done thing** — ignore me

## Delegated / Team-Owned

- [ ] **[PAY-1541](https://tracker.example.com/browse/PAY-1541)** — delete superseded secrets; Needs Triage.
  continuation line here

## Recently Resolved

- [ ] **Should be skipped**
`;

describe("parseActiveTodos", () => {
  const items = parseActiveTodos(TODOS, "active-todos", [{ key: "PAY" }, { key: "CHG" }]);

  test("only unchecked items outside skipped sections", () => {
    expect(items.map((i) => i.title)).toEqual([
      "Q3/Q4 planning with Priya and Tom",
      "CHG-4012 · still In Review",
      "Share Ana's catalog ideas",
      "Load-test stakeholder review",
      "PAY-1541 · delete superseded secrets",
    ]);
  });

  test("flags", () => {
    expect(items[2]!.flags.stateUnknown).toBe(true);
    expect(items[3]!.flags.killDate).toBe("2026-09-29");
  });

  test("links, project, kind, continuation", () => {
    const b = items[4]!;
    expect(b.links).toEqual(["https://tracker.example.com/browse/PAY-1541"]);
    expect(b.project).toBe("PAY");
    expect(b.kind).toBe("followup");
    expect(b.detail).toContain("continuation line");
  });

  test("stable keys", () => {
    expect(items[0]!.key).toBe("memory:active-todos:q3-q4-planning-with-priya-and-tom");
  });
});

describe("parseProposals", () => {
  const md = `# Improvement Proposals - 2026-09-24

## Carryover Audit

### 9. not a proposal

## High Priority (High Value, Low Effort)

### 1. One post-merge sync command
Body text with [a link](https://x.test/a).

## Medium Priority

### 3. Confirm a merge reached the target branch
More.

## Ideas to Explore
### 7. ignored
`;
  test("only numbered proposals under priority sections", () => {
    const p = parseProposals(md, "2026-09-24");
    expect(p.map((x) => x.title)).toEqual(["One post-merge sync command", "Confirm a merge reached the target branch"]);
    expect(p[0]!.links).toEqual(["https://x.test/a"]);
    expect(p[0]!.section).toContain("High Priority");
  });

  // 11-11: it_mwcrrhjb97ogt quoted another item's "final kill 2026-11-11" and "by you 10-27"; the import took that
  // quoted 2026-11-11 (the file's date) as its kill and due date, and the "date passed" card came 27 s later.
  test("kill date only from the proposal's own bold line, not before the file date; no due date", () => {
    const p = parseProposals(
      `## High Priority

### 1. Quotes another item
**Problem**: "…re-committed by you 10-27 09:58" vs "…final kill 2026-11-11", due 2026-11-12 by Friday.
**Effort**: Low

### 2. Own kill line
**Problem**: the old card said kill 2026-11-09.
**Kill 2026-11-20.**

### 3. Stale bold kill
**Kill 2026-11-10, final.**

### 4. Final kill
Test it. **Final kill 2026-11-14.**

### 5. Kill is today; a quoted bold kill after it doesn't count
**Kill 2026-11-11** if not answered.
**Kill 2026-11-09.**
| C1 | blog | **Final kill 2026-11-30, no extension** | quoted |
> **Kill 2026-11-29.** (quoted)
The old card said "**final kill 2026-11-28**", "the **Kill 2026-11-25** one", “a **Kill 2026-11-26**” and \`see **Kill 2026-11-27.**\`.

### 6. A closed quote before the own kill
It said "no extension"**Kill 2026-11-20**
`,
      "2026-11-11",
      new Date(2026, 10, 11),
    );
    expect(p.map((x) => [x.flags.killDate, x.flags.dueDate])).toEqual([
      [undefined, undefined],
      ["2026-11-20", undefined],
      [undefined, undefined],
      ["2026-11-14", undefined],
      ["2026-11-11", undefined],
      ["2026-11-20", undefined],
    ]);
  });
});

test("plain", () => {
  expect(plain("**a** [b](http://c) `d`")).toBe("a b d");
});
