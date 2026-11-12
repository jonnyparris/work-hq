import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import type { Item, Job } from "../src/shared/types.ts";

// it_mwahl8nte50sv: asks a chat triage parked before 2b214e6 (11-09 16:34 UTC) never got a "Send an agent?" card.
// The four 11-06 ones are the real shape: the item is created a millisecond before the triage job is marked done.
const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };

const triage = (id: string, finishedAt: string, summary: string, name = "chat"): Job => ({
  id, kind: "triage", name, title: summary.slice(0, 80), surface: "headless", status: "done", tail: [],
  createdAt: new Date(Date.parse(finishedAt) - 7000).toISOString(), startedAt: new Date(Date.parse(finishedAt) - 7000).toISOString(),
  finishedAt, summary,
});
const item = (id: string, createdAt: string, extra: Partial<Item> = {}): Item => ({
  id, kind: "task", status: "proposed", title: `Ask ${id}`, source: { type: "voice" }, createdAt, updatedAt: createdAt, ...extra,
} as Item);
const at = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function seeded(seed: (s: Store) => void) {
  const store = new Store(":memory:");
  seed(store);
  return store;
}
const boot = (store: Store) => {
  const hub = new Hub(store);
  new Agents(hub, noCmux);
  return hub;
};
const parkedCards = (hub: Hub) => hub.store.questions("open").filter((q) => q.key.startsWith("parked:"));

const PARKED = "Added a task to adopt the ci/ai CLI in MR authoring workflows. Nothing dispatched; say the word if you want an agent to wire it in. (No agent started.)";
const T = "2026-11-06T11:47:16.917Z";

test("seeded parked item → one parked: card on boot, with a dispatch button and the reply (minus suffix) as context", () => {
  const store = seeded((s) => {
    s.putJob(triage("job_a", T, PARKED));
    s.putItem(item("it_a", at(T, -1)));
  });
  const hub = boot(store);
  const cards = parkedCards(hub);
  expect(cards.map((q) => q.key)).toEqual(["parked:it_a"]);
  expect(cards[0].kind).toBe("dispatch");
  expect(cards[0].options[0].effect).toMatchObject({ type: "dispatch" });
  expect(cards[0].context).toContain("say the word");
  expect(cards[0].context).not.toContain("No agent started");
});

test("runs once: a second boot raises nothing, even after the card is answered", () => {
  const store = seeded((s) => {
    s.putJob(triage("job_a", T, PARKED));
    s.putItem(item("it_a", at(T, -1)));
  });
  const first = boot(store);
  const [q] = parkedCards(first);
  store.putQuestion({ ...q, status: "answered", answer: "later", answeredAt: new Date().toISOString() });
  expect(parkedCards(boot(store))).toHaveLength(0);
  expect(store.kv("parkedBackfill")).toBeTruthy();
});

test("kv gate: once it has run, a newly seen pre-cutoff parked ask gets no card", () => {
  const store = seeded((s) => s.setKv("parkedBackfill", "2026-11-12T00:00:00.000Z"));
  store.putJob(triage("job_a", T, PARKED));
  store.putItem(item("it_a", at(T, -1)));
  expect(parkedCards(boot(store))).toHaveLength(0);
});

test("only triage's own items: not a non-voice item at the same moment, not one from earlier in the run, not one after it finished", () => {
  const store = seeded((s) => {
    s.putJob(triage("job_a", T, PARKED)); // ran 7 s
    s.putItem(item("it_early", at(T, -6500))); // voice, but long before the reply was applied
    s.putItem(item("it_transcript", at(T, -2), { source: { type: "transcript" } } as Partial<Item>));
    s.putItem(item("it_after", at(T, 500)));
    s.putItem(item("it_a", at(T, -1)));
  });
  expect(parkedCards(boot(store)).map((q) => q.key)).toEqual(["parked:it_a"]);
});

test("a note read finishing beside a parked chat triage doesn't make its item ambiguous", () => {
  const store = seeded((s) => {
    s.putJob(triage("job_a", T, PARKED));
    s.putJob(triage("job_n", at(T, 2000), "Sent an agent to check.", "note"));
    s.putItem(item("it_a", at(T, -1)));
  });
  expect(parkedCards(boot(store)).map((q) => q.key)).toEqual(["parked:it_a"]);
});

