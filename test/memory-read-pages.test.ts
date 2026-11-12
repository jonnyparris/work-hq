// MemoryClient.read over the real HTTP path against a fake memory MCP that pages like agent-memory-mcp (shapes
// checked live 11-12): 50K chars a call, `truncated` + `next_offset`, a human preamble part before the JSON. Without
// `offset` the real server omits total_length and appends "[Content truncated...]" to the content. 11-10 and 11-11
// the journal flush read one page of the archive and wrote it back, marker included, deleting 11-05..11-09.
import { afterAll, afterEach, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { MemoryClient } from "../src/server/memory.ts";
import { config } from "../src/server/config.ts";
import { MemorySync, journalArchivePath, mergeJournal } from "../src/server/memory-sync.ts";
import type { JournalEntry } from "../src/shared/types.ts";

const PAGE = 50_000;
const MARKER = "\n\n[Content truncated...]";
const files: Record<string, string> = {};
const writes: string[] = [];
type Mode = "ok" | "no-next" | "changes-stamp" | "changes-length" | "plain-text" | "no-content";
let mode: Mode = "ok";
/** Paths the current mode applies to; empty = every path. */
let modePaths: string[] = [];
afterEach(() => {
  mode = "ok";
  modePaths = [];
});

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body: any = await req.json();
    const { name, arguments: args } = body.params;
    const reply = (text: string, isError = false) =>
      Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }], isError } });
    if (name === "write") {
      files[args.path] = args.content;
      writes.push(args.path);
      return reply(JSON.stringify({ ok: true }));
    }
    if (name !== "read") return reply("{}");
    const file = files[args.path];
    if (file === undefined) return reply(`File not found: ${args.path}`, true);
    const m: Mode = !modePaths.length || modePaths.includes(args.path) ? mode : "ok";
    if (m === "plain-text") return reply(file.slice(0, PAGE));
    if (m === "no-content") return reply(JSON.stringify({ updated_at: "x", size: file.length }));
    const paged = args.offset !== undefined || args.limit !== undefined;
    const offset = args.offset ?? 0;
    const content = file.slice(offset, offset + PAGE);
    const end = offset + content.length;
    const truncated = end < file.length;
    const later = offset > 0;
    const json = {
      content: paged || !truncated ? content : content + MARKER,
      updated_at: `2026-11-12T00:00:0${m === "changes-stamp" && later ? 1 : 0}.000Z`,
      size: file.length,
      ...(truncated ? { truncated: true, original_size: file.length, ...(m === "no-next" ? {} : { next_offset: end }) } : {}),
      ...(paged ? { offset, returned: content.length, total_length: file.length + (m === "changes-length" && later ? 1 : 0) } : {}),
    };
    const head = paged ? `chars ${offset}-${end} of ${file.length}` : `${file.length} bytes`;
    return reply(`Read ${args.path} (${head})${truncated ? ` · truncated, pass offset=${end} to continue` : ""}\n\n${JSON.stringify(json)}`);
  },
});
afterAll(() => server.stop(true));
const client = () => new MemoryClient(`http://127.0.0.1:${server.port}/mcp`, "t");

const e = (at: string, text: string): JournalEntry => ({ id: at, at, text, who: "you", synced: false });
/** A 120K+ archive: one section a day, every line unique, with BMP and astral (surrogate-pair) characters. */
function bigArchive() {
  let out = `---\ntags: [workload, work-hq, journal, archive]\n---\n\n# Work HQ Journal — archive\n`;
  for (let d = 1; d <= 30; d++) {
    out += `\n## 2026-08-${String(d).padStart(2, "0")}\n\n`;
    for (let i = 0; i < 40; i++) out += `- 10:${String(i).padStart(2, "0")} · you · day ${d} line ${i} 🤖 ${"é".repeat(80)}\n`;
  }
  return out;
}
/** A main journal just under the 20 KB cap (so nothing spills while seeding), plus one big entry that makes it spill. */
function seedMain(hub: Hub) {
  const old: JournalEntry[] = [];
  for (let d = 1; d <= 9; d++)
    for (let i = 0; i < 20; i++) old.push(e(`2026-09-${String(d).padStart(2, "0")}T10:${String(i).padStart(2, "0")}:00`, "x".repeat(80)));
  const seeded = mergeJournal("", old, () => undefined);
  expect(seeded.overflow).toBeUndefined();
  files[config.memory.journalPath] = seeded.body;
  hub.journal(`zz-new ${"y".repeat(3000)}`);
}

