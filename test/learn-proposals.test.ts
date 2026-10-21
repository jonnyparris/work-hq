import { describe, expect, test } from "bun:test";
import { config } from "../src/server/config.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { MemoryClient } from "../src/server/memory.ts";
import { MemorySync } from "../src/server/memory-sync.ts";
import { parseLearnProposals } from "../src/server/parse.ts";
import { Prompter } from "../src/server/prompter.ts";

// The `learn` skill queues rule changes it may not make alone (AGENTS.md edits, permission changes)
// in memory/workload/learn-proposals.md after a pi session. They must reach the owner as proposal cards.
const LEARN = `---
tags: [workload, learn]
---
# /learn proposals

## 2026-10-21 · learn 01a16000
### 1. Make the gchat skill say reads go through the portal
File: \`.opencode/skill/gchat/SKILL.md\`. Change: add a line. Evidence: [thread](https://chat.google.com/x).

### 2. Allow \`glab api\` reads without a prompt
File: opencode.json. Change: allow. Evidence: prompted 6 times.

## Notes
### 3. not a proposal
`;

function fakeMemory(files: Record<string, string>): MemoryClient {
  return {
    read: async (p: string) => files[p],
    list: async (dir: string) => Object.keys(files).filter((p) => p.startsWith(dir)).map((path) => ({ path })),
    write: async () => {},
  } as unknown as MemoryClient;
}

describe("learn proposals", () => {
  test("parse: dated sections only, labelled Learn", () => {
    const p = parseLearnProposals(LEARN);
    expect(p.map((x) => x.title)).toEqual(["Make the gchat skill say reads go through the portal", "Allow glab api reads without a prompt"]);
    expect(p[0]!.section).toBe("Proposals 2026-10-21 · Learn (session 01a16000)");
    expect(p[0]!.key).toStartWith("memory:proposals:learn-");
    expect(p[0]!.links).toEqual(["https://chat.google.com/x"]);
  });

  test("memory sync turns them into proposal cards, alongside a missing file being fine", async () => {
    const hub = new Hub(new Store(":memory:"));
    await new MemorySync(hub, fakeMemory({ [config.memory.todosPath]: "# Active Todos\n" })).importAll();
    expect(hub.store.items()).toHaveLength(0);

    await new MemorySync(hub, fakeMemory({ [config.memory.learnProposalsPath]: LEARN })).importAll();
    const items = hub.store.items().filter((i) => i.source.key?.startsWith("memory:proposals:learn-"));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === "proposed" && i.kind === "idea")).toBe(true);

    new Prompter(hub).tick(new Date(2026, 9, 21, 15));
    const asked = hub.store.questions("open").filter((q) => q.key.startsWith("proposal:"));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]!.context).toStartWith("From /learn after a pi session (2026-10-21).");
  });
});
