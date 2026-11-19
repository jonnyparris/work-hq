import { expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { config } from "../src/server/config.ts";
import { DRAFT_BADGE, Hub } from "../src/server/hub.ts";
import { REPORT_CONTRACT, REPORT_HELP } from "../src/server/prompts.ts";
import type { Job } from "../src/shared/types.ts";

function setup(over: Partial<Job> = {}) {
  const hub = new Hub(new Store(":memory:"));
  const it = hub.createItem({ title: "Send the Kitesurf Eng Sync summary", kind: "task", status: "doing", source: { type: "transcript" } });
  const job: Job = { id: "job_d", kind: "action", name: "work", title: "Work · X", surface: "cmux", status: "running", itemId: it.id, tail: [], createdAt: new Date().toISOString(), ...over };
  hub.store.putJob(job);
  return { hub, job, it };
}
const cards = (hub: Hub) => hub.store.questions("open").filter((q) => q.badge === DRAFT_BADGE);
const DRAFT = "16/11 check-in notes\n- The repo is public @Sam\n- Cut the PR backlog by Friday @Alex";

test("updates[].draft raises one card with the full text, keeps it as an agent note and journals it", () => {
  const { hub, job, it } = setup();
  hub.ingestReport({ jobId: job.id, summary: "Drafted", updates: [{ id: it.id, status: "waiting", draft: DRAFT }] });
  const [c, ...rest] = cards(hub);
  expect(rest).toHaveLength(0);
  expect(c?.itemId).toBe(it.id);
  expect(c?.context).toBe(DRAFT);
  expect(c?.options.map((o) => o.effect)).toContainEqual({ type: "status", status: "done" });
  // The agent a typed "change X" dispatches reads the item's notes: the draft has to be there.
  expect(hub.store.item(it.id)?.notes?.at(-1)).toMatchObject({ text: DRAFT, who: "agent" });
  expect(hub.store.journal().some((j) => j.text.startsWith("Draft ready:") && j.text.includes("Cut the PR backlog"))).toBe(true);
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: DRAFT }] });
  expect(cards(hub)).toHaveLength(1);
});

test("11-18 shape: the job's own item parked waiting with a 'Draft ready…' note gets a card", () => {
  const { hub, job, it } = setup();
  const note = `Draft ready for ${config.owner.name} to paste into space AAQ:\n\n${DRAFT}`;
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, status: "waiting", note }] });
  expect(cards(hub).map((c) => c.context)).toEqual([note]);
  expect(hub.store.journal().filter((j) => j.text.startsWith("Draft ready:"))).toHaveLength(0); // the note line already has it
});

test("no card: ordinary waiting notes, an armed next step's handover, the agent's own question, a sweep", () => {
  for (const note of ["sent to Rui, waiting for a reply", "draft MR open, waiting on CI", "waiting on draft review", "draft ready for Rui to review"]) {
    const a = setup();
    a.hub.ingestReport({ jobId: a.job.id, updates: [{ id: a.it.id, status: "waiting", note }] });
    expect(cards(a.hub)).toHaveLength(0);
  }
  const b = setup();
  b.hub.ingestReport({ jobId: b.job.id, updates: [{ id: b.it.id, status: "waiting", note: "draft ready", next: { refs: ["https://gitlab.example.com/a/b/-/merge_requests/1"], prompt: "land it" } }] });
  expect(cards(b.hub)).toHaveLength(0);

  const c = setup();
  c.hub.ingestReport({ jobId: c.job.id, updates: [{ id: c.it.id, status: "waiting", draft: DRAFT }], questions: [{ prompt: "Post this?", context: DRAFT, options: ["Yes", "No"] }] });
  expect(cards(c.hub)).toHaveLength(0);
  expect(c.hub.store.questions("open").some((q) => q.prompt === "Post this?")).toBe(true);

  const d = setup({ kind: "sweep" });
  d.hub.ingestReport({ jobId: d.job.id, updates: [{ id: d.it.id, status: "waiting", note: `draft ready for ${config.owner.name}` }] });
  expect(cards(d.hub)).toHaveLength(0);

  // The agent's question still open from an earlier report also counts.
  const e = setup();
  const q = { prompt: "Post this?", context: DRAFT, key: "agent:post", options: ["Yes", "No"] };
  e.hub.ingestReport({ jobId: e.job.id, questions: [q] });
  e.hub.ingestReport({ jobId: e.job.id, updates: [{ id: e.it.id, status: "waiting", draft: DRAFT }], questions: [q] });
  expect(cards(e.hub)).toHaveLength(0);
  expect(e.hub.store.item(e.it.id)?.notes?.at(-1)?.text).toBe(DRAFT); // kept for a "change X" dispatch all the same
});

