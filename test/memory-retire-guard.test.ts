import { describe, expect, test } from "bun:test";
import { config } from "../src/server/config.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { MemoryClient } from "../src/server/memory.ts";
import { MemorySync } from "../src/server/memory-sync.ts";

// 11-04 16:58Z an agent wrote active-todos back wrapped in the MCP read envelope. It parsed to zero todos,
// and at 17:17 memory-sync retired ~40 live items as "No longer in memory". An empty or unparseable file
// is not a signal that the to-dos are gone.
const TODOS = `---
tags: [core, workload, todos]
---

# Active Todos

## Do first

- [ ] **Send the Dane reply** — draft sits in Gmail.
- [ ] **Review the kitesurf MR** — Rui asked.
`;

const WRAPPED = `Read memory/workload/active-todos.md (31560 bytes)\n\n${JSON.stringify({ content: TODOS, size: TODOS.length })}`;

const OLD = "2020-01-01T00:00:00.000Z";
const PROPOSALS_PATH = `${config.memory.proposalsDir}/2026-11-04-improvement-proposals.md`;

function fakeMemory(files: Record<string, string | undefined>): MemoryClient {
  return {
    read: async (p: string) => files[p],
    list: async (dir: string) => Object.keys(files).filter((p) => p.startsWith(dir) && files[p] !== undefined).map((path) => ({ path })),
    write: async () => {},
  } as unknown as MemoryClient;
}

async function seeded() {
  const hub = new Hub(new Store(":memory:"));
  const files: Record<string, string | undefined> = { [config.memory.todosPath]: TODOS };
  const sync = new MemorySync(hub, fakeMemory(files), undefined);
  await sync.importAll();
  const live = () => hub.store.items().filter((i) => i.source.key?.startsWith("memory:active-todos") && i.status !== "dropped");
  expect(live()).toHaveLength(2);
  return { hub, files, sync, live };
}

describe("memory-sync retire guard", () => {
  const bad: [string, string, number?][] = [
    ["starting with a #tag, not a heading", "#tag\n\n## Do first\n\n- [ ] **Send the Dane reply** — draft.\n", 1],
    ["wrapped in the MCP read envelope", WRAPPED],
    ["empty", ""],
    ["a heading but no to-dos", "# Active Todos\n\nNothing here.\n"],
  ];
  for (const [name, body, count = 0] of bad) {
    test(`active-todos ${name}: nothing retired, sync shows an error`, async () => {
      const { hub, files, sync, live } = await seeded();
      hub.putSync({ ...hub.store.syncState("memory"), lastOkAt: OLD });
      files[config.memory.todosPath] = body;
      const r = await sync.importAll();
      expect(r.dropped).toBe(0);
      expect(live()).toHaveLength(2);
      expect(hub.store.syncState("memory").lastOkAt).toBe(OLD);
      const bytes = new TextEncoder().encode(body).length;
      expect(hub.store.syncState("memory").error).toBe(`active-todos unparseable: ${bytes} bytes, ${count} items`);
      expect(hub.store.journal().some((e) => /No longer in memory/.test(e.text))).toBe(false);
    });
  }

  test("active-todos missing: nothing retired, error says missing, last good time kept", async () => {
    const { hub, files, sync, live } = await seeded();
    hub.putSync({ ...hub.store.syncState("memory"), lastOkAt: OLD });
    files[config.memory.todosPath] = undefined;
    files[PROPOSALS_PATH] = "# Proposals\n\n## High Priority\n\n### 1. Guard the retire step\n\nIt dropped 40 items.\n";
    const r = await sync.importAll();
    expect(r.dropped).toBe(0);
    expect(live()).toHaveLength(2);
    expect(hub.store.syncState("memory").error).toBe("active-todos missing: 0 items, nothing retired");
    expect(hub.store.syncState("memory").lastOkAt).toBe(OLD);
    // Proposals still import while active-todos is blocked.
    expect(hub.store.items().some((i) => i.title === "Guard the retire step")).toBe(true);
  });

  test("a file that starts with a ## section still retires", async () => {
    const { hub, files, sync, live } = await seeded();
    files[config.memory.todosPath] = "## Do first\n\n- [ ] **Send the Dane reply** — draft.\n";
    const r = await sync.importAll();
    expect(r.dropped).toBe(1);
    expect(live().map((i) => i.title)).toEqual(["Send the Dane reply"]);
    expect(hub.store.syncState("memory").error).toBeUndefined();
  });

  test("garbage before the to-dos: nothing retired", async () => {
    const { hub, files, sync, live } = await seeded();
    const body = "garbage preamble\n\n## Do first\n\n- [ ] **Send the Dane reply** — draft.\n";
    files[config.memory.todosPath] = body;
    const r = await sync.importAll();
    expect(r.dropped).toBe(0);
    expect(live()).toHaveLength(2);
    expect(hub.store.syncState("memory").error).toBe(`active-todos unparseable: ${new TextEncoder().encode(body).length} bytes, 1 items`);
  });

  test("a normal file still retires a removed item and clears the error", async () => {
    const { hub, files, sync, live } = await seeded();
    files[config.memory.todosPath] = WRAPPED;
    await sync.importAll();
    hub.putSync({ ...hub.store.syncState("memory"), lastOkAt: OLD });
    files[config.memory.todosPath] = TODOS.replace(/- \[ \] \*\*Review the kitesurf MR\*\*.*\n/, "");
    const r = await sync.importAll();
    expect(r.dropped).toBe(1);
    expect(live().map((i) => i.title)).toEqual(["Send the Dane reply"]);
    expect(hub.store.syncState("memory").error).toBeUndefined();
    expect(hub.store.syncState("memory").lastOkAt).not.toBe(OLD);
  });
});
