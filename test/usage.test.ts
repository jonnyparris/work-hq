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

test("usage digest: a note whose reply claimed an agent that never started reads as nothing happened, not parked", async () => {
  const path = `${tmpdir()}/whq-usage-stranded-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const t0 = Date.now() - 30 * 60_000;
  const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const card = (id: string) =>
    hub.store.putQuestion({ id, kind: "confirm", key: `k:${id}`, priority: 1, prompt: `Card ${id}?`, options: [], status: "open", createdAt: iso(0), notBefore: iso(24 * 60) });
  card("q_strand");
  card("q_park");
  const put = (id: string, min: number, questionId: string, who: "you" | "hq", text: string) => hub.store.putJournal({ id, at: iso(min), questionId, who, text, synced: false });
  put("j1", 1, "q_strand", "you", 'Re "Card q_strand?": first try');
  put("j2", 2, "q_strand", "you", 'Re "Card q_strand?": check them all yourself');
  put("j3", 2.1, "q_strand", "hq", 'Note reply claimed a dispatch but none started (card has no single item): "Sending an agent"');
  put("j4", 1, "q_park", "you", 'Re "Card q_park?": just background');
  hub.store.db.close();
  const out = await digest(path);
  rmSync(path, { force: true });
  expect(out).toMatch(/check them all yourself → \*\*nothing happened\*\* \(reply claimed an agent; none started\)/);
  // The earlier note on the same card isn't blamed for the later claim, and an unrelated parked card stays parked.
  expect(out).toMatch(/first try → parked till morning/);
  expect(out).toMatch(/just background → parked till morning/);
});

test("usage digest: a stamped claim goes to its own note even when a later note came first; heuristic claims are hedged", async () => {
  const path = `${tmpdir()}/whq-usage-claimid-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const t0 = Date.now() - 30 * 60_000;
  const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();
  hub.store.putQuestion({ id: "q_race", kind: "confirm", key: "k:race", priority: 1, prompt: "Card race?", options: [], status: "open", createdAt: iso(0), notBefore: iso(24 * 60) });
  const it = hub.createItem({ title: "Chase the vendor", status: "inbox" });
  hub.store.putJournal({ id: "n1", at: iso(1), questionId: "q_race", who: "you", text: 'Re "Card race?": slow one', synced: false });
  hub.store.putJournal({ id: "n2", at: iso(1.2), questionId: "q_race", who: "you", text: 'Re "Card race?": quick one', synced: false });
  hub.store.putJournal({ id: "c1", at: iso(1.5), questionId: "q_race", noteId: "n1", who: "hq", text: 'Note reply claimed a dispatch but none started (card has no single item): "On it"', synced: false });
  hub.store.putJournal({ id: "n3", at: iso(2), itemId: it.id, questionId: "q_item", who: "you", text: `Note on ${it.title}: chase them`, synced: false });
  hub.store.putJournal({ id: "c2", at: iso(2.1), itemId: it.id, questionId: "q_item", noteId: "n3", who: "hq", text: 'Note reply claimed a dispatch but none started (heuristic, check it): "Chasing"', synced: false });
  hub.store.db.close();
  const out = await digest(path);
  rmSync(path, { force: true });
  expect(out).toMatch(/slow one → \*\*nothing happened\*\* \(reply claimed an agent/);
  expect(out).not.toMatch(/quick one → \*\*nothing happened/);
  expect(out).toMatch(/chase them → \*\*nothing happened\*\* \(no agent started; reply may have promised one\)/);
});

test("hub stamps the note's journal id on a dispatch claim that started nothing", async () => {
  const hub = new Hub(new Store(":memory:"));
  const q = hub.ask({ kind: "confirm", key: "k:stamp", priority: 1, prompt: "Which of these are done?", options: [] })!;
  (hub as any).dispatcher = { readNote: async () => ({ reply: "Sending an agent to check them.", dispatch: { action: "work" } }) };
  await hub.note(q.id, "check them all yourself");
  const isClaim = (e: { text: string }) => e.text.startsWith("Note reply claimed a dispatch but none started");
  for (let i = 0; i < 100 && !hub.store.journal().some(isClaim); i++) await new Promise((r) => setTimeout(r, 10));
  const all = hub.store.journal();
  const note = all.find((e) => e.who === "you" && e.questionId === q.id)!;
  const claim = all.find(isClaim)!;
  expect(claim.noteId).toBe(note.id);
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


test("usage digest: network-error retries reconcile to the jobs they ran on", async () => {
  const path = `${tmpdir()}/whq-usage-nudges-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const job = { id: "n1", kind: "action", name: "work", title: "t", surface: "cmux", status: "done", tail: [], createdAt: at, nudges: { transient: 1 } } as any;
  hub.store.putJob(job);
  hub.store.putJob({ ...job, id: "n2", status: "failed", error: "Connection error. (again after one retry)" });
  hub.store.putJob({ ...job, id: "n3", status: "running" });
  hub.store.putJob({ ...job, id: "n4", nudges: undefined });
  hub.store.db.close();
  const out = await digest(path);
  rmSync(path, { force: true });
  expect(out).toContain("network-error retries: 3 on 3 job(s) \u00b7 then done 1 \u00b7 failed 1 \u00b7 still open 1");
  expect(out).not.toContain("rate-limit retries");
});

test("usage digest: agent follow-ups on one item aren't repeats; the trail shows when each was answered", async () => {
  const path = `${tmpdir()}/whq-usage-agent-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const kite = hub.createItem({ title: "Kitesurf shadow mode", status: "inbox" });
  for (const k of ["a", "b", "c"]) hub.ask({ kind: "open", itemId: kite.id, key: `agent:${k}`, priority: 1, prompt: `Agent question ${k}?`, options: [] });
  hub.ask({ kind: "open", itemId: kite.id, key: "after:job1", priority: 1, prompt: "Agent finished?", options: [] });
  hub.ask({ kind: "confirm", itemId: kite.id, key: "k:kite", priority: 1, prompt: kite.title, options: [] });
  // Stopped-run fold cards are Work HQ's own ask: they still count as repeats.
  const fold = hub.createItem({ title: "Flaky deploy", status: "inbox" });
  for (const k of ["j1", "j2"]) hub.ask({ kind: "open", itemId: fold.id, key: `after:fold:${k}`, priority: 1, prompt: `Stopped ${k}?`, options: [] });
  const mr = hub.createItem({ title: "Review !1691", status: "inbox" });
  const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
  for (const k of ["a", "b"]) {
    const q = hub.ask({ kind: "confirm", itemId: mr.id, key: `k:mr${k}`, priority: 1, prompt: `${mr.title} ${k}?`, options: [] })!;
    if (k === "a") hub.store.putQuestion({ ...hub.store.question(q.id)!, createdAt: twoDaysAgo, status: "answered", answer: "Done", answeredAt: new Date().toISOString() });
  }
  hub.store.db.close();
  const p = Bun.spawn(["bun", "src/cli/usage.ts", "--db", path, "--since", new Date(Date.now() - 3 * 86400_000).toISOString(), "--until", new Date(Date.now() + 60_000).toISOString()], { stdout: "pipe", env: { ...process.env, WORK_HQ_CONFIG: "none" } });
  const out = await new Response(p.stdout).text();
  rmSync(path, { force: true });
  const repeats = out.split("## Asked more than once")[1]!.split("\n## ")[0]!;
  const [human = "", agent = ""] = repeats.split("### Agent follow-ups");
  expect(human).not.toContain("Kitesurf shadow mode");
  expect(agent).toContain("Kitesurf shadow mode** (4)");
  expect(human).toContain("Flaky deploy** (2×)");
  expect(agent).not.toContain("Flaky deploy");
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = (iso: string) => { const d = new Date(iso); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const row = human.split("\n").find((l) => l.includes("Review !1691"))!;
  expect(row).toContain("(2×)");
  expect(row).toContain(`${day(new Date().toISOString())} `);
  expect(row).not.toContain(`${day(twoDaysAgo)} `);
});

test("usage digest: a long repeat trail keeps the newest 12 and counts the rest", async () => {
  const path = `${tmpdir()}/whq-usage-cap-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const it = hub.createItem({ title: "Nag me daily", status: "inbox" });
  const t0 = Date.now() - 50 * 60_000;
  for (let i = 0; i < 14; i++) {
    const q = hub.ask({ kind: "confirm", itemId: it.id, key: `k:nag${i}`, priority: 1, prompt: `Nag ${i}?`, options: [] })!;
    hub.store.putQuestion({ ...hub.store.question(q.id)!, createdAt: new Date(t0 + i * 60_000).toISOString(), status: "answered", answer: `ans${i}`, answeredAt: new Date(t0 + i * 60_000 + 1000).toISOString() });
  }
  hub.store.db.close();
  const out = await digest(path);
  rmSync(path, { force: true });
  const row = out.split("\n").find((l) => l.includes("Nag me daily"))!;
  expect(row).toContain("(14×): +2 earlier · ");
  expect(row).not.toContain("ans1 ");
  expect(row).toContain("ans2 ");
  expect(row.trim().endsWith("ans13")).toBe(true);
});
