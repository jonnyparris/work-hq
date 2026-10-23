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

test("usage digest: a yes on a command-bar follow-up with no job after it is flagged; dates show over a day", async () => {
  const path = `${tmpdir()}/whq-usage-dead-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const now = Date.now();
  const iso = (ago: number) => new Date(now - ago * 60_000).toISOString();
  const put = (key: string, prompt: string, answer: string, ago: number) =>
    hub.store.putQuestion({ id: `q_${key}`, kind: "open", key, prompt, answer, status: "answered", priority: 80, options: [], createdAt: iso(ago + 5), answeredAt: iso(ago) });
  put("triage:1", "Want an agent to find both and update them to M5?", "Yes, dispatch", 26 * 60); // nothing after it
  put("triage:2", "Send an agent to find the owner?", "Yes, research it", 120); // a job followed
  put("triage:3", "Draft the usage report?", "No", 90); // not a yes
  put("triage-failed:4", "Couldn't triage: \"x\"", "Retry", 60); // not a follow-up card
  const job = { id: "j1", kind: "triage", name: "chat", title: "find the owner", surface: "headless", status: "done", tail: [], createdAt: iso(119.5) } as any;
  hub.store.putJob(job); // the tap's own triage run
  hub.store.putJob({ ...job, id: "j2", kind: "sweep", name: "transcripts", createdAt: iso(26 * 60 - 1) }); // a sweep doesn't count
  hub.store.putJob({ ...job, id: "j3", kind: "action", name: "work", createdAt: iso(26 * 60 - 1) }); // nor does another item's dispatch
  hub.store.putJob({ ...job, id: "j4", kind: "triage", name: "chat", createdAt: iso(26 * 60 - 10) }); // nor a triage 10 min later
  hub.store.db.close();
  const p = Bun.spawn(["bun", "src/cli/usage.ts", "--db", path, "--since", new Date(now - 2 * 86400_000).toISOString(), "--until", new Date(now + 60_000).toISOString()], {
    stdout: "pipe",
    env: { ...process.env, WORK_HQ_CONFIG: "none" },
  });
  const out = await new Response(p.stdout).text();
  rmSync(path, { force: true });
  const section = out.split("## Yes taps that started nothing")[1]!.split("\n## ")[0]!;
  expect(section).toMatch(/- \d\d-\d\d \d\d:\d\d \*\*Want an agent to find both/);
  expect(section).not.toContain("find the owner");
  expect(section).not.toContain("usage report");
  expect(section).not.toContain("Couldn't triage");
});

test("usage digest: a card answered hours after a note isn't credited to it", async () => {
  const path = `${tmpdir()}/whq-usage-late-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const t0 = Date.now() - 50 * 60_000;
  const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const q = (id: string, answeredMin: number) =>
    hub.store.putQuestion({ id, kind: "confirm", key: `k:${id}`, priority: 1, prompt: `Card ${id}?`, options: [], status: "answered", answer: "Done", createdAt: iso(0), answeredAt: iso(answeredMin) });
  q("q_soon", 1);
  q("q_late", 40);
  hub.store.putQuestion({ ...hub.store.question("q_late")!, id: "q_exp", key: "k:q_exp", prompt: "Card q_exp?", status: "expired", answer: "pushed" });
  hub.store.putJournal({ id: "j1", at: iso(0), questionId: "q_soon", who: "you", text: 'Re "Card q_soon?": quick', synced: false });
  hub.store.putJournal({ id: "j2", at: iso(0), questionId: "q_late", who: "you", text: 'Re "Card q_late?": slow', synced: false });
  hub.store.putJournal({ id: "j3", at: iso(0), questionId: "q_exp", who: "you", text: 'Re "Card q_exp?": gone', synced: false });
  hub.store.db.close();
  const out = await digest(path);
  rmSync(path, { force: true });
  expect(out).toMatch(/quick → card closed: Done/);
  expect(out).toMatch(/gone → not acted on; card expired at \d\d:\d\d/);
  expect(out).toMatch(/slow → not acted on; card answered separately at \d\d:\d\d/);
});

test("usage digest: a kept card (Open draft) put back isn't a new ask with a huge wait", async () => {
  const path = `${tmpdir()}/whq-usage-keep-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const t0 = new Date(Date.now() - 50 * 60_000).toISOString();
  const base = { kind: "confirm" as const, key: "k:draft", priority: 1, prompt: "Read the draft?", options: [], createdAt: t0 };
  hub.store.putQuestion({ ...base, id: "q_orig", status: "answered", answer: "Open draft", answeredAt: new Date(Date.now() - 49 * 60_000).toISOString() });
  // Stamped copy (new code) and an unstamped legacy copy sharing key + createdAt.
  hub.store.putQuestion({ ...base, id: "q_new", status: "answered", answer: "Done", answeredAt: new Date().toISOString(), reopenedFrom: "q_orig" });
  hub.store.putQuestion({ ...base, id: "q_old", status: "open" });
  hub.store.db.close();
  const out = await digest(path);
  rmSync(path, { force: true });
  expect(out).toMatch(/\| confirm \| 1 \| 1 \| 0 \| 0 \| 1 min \|/);
  expect(out).not.toContain("Read the draft?** (");
});

test("hub.reopen stamps reopenedFrom on the copy", async () => {
  const hub = new Hub(new Store(":memory:"));
  const q = hub.ask({ kind: "confirm", key: "k:keep", priority: 1, prompt: "Open it?", options: [{ id: "o", label: "Open draft", effect: { type: "open", url: "https://example.com", keep: true } }] })!;
  await hub.answer(q.id, "o");
  const copy = hub.store.questions().find((x) => x.id !== q.id && x.key === "k:keep");
  expect(copy?.reopenedFrom).toBe(q.id);
  expect(copy?.createdAt).toBe(q.createdAt);
});