test("an explicit draft works from any report, with or without a job", () => {
  const { hub, it } = setup();
  hub.ingestReport({ updates: [{ id: it.id, draft: DRAFT }] });
  expect(cards(hub)).toHaveLength(1);
});

test("a question the report asks but ask() doesn't raise (already answered once) doesn't hide the draft", async () => {
  const { hub, job, it } = setup();
  const q = { prompt: "Post this?", key: "agent:post", once: true, options: ["Yes", "No"] };
  hub.ingestReport({ jobId: job.id, questions: [q] });
  const open = hub.store.questions("open").find((x) => x.key === "agent:post")!;
  await hub.answer(open.id, "o1");
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, status: "waiting", draft: DRAFT }], questions: [q] });
  expect(cards(hub)).toHaveLength(1);
});

test("a revised draft replaces the open card; an answered draft isn't re-asked", async () => {
  const { hub, job, it } = setup();
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, status: "waiting", draft: DRAFT }] });
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: `${DRAFT}\n- one more` }] });
  expect(cards(hub).map((c) => c.context)).toEqual([`${DRAFT}\n- one more`]);
  await hub.answer(cards(hub)[0]!.id, "keep");
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: `${DRAFT}\n- one more` }] });
  expect(cards(hub)).toHaveLength(0);
  // Going back to a text whose card was only replaced (not answered) asks again, and closes the stale one.
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: "v3" }] });
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: DRAFT }] });
  expect(cards(hub).map((c) => c.context)).toEqual([DRAFT]);
  // One draft note per item, however many revisions.
  expect(hub.store.item(it.id)?.notes?.filter((n) => n.draft).map((n) => n.text)).toEqual([DRAFT]);
});

test("closed item: no card; armed next step: no Done or Drop button; a non-string draft doesn't break the report", () => {
  const a = setup();
  a.hub.ingestReport({ jobId: a.job.id, updates: [{ id: a.it.id, status: "done", draft: DRAFT }] });
  expect(cards(a.hub)).toHaveLength(0);

  const b = setup();
  b.hub.ingestReport({ jobId: b.job.id, updates: [{ id: b.it.id, status: "waiting", draft: DRAFT, next: { refs: ["https://gitlab.example.com/a/b/-/merge_requests/1"], prompt: "land it" } }] });
  expect(cards(b.hub)[0]?.options.map((o) => o.id)).toEqual(["keep"]);

  const c = setup();
  const bad = { id: c.it.id, status: "waiting", draft: { text: "x" } } as unknown as { id: string };
  expect(() => c.hub.ingestReport({ jobId: c.job.id, updates: [bad], journal: ["after"] })).not.toThrow();
  expect(c.hub.store.journal().some((j) => j.text === "after")).toBe(true);
});

test("agents are told about draft in both contracts", () => {
  expect(REPORT_HELP).toContain('Put the full text in "draft"');
  expect(REPORT_CONTRACT("job_x")).toContain("updates[].draft");
});

test("the agent's own card showing the new draft closes the stale draft card; the journal says no card went up", () => {
  const { hub, job, it } = setup();
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, status: "waiting", draft: "A" }] });
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: "B" }], questions: [{ prompt: "Post B?", context: "B", options: ["Yes", "No"] }] });
  expect(cards(hub)).toHaveLength(0);
  expect(hub.store.item(it.id)?.notes?.filter((n) => n.draft).map((n) => n.text)).toEqual(["B"]);
  const lines = hub.store.journal().map((j) => j.text);
  expect(lines).toContain(`Draft ready: ${it.title} — A`);
  expect(lines).toContain(`Draft: ${it.title} — B`);
});