test("a review triage finishing beside a parked chat triage makes its item ambiguous: no card", () => {
  const store = seeded((s) => {
    s.putJob(triage("job_a", T, PARKED));
    s.putJob(triage("job_r", at(T, 2000), "Logged the notes.", "review"));
    s.putItem(item("it_a", at(T, -1)));
  });
  expect(parkedCards(boot(store))).toHaveLength(0);
});

test("an item inside two triage jobs' windows is ambiguous: no card", () => {
  const store = seeded((s) => {
    s.putJob(triage("job_a", T, PARKED));
    s.putJob(triage("job_b", at(T, 2000), "Added it and dispatched an agent."));
    s.putItem(item("it_x", at(T, -1)));
  });
  expect(parkedCards(boot(store))).toHaveLength(0);
});

test("a failing backfill never blocks boot, and isn't retried", () => {
  const store = seeded((s) => {
    s.putJob(triage("job_a", T, PARKED));
    s.putItem(item("it_a", at(T, -1)));
  });
  const real = store.jobsOfKind.bind(store);
  store.jobsOfKind = () => { throw new Error("boom"); };
  const hub = boot(store);
  expect(parkedCards(hub)).toHaveLength(0);
  expect(store.kv("parkedBackfill")).toBeTruthy();
  expect(hub.store.journal().some((j) => j.text.includes("failed: boom"))).toBe(true);
  store.jobsOfKind = real;
  expect(parkedCards(boot(store))).toHaveLength(0);
});

test("one bad job doesn't cost the others their cards, and the journal names it", () => {
  const T2 = "2026-11-06T13:14:55.373Z";
  const store = seeded((s) => {
    s.putJob(triage("job_a", T, PARKED));
    s.putItem(item("it_a", at(T, -1)));
    s.putJob(triage("job_b", T2, "Logged a task. Not dispatched; say the word."));
    s.putItem(item("it_b", at(T2, -1)));
  });
  const real = store.lastAnswered.bind(store);
  store.lastAnswered = (k: string) => { if (k === "parked:it_a") throw new Error("boom"); return real(k); };
  const hub = boot(store);
  expect(parkedCards(hub).map((q) => q.key)).toEqual(["parked:it_b"]);
  expect(hub.store.journal().some((j) => j.text.includes("job_a (boom)"))).toBe(true);
});

test("skips done/dropped items, items an agent ran on, ones with a parked card already, review triage, unparked replies and post-2b214e6 triage", () => {
  const T2 = "2026-11-06T13:14:55.373Z", T3 = "2026-11-06T16:18:26.775Z", T4 = "2026-10-13T13:02:58.906Z", T5 = "2026-11-10T10:00:00.000Z", T6 = "2026-11-06T20:00:00.000Z";
  const store = seeded((s) => {
    s.putJob(triage("job_a", T, PARKED));
    s.putItem(item("it_done", at(T, -3), { status: "done" }));
    s.putItem(item("it_drop", at(T, -2), { status: "dropped" }));
    s.putItem(item("it_ok", at(T, -1)));
    s.putItem(item("it_before", at(T, -60_000))); // made a minute before the triage started: not its item
    s.putJob(triage("job_b", T2, "Logged a task. Not dispatched; say the word."));
    s.putItem(item("it_agented", at(T2, -1)));
    s.putJob({ ...triage("job_act", at(T2, 60_000), "done"), kind: "action", name: "work", itemId: "it_agented" });
    s.putJob(triage("job_c", T3, "Logged a task. Not dispatched; say the word and I'll send an agent."));
    s.putItem(item("it_carded", at(T3, -1)));
    s.putQuestion({ id: "q_old", key: "parked:it_carded", kind: "dispatch", itemId: "it_carded", prompt: "x", options: [], status: "answered", createdAt: T3, answeredAt: T3 } as any);
    s.putJob(triage("job_d", T4, "Logged Rui's work. Not dispatched.", "review"));
    s.putItem(item("it_review", at(T4, -1)));
    s.putJob(triage("job_e", T5, "Logged it. Not dispatched; say the word."));
    s.putItem(item("it_post", at(T5, -1)));
    s.putJob(triage("job_f", T6, "Logged it and sent an agent to fix it."));
    s.putItem(item("it_sent", at(T6, -1)));
  });
  const hub = boot(store);
  expect(parkedCards(hub).map((q) => q.key)).toEqual(["parked:it_ok"]);
});
