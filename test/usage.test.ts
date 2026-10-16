import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";

test("usage digest flags a note that did nothing and a repeated question", async () => {
  const path = `${tmpdir()}/whq-usage-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const it = hub.createItem({ title: "Send the spec for review", status: "inbox" });
  for (const k of ["a", "b"]) hub.ask({ kind: "confirm", itemId: it.id, key: `k:${k}`, priority: 1, prompt: it.title, options: [] });
  hub.journal(`Note on ${it.title}: make it shorter first`, { itemId: it.id });
  hub.store.db.close();
  const p = Bun.spawn(["bun", "src/cli/usage.ts", "--db", path, "--since", new Date(Date.now() - 3600_000).toISOString()], { stdout: "pipe", env: { ...process.env, WORK_HQ_CONFIG: "none" } });
  const out = await new Response(p.stdout).text();
  rmSync(path, { force: true });
  expect(out).toContain("## Asked more than once");
  expect(out).toContain("Send the spec for review** (2×)");
  expect(out).toContain("**nothing happened**");
});

async function digest(path: string) {
  const p = Bun.spawn(["bun", "src/cli/usage.ts", "--db", path, "--since", new Date(Date.now() - 3600_000).toISOString(), "--until", new Date(Date.now() + 60_000).toISOString()], {
    stdout: "pipe",
    env: { ...process.env, WORK_HQ_CONFIG: "none" },
  });
  return new Response(p.stdout).text();
}

test("usage digest: a burst under 1s apart is a replay, not typing twice", async () => {
  const path = `${tmpdir()}/whq-usage-replay-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const it = hub.createItem({ title: "Chase the load test", status: "inbox" });
  const t0 = Date.now() - 20 * 60_000;
  const put = (ms: number, text: string) => hub.store.putJournal({ id: `j${ms}`, at: new Date(t0 + ms).toISOString(), itemId: it.id, who: "you", text, synced: false });
  put(0, `Note on ${it.title}: chase Thursday`); // typed
  put(600_000, `Note on ${it.title}: chase Thursday`); // replayed with others, 35 ms apart
  put(600_035, `Note on ${it.title}: something else`);
  hub.store.db.close();
  const out = await digest(path);
  rmSync(path, { force: true });
  expect(out).not.toContain("typed more than once");
  expect(out.match(/\(replayed\)/g)?.length).toBe(2);
});

test("usage digest: item-less notes are traced through their questionId", async () => {
  const path = `${tmpdir()}/whq-usage-qid-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const other = hub.ask({ kind: "confirm", key: "k:other", priority: 1, prompt: "Some other item-less card?", options: [] })!;
  const q = hub.ask({ kind: "confirm", key: "k:qid", priority: 1, prompt: "Send an agent to find the owner?", options: [] })!;
  await hub.note(q.id, "there's a wiki page, only the account owner can do it");
  const j = hub.store.journal().find((e) => e.text.startsWith("Re "))!;
  expect(j.questionId).toBe(q.id);
  expect(other.id).not.toBe(q.id);
  hub.store.db.close();
  const out = await digest(path);
  rmSync(path, { force: true });
  expect(out).toMatch(/only the account owner can do it → (parked till morning|card closed)/);
});

test("usage digest: command-bar wrap-ups count as typed, and the Work HQ tag is narrow", async () => {
  const path = `${tmpdir()}/whq-usage-wrap-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const prompt = "Sam / Alex 1-1 just ended. Anything you committed to?";
  const q = hub.ask({ kind: "review", key: "k:rev", priority: 1, prompt, options: [{ id: "none", label: "Nothing new", effect: { type: "dismiss" } } as any] })!;
  hub.journal(`${prompt}\nSam owns the upstream library contributions`);
  hub.journal("Can you review this question in the RFC before the card deadline?");
  hub.journal("Work HQ should keep focus while I dictate");
  hub.journal("adapt our work-hq prompting to the new flow");
  const cur = hub.store.question(q.id)!;
  hub.store.putQuestion({ ...cur, status: "answered", answer: "Nothing new", answeredAt: new Date().toISOString() });
  hub.store.db.close();
  const out = await digest(path);
  rmSync(path, { force: true });
  expect(out).toContain('"Nothing new" 0');
  expect(out).toContain("typed something 1");
  expect(out).toContain("[meeting wrap-up]");
  expect(out).toMatch(/before the card deadline\?\n/);
  expect(out).toMatch(/keep focus while I dictate \*\*\[about Work HQ itself\]\*\*/);
  expect(out).toMatch(/work-hq prompting to the new flow \*\*\[about Work HQ itself\]\*\*/);
});