test("a question that doesn't show the draft, this report's or an older one, doesn't hide it", () => {
  const { hub, job, it } = setup();
  hub.ingestReport({ jobId: job.id, questions: [{ prompt: "Which space?", key: "agent:space", options: ["A", "B"] }] });
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, status: "waiting", draft: DRAFT }], questions: [{ prompt: "Tag Rui?", options: ["Yes", "No"] }] });
  expect(cards(hub).map((c) => c.context)).toEqual([DRAFT]);
});

test("a draft card closed some other way (boss check, item moved) isn't re-asked for the same text", () => {
  const { hub, job, it } = setup();
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, status: "waiting", draft: DRAFT }] });
  hub.expireQuestion(cards(hub)[0]!.id, "no longer applies");
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: DRAFT }] });
  expect(cards(hub)).toHaveLength(0);
});

test("a short draft isn't 'shown' by a context that happens to contain it; a non-string context doesn't throw", () => {
  const { hub, job, it } = setup();
  expect(() => hub.ingestReport({
    jobId: job.id,
    updates: [{ id: it.id, status: "waiting", draft: "ok" }],
    questions: [{ prompt: "Booking?", context: "Is the booking ok?", options: ["Yes"] }, { prompt: "Odd", context: { t: 1 } as unknown as string, options: ["Yes"] }],
    journal: ["after"],
  })).not.toThrow();
  expect(cards(hub).map((c) => c.context)).toEqual(["ok"]);
  expect(hub.store.questions("open").find((q) => q.prompt === "Odd")?.context).toBeUndefined();
  expect(hub.store.journal().some((j) => j.text === "after")).toBe(true);
});

test("a newer draft while the owner's note on the old card is being read closes the old card when the read ends", async () => {
  const { hub, job, it } = setup();
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, status: "waiting", draft: "A" }] });
  const old = cards(hub)[0]!;
  let release!: () => void;
  (hub as unknown as { dispatcher: unknown }).dispatcher = { readNote: () => new Promise((r) => { release = () => r(undefined); }) };
  await hub.note(old.id, "make it shorter");
  expect(hub.isReading(old.id)).toBe(true);
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: "B" }] });
  expect(hub.store.question(old.id)?.status).toBe("open");
  release();
  for (let i = 0; i < 200 && hub.store.question(old.id)?.status === "open"; i++) await Bun.sleep(5);
  expect(hub.store.question(old.id)).toMatchObject({ status: "expired", answer: "newer draft" });
  expect(cards(hub).map((c) => c.context)).toEqual(["B"]);
  // Replaced, not answered: the text can come back.
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: "A" }] });
  expect(cards(hub).map((c) => c.context)).toEqual(["A"]);
});

test("the old text re-reported while its held close waits on a read keeps its card", async () => {
  const { hub, job, it } = setup();
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, status: "waiting", draft: "A" }] });
  const old = cards(hub)[0]!;
  let release!: () => void;
  (hub as unknown as { dispatcher: unknown }).dispatcher = { readNote: () => new Promise((r) => { release = () => r(undefined); }) };
  await hub.note(old.id, "make it shorter");
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: "B" }] });
  hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, draft: "A" }] });
  release();
  for (let i = 0; i < 20; i++) await Bun.sleep(5);
  expect(cards(hub).map((c) => c.id)).toEqual([old.id]);
});

test("a card 'shows' the draft with the same text whitespace aside, or quoting a 40+ char draft", () => {
  const long = "Kitesurf is public: file bugs as issues on the public repo.";
  for (const [draft, context] of [["a  b\n c", "a b c"], [long, `Post this?\n\n${long}`]] as const) {
    const { hub, job, it } = setup();
    hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, status: "waiting", draft }], questions: [{ prompt: "Post?", context, options: ["Yes"] }] });
    expect(cards(hub)).toHaveLength(0);
  }
});

test("the note fallback reads 'for you' and the owner's aliases", () => {
  for (const who of ["you", ...config.owner.aliases]) {
    const { hub, job, it } = setup();
    hub.ingestReport({ jobId: job.id, updates: [{ id: it.id, status: "waiting", note: `Draft for ${who} to post:\n\nhi` }] });
    expect(cards(hub)).toHaveLength(1);
  }
});
