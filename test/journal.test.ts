import { expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { MemoryClient } from "../src/server/memory.ts";
import { config } from "../src/server/config.ts";
import { MemorySync, appendArchive, mergeJournal, JOURNAL_HEADER } from "../src/server/memory-sync.ts";
import type { JournalEntry } from "../src/shared/types.ts";

const e = (at: string, text: string): JournalEntry => ({ id: at, at, text, who: "you", synced: false });

test("merges into day sections, newest day first", () => {
  const first = mergeJournal("", [e("2026-09-24T10:00:00", "a"), e("2026-09-25T09:00:00", "b")], () => undefined);
  expect(first.body.startsWith(JOURNAL_HEADER)).toBe(true);
  expect(first.body.indexOf("## 2026-09-25")).toBeLessThan(first.body.indexOf("## 2026-09-24"));
  const second = mergeJournal(first.body, [e("2026-09-25T11:30:00", "c")], () => undefined);
  const day = second.body.split("## 2026-09-25")[1]!.split("## ")[0]!;
  expect(day).toContain("09:00 · you · b");
  expect(day).toContain("11:30 · you · c");
  expect(second.overflow).toBeUndefined();
});

test("spills oldest days when too big", () => {
  const many: JournalEntry[] = [];
  for (let d = 1; d <= 20; d++)
    for (let i = 0; i < 20; i++) many.push(e(`2026-09-${String(d).padStart(2, "0")}T10:${String(i).padStart(2, "0")}:00`, "x".repeat(80)));
  const out = mergeJournal("", many, () => undefined);
  expect(new TextEncoder().encode(out.body).length).toBeLessThanOrEqual(20_000);
  expect(out.overflow).toContain("## 2026-09-01");
  expect(out.body).toContain("## 2026-09-20");
});

// 11-05: R2 had the 01:08-01:30 block twice while the DB held one entry each (j_mw2ukrh1qyskr).
test("re-merging entries already in the file adds nothing (crash between write and mark-synced)", () => {
  const batch = [e("2026-11-05T01:08:00", "a"), e("2026-11-05T01:09:00", "b")];
  const once = mergeJournal("", batch, () => undefined).body;
  const merged = mergeJournal(once, [...batch, e("2026-11-05T01:30:00", "c")], () => undefined);
  const twice = merged.body;
  expect(merged.added).toBe(1);
  expect(twice.match(/01:08 · you · a/g)).toHaveLength(1);
  expect(twice.match(/01:09 · you · b/g)).toHaveLength(1);
  expect(twice).toContain("01:30 · you · c");
});

test("two distinct entries with the same line in one batch are both written", () => {
  const out = mergeJournal("", [{ ...e("2026-09-29T13:39:34", "x"), id: "j1" }, { ...e("2026-09-29T13:39:41", "x"), id: "j2" }], () => undefined);
  expect(out.body.match(/13:39 · you · x/g)).toHaveLength(2);
});

test("two parallel flushJournal() calls over the same unsynced entries write each line once", async () => {
  const hub = new Hub(new Store(":memory:"));
  hub.journal("first thing");
  hub.journal("second thing");
  let file: string | undefined;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const memory = {
    read: async () => { await tick(); return file; },
    // R2 has the new body before the write call returns, so a flush that starts mid-write reads it.
    write: async (_p: string, body: string) => { file = body; await tick(); },
    list: async () => [],
  } as unknown as MemoryClient;
  const sync = new MemorySync(hub, memory, undefined);
  const first = sync.flushJournal();
  await new Promise((r) => setTimeout(r, 7)); // first has written, not yet marked its entries synced
  const results = await Promise.all([first, sync.flushJournal(), sync.flushJournal()]);
  expect(file!.match(/first thing/g)).toHaveLength(1);
  expect(file!.match(/second thing/g)).toHaveLength(1);
  expect(results.reduce((n, r) => n + r.written, 0)).toBe(2);
  expect(hub.store.unsyncedJournal()).toHaveLength(0);
});

test("callers that arrive mid-flush share one follow-up flush", async () => {
  const hub = new Hub(new Store(":memory:"));
  hub.journal("zz-before");
  let file: string | undefined;
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const memory = {
    read: async () => { reads++; await gate; return file; },
    write: async (_p: string, body: string) => { file = body; },
    list: async () => [],
  } as unknown as MemoryClient;
  const sync = new MemorySync(hub, memory, undefined);
  const first = sync.flushJournal();
  hub.journal("zz-during");
  const later = [sync.flushJournal(), sync.flushJournal(), sync.flushJournal()];
  expect(later[1]).toBe(later[0]!);
  expect(later[2]).toBe(later[0]!);
  await Promise.resolve();
  expect(reads).toBe(1); // the follow-up hasn't started while the first is in flight
  release();
  expect((await first).written).toBe(1);
  expect((await later[0]!).written).toBe(1);
  expect(reads).toBe(2);
  expect(file!.match(/zz-before/g)).toHaveLength(1);
  expect(file!.match(/zz-during/g)).toHaveLength(1);
  // Settled: the next call starts a fresh flush.
  hub.journal("zz-after");
  expect((await sync.flushJournal()).written).toBe(1);
});

test("a caller queued behind a failing flush still flushes", async () => {
  const hub = new Hub(new Store(":memory:"));
  hub.journal("kept");
  let file: string | undefined;
  let fail = true;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const memory = {
    read: async () => { await gate; return file; },
    write: async (_p: string, body: string) => { if (fail) { fail = false; throw new Error("R2 down"); } file = body; },
    list: async () => [],
  } as unknown as MemoryClient;
  const sync = new MemorySync(hub, memory, undefined);
  const first = sync.flushJournal();
  const queued = sync.flushJournal();
  release();
  await expect(first).rejects.toThrow("R2 down");
  expect((await queued).written).toBe(1);
  expect(file!.match(/kept/g)).toHaveLength(1);
});

test("an unsynced entry whose line R2 already has is marked synced, not written again", async () => {
  const hub = new Hub(new Store(":memory:"));
  hub.journal("zz-written-then-crashed");
  let file: string | undefined;
  const memory = {
    read: async () => file,
    write: async (_p: string, body: string) => { file = body; },
    list: async () => [],
  } as unknown as MemoryClient;
  const sync = new MemorySync(hub, memory, undefined);
  file = mergeJournal("", hub.store.unsyncedJournal(), () => undefined).body; // the write that landed before the crash
  expect((await sync.flushJournal()).written).toBe(0);
  expect(file!.match(/zz-written-then-crashed/g)).toHaveLength(1);
  expect(hub.store.unsyncedJournal()).toHaveLength(0);
  expect(hub.store.syncState("journal").cursor).toBe("0 entries (1 already there)");
});

test("spilled days go to the archive before the main file drops them", async () => {
  const hub = new Hub(new Store(":memory:"));
  const old: JournalEntry[] = [];
  for (let d = 1; d <= 20; d++)
    for (let i = 0; i < 20; i++) old.push(e(`2026-09-${String(d).padStart(2, "0")}T10:${String(i).padStart(2, "0")}:00`, "x".repeat(80)));
  const files: Record<string, string | undefined> = { [config.memory.journalPath]: mergeJournal("", old.slice(0, 380), () => undefined).body };
  hub.journal(`zz-new ${"y".repeat(3000)}`); // pushes the file over 20 KB, so the oldest days spill
  let failArchive = true;
  const memory = {
    read: async (p: string) => files[p],
    write: async (p: string, body: string) => {
      if (p !== config.memory.journalPath && failArchive) { failArchive = false; throw new Error("R2 down"); }
      files[p] = body;
    },
    list: async () => [],
  } as unknown as MemoryClient;
  const sync = new MemorySync(hub, memory, undefined);
  const before = files[config.memory.journalPath];
  await expect(sync.flushJournal()).rejects.toThrow("R2 down");
  expect(files[config.memory.journalPath]).toBe(before); // nothing dropped from the main file
  expect((await sync.flushJournal()).written).toBe(1);
  const archive = Object.entries(files).find(([p]) => p.includes("-archive-"))![1]!;
  const main = files[config.memory.journalPath]!;
  const spilled = [...archive.matchAll(/^## (\S+)/gm)].map((m) => m[1]!);
  expect(spilled.length).toBeGreaterThan(0);
  for (const d of spilled) expect(main).not.toContain(`## ${d}`);
  expect(main).toContain("zz-new");
});

test("a main-file write that fails after the archive write retries without doubling the archive", async () => {
  const hub = new Hub(new Store(":memory:"));
  const old: JournalEntry[] = [];
  for (let d = 1; d <= 20; d++)
    for (let i = 0; i < 20; i++) old.push(e(`2026-09-${String(d).padStart(2, "0")}T10:${String(i).padStart(2, "0")}:00`, `${d}-${i}-${"x".repeat(80)}`));
  const files: Record<string, string | undefined> = { [config.memory.journalPath]: mergeJournal("", old, () => undefined).body };
  hub.journal(`zz-new ${"y".repeat(3000)}`);
  let failMain = true;
  const memory = {
    read: async (p: string) => files[p],
    write: async (p: string, body: string) => {
      if (p === config.memory.journalPath && failMain) { failMain = false; throw new Error("R2 down"); }
      files[p] = body;
    },
    list: async () => [],
  } as unknown as MemoryClient;
  const sync = new MemorySync(hub, memory, undefined);
  await expect(sync.flushJournal()).rejects.toThrow("R2 down");
  const archivePath = Object.keys(files).find((p) => p.includes("-archive-"))!;
  expect(archivePath).toBeDefined();
  const afterFail = files[archivePath]!;
  expect((await sync.flushJournal()).written).toBe(1);
  expect(files[archivePath]).toBe(afterFail);
  expect(files[config.memory.journalPath]).toContain("zz-new");
  expect(hub.store.unsyncedJournal()).toHaveLength(0);
  const lines = files[archivePath]!.split("\n").filter((l) => l.startsWith("- "));
  expect(lines.length).toBeGreaterThan(0);
  expect(new Set(lines).size).toBe(lines.length);
  for (const [, d] of afterFail.matchAll(/^## (\S+)/gm)) {
    expect(afterFail.split(`## ${d}`)).toHaveLength(2);
    expect(files[config.memory.journalPath]).not.toContain(`## ${d}`);
  }
});

test("an archive append skips lines the archive already has", () => {
  const prev = `# archive\n\n## 2026-09-01\n\n- 10:00 · you · a\n- 10:01 · you · b\n`;
  const out = appendArchive(prev, `## 2026-09-01\n\n- 10:00 · you · a\n- 10:01 · you · b\n\n## 2026-09-02\n\n- 09:00 · you · c\n`);
  expect(out.match(/10:00 · you · a/g)).toHaveLength(1);
  expect(out.match(/## 2026-09-01/g)).toHaveLength(1);
  expect(out).toContain("## 2026-09-02\n\n- 09:00 · you · c");
});

test("a failed flush doesn't block the next one", async () => {
  const hub = new Hub(new Store(":memory:"));
  hub.journal("survives");
  let file: string | undefined;
  let fail = true;
  const memory = {
    read: async () => file,
    write: async (_p: string, body: string) => { if (fail) throw new Error("R2 down"); file = body; },
    list: async () => [],
  } as unknown as MemoryClient;
  const sync = new MemorySync(hub, memory, undefined);
  await expect(sync.flushJournal()).rejects.toThrow("R2 down");
  fail = false;
  expect((await sync.flushJournal()).written).toBe(1);
  expect(file!.match(/survives/g)).toHaveLength(1);
});
