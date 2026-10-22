import { expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { asksForIdeas, IDEA_CAP } from "../src/shared/ideas.ts";
import type { Job } from "../src/shared/types.ts";

function setup(over: Partial<Job> = {}) {
  const hub = new Hub(new Store(":memory:"));
  const job: Job = { id: "job_ic", kind: "action", name: "work", title: "Work · X", surface: "cmux", status: "running", tail: [], createdAt: new Date().toISOString(), ...over };
  hub.store.putJob(job);
  return { hub, job };
}
const TITLES = ["", "Cache the wiki lookups", "Rotate the gateway token weekly", "Graph queue depth per hour", "Merge duplicate meeting cards"];
const idea = (n: number) => ({ title: TITLES[n]!, kind: "idea" as const, source: { type: "agent" as const, key: `idea-${n}` } });
const ideasIn = (hub: Hub) => hub.store.items().filter((i) => i.kind === "idea");

test("an action job files at most IDEA_CAP new ideas; the rest go into its summary", () => {
  const { hub, job } = setup();
  const r = hub.ingestReport({ jobId: job.id, summary: "Did it.", items: [idea(1), idea(2), idea(3), idea(4)] });
  expect(ideasIn(hub)).toHaveLength(IDEA_CAP);
  expect(r.folded).toHaveLength(2);
  const after = hub.store.job(job.id)!;
  expect(after.summary).toContain(`Did it. Could also: ${TITLES[3]}; ${TITLES[4]}`);
  expect(after.ideasFiled).toBe(2);
  expect(after.ideasFolded).toHaveLength(2);
});

test("the cap holds across several reports from one job", () => {
  const { hub, job } = setup();
  hub.ingestReport({ jobId: job.id, status: "progress", items: [idea(1)] });
  hub.ingestReport({ jobId: job.id, summary: "Done", items: [idea(2), idea(3)] });
  expect(ideasIn(hub)).toHaveLength(2);
  expect(hub.store.job(job.id)!.ideasFolded).toEqual([idea(3).title]);
});

test("re-reporting an idea already filed updates it and doesn't count as new", () => {
  const { hub, job } = setup();
  hub.ingestReport({ jobId: job.id, items: [idea(1), idea(2)] });
  const r = hub.ingestReport({ jobId: job.id, items: [{ ...idea(1), detail: "more" }] });
  expect(r.folded).toBeUndefined();
  expect(ideasIn(hub).find((i) => i.source.key === "idea-1")!.detail).toBe("more");
});

test("other kinds, sweeps and jobs whose note asks for ideas aren't capped", () => {
  const a = setup();
  a.hub.ingestReport({ jobId: a.job.id, items: [idea(1), idea(2), { ...idea(3), kind: "followup" }, { ...idea(4), kind: "task" }] });
  expect(a.hub.store.items()).toHaveLength(4);
  const b = setup({ kind: "sweep" });
  b.hub.ingestReport({ jobId: b.job.id, items: [idea(1), idea(2), idea(3)] });
  expect(ideasIn(b.hub)).toHaveLength(3);
  const c = setup({ note: "file ideas for the rollout" });
  c.hub.ingestReport({ jobId: c.job.id, items: [idea(1), idea(2), idea(3)] });
  expect(ideasIn(c.hub)).toHaveLength(3);
});

test("asksForIdeas reads the owner's phrasings, not passing mentions", () => {
  expect(asksForIdeas("file ideas")).toBe(true);
  expect(asksForIdeas("suggest (max) 3 items")).toBe(true);
  expect(asksForIdeas("brainstorm a few angles")).toBe(true);
  expect(asksForIdeas("propose improvements to the flow")).toBe(true);
  expect(asksForIdeas("fix the idea cap bug")).toBe(false);
  expect(asksForIdeas("add the items to today")).toBe(false);
  expect(asksForIdeas(undefined)).toBe(false);
});
