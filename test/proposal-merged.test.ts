import { describe, expect, test } from "bun:test";
import { config } from "../src/server/config.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { MemoryClient } from "../src/server/memory.ts";
import { MemorySync } from "../src/server/memory-sync.ts";
import { Prompter } from "../src/server/prompter.ts";

// 10-19: proposals #1 (token rotation, twin of an agent item) and #5 (/noassign, same title as an active-todos line)
// merged into existing items, kept those items' sources, and so were never asked as proposal cards.
const TODOS = `# Active Todos

## Immediate

- [ ] **Document /noassign in kitesurf AGENTS.md** — Rui asked for it.
`;

const PROPOSALS = `# Improvement Proposals 2026-10-19

## High Priority (High Value, Low Effort)

### 1. Rotate the account-wide Cloudflare API token

It's in plain text in 34 agent logs.

### 2. Document /noassign in kitesurf AGENTS.md

Nobody knows the command exists.
`;

function fakeMemory(files: Record<string, string>): MemoryClient {
  return {
    read: async (p: string) => files[p],
    list: async (dir: string) => Object.keys(files).filter((p) => p.startsWith(dir)).map((path) => ({ path })),
    write: async () => {},
  } as unknown as MemoryClient;
}

const at = new Date(2026, 9, 20, 15);

describe("proposals merged into existing items", () => {
  test("a proposal that merges into an active-todos item or an agent item still gets a proposal card", async () => {
    const hub = new Hub(new Store(":memory:"));
    const agentItem = hub.createItem({
      title: "Rotate the account-wide Cloudflare API token",
      kind: "idea",
      status: "proposed",
      source: { type: "agent", label: "leak scan", key: "agent:leak-scan" },
    });
    const files = {
      [config.memory.todosPath]: TODOS,
      [`${config.memory.proposalsDir}/2026-10-19-improvement-proposals.md`]: PROPOSALS,
    };
    await new MemorySync(hub, fakeMemory(files)).importAll();

    const todo = hub.store.items().find((i) => i.source.label?.startsWith("active-todos") && /noassign/.test(i.title))!;
    expect(todo).toBeDefined();
    // Neither proposal got an item of its own: both merged.
    expect(hub.store.items().filter((i) => i.source.key?.startsWith("memory:proposals:") && i.status !== "dropped")).toHaveLength(0);
    const label = "Proposals 2026-10-19 · High Priority (High Value, Low Effort)";
    expect(hub.store.item(todo.id)!.proposalOf).toBe(label);
    expect(hub.store.item(agentItem.id)!.proposalOf).toBe(label);
    // Their own sources are untouched.
    expect(hub.store.item(todo.id)!.source.label).toStartWith("active-todos");
    expect(hub.store.item(agentItem.id)!.source.key).toBe("agent:leak-scan");

    new Prompter(hub).tick(at);
    const asked = hub.store.questions("open").filter((q) => q.key.startsWith("proposal:"));
    expect(asked.map((q) => q.itemId).sort()).toEqual([todo.id, agentItem.id].sort());
    expect(asked[0]!.context).toStartWith("From the 2026-10-19 reflection.");

    // A re-sync doesn't churn an item memory doesn't otherwise touch.
    const before = hub.store.item(agentItem.id)!.updatedAt;
    await new MemorySync(hub, fakeMemory(files)).importAll();
    expect(hub.store.item(agentItem.id)!.updatedAt).toBe(before);
  });

  test("a merged item the owner already moved on is not asked", async () => {
    const hub = new Hub(new Store(":memory:"));
    const files = {
      [config.memory.todosPath]: TODOS,
      [`${config.memory.proposalsDir}/2026-10-19-improvement-proposals.md`]: PROPOSALS,
    };
    const sync = new MemorySync(hub, fakeMemory(files));
    await sync.importAll();
    const todo = hub.store.items().find((i) => /noassign/.test(i.title))!;
    hub.updateItem(todo.id, { status: "today", confirmedAt: new Date().toISOString() });
    new Prompter(hub).tick(at);
    expect(hub.store.questions("open").filter((q) => q.key === `proposal:${todo.id}`)).toHaveLength(0);
  });
});