test("read follows next_offset and returns the whole file, no truncation marker", async () => {
  files["a.md"] = bigArchive();
  expect(files["a.md"]!.length).toBeGreaterThan(120_000);
  const got = await client().read("a.md");
  expect(got).toBe(files["a.md"]);
  expect(got).not.toContain("[Content truncated");
  files["small.md"] = "tiny\n";
  expect(await client().read("small.md")).toBe("tiny\n");
  files["empty.md"] = "";
  expect(await client().read("empty.md")).toBe("");
  expect(await client().read("missing.md")).toBeUndefined();
});

test("a flush over a 120K archive keeps every archived line and adds the spilled days", async () => {
  const archivePath = journalArchivePath();
  files[archivePath] = bigArchive();
  const before = files[archivePath]!.split("\n").filter((l) => l.startsWith("- "));
  const hub = new Hub(new Store(":memory:"));
  seedMain(hub);
  const mainBefore = files[config.memory.journalPath]!;
  writes.length = 0;
  expect((await new MemorySync(hub, client(), undefined).flushJournal()).written).toBe(1);
  expect(writes).toEqual([archivePath, config.memory.journalPath]);
  const after = files[archivePath]!;
  expect(after).not.toContain("[Content truncated");
  for (const l of before) expect(after).toContain(l);
  const days = (s: string) => [...s.matchAll(/^## (\d{4}-\d{2}-\d{2})\s*$/gm)].map((m) => m[1]!);
  const spilled = days(mainBefore).filter((d) => !days(files[config.memory.journalPath]!).includes(d));
  expect(spilled.length).toBeGreaterThan(0);
  for (const d of spilled) expect(after).toContain(`## ${d}`);
});

for (const [m, err] of [
  ["no-next", /no usable next_offset/],
  ["changes-stamp", /changed between pages/],
  ["changes-length", /changed between pages/],
  ["plain-text", /unrecognised reply/],
  ["no-content", /unrecognised reply/],
] as const) {
  test(`${m}: read throws instead of returning a short or stitched file`, async () => {
    mode = m;
    files["a.md"] = bigArchive();
    await expect(client().read("a.md")).rejects.toThrow(err);
  });
}

test("a bad main-journal read: the flush writes nothing and keeps the entries unsynced", async () => {
  mode = "no-next";
  files[config.memory.journalPath] = bigArchive(); // main journal itself over one page
  const hub = new Hub(new Store(":memory:"));
  hub.journal("one more");
  writes.length = 0;
  await expect(new MemorySync(hub, client(), undefined).flushJournal()).rejects.toThrow(/next_offset/);
  expect(writes).toEqual([]);
  expect(hub.store.unsyncedJournal()).toHaveLength(1);
});

test("a bad archive read (the 11-10 path): the flush writes neither file", async () => {
  const archivePath = journalArchivePath();
  files[archivePath] = bigArchive();
  const archiveBefore = files[archivePath];
  const hub = new Hub(new Store(":memory:"));
  seedMain(hub);
  const mainBefore = files[config.memory.journalPath];
  mode = "no-next";
  modePaths = [archivePath];
  writes.length = 0;
  await expect(new MemorySync(hub, client(), undefined).flushJournal()).rejects.toThrow(/next_offset/);
  expect(writes).toEqual([]);
  expect(files[archivePath]).toBe(archiveBefore);
  expect(files[config.memory.journalPath]).toBe(mainBefore);
  expect(hub.store.unsyncedJournal()).toHaveLength(1);
});
