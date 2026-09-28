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
});

test("plain", () => {
  expect(plain("**a** [b](http://c) `d`")).toBe("a b d");
});
