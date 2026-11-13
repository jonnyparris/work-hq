// "When <ref> lands → run the next step" (it_mwcrrhk61tjym). 11-06..11-10: four sessions where the owner had to ask
// "X merged, so is Y ready now?". An agent arms the step in its report; the prompter raises one dispatch card with
// the stored prompt once every ref has landed.
import { resolve } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { JiraStates } from "../src/server/jira-state.ts";
import { type MrInfo, MrStates } from "../src/server/mr-state.ts";
import { parseNextStep } from "../src/server/next-step.ts";
import { type PrInfo, PrStates } from "../src/server/pr-state.ts";
import { Prompter } from "../src/server/prompter.ts";
import type { ActionKind, Question } from "../src/shared/types.ts";

const MR = (n: number) => `https://gitlab.example.com/team/api-worker/-/merge_requests/${n}`;
const PR = (n: number) => `https://github.com/acme/dodo/pull/${n}`;
let mrs: Record<string, MrInfo>;
let prs: Record<string, PrInfo>;
let hub: Hub;
let p: Prompter;
let gl: MrStates;
let gh: PrStates;
let dispatched: Array<{ itemId: string; action: ActionKind; note?: string }>;

beforeEach(() => {
  mrs = { [MR(12)]: { state: "opened" } };
  prs = {};
  hub = new Hub(new Store(":memory:"));
  dispatched = [];
  hub.dispatcher = {
    dispatch: async (itemId: string, action: ActionKind, note?: string) => {
      dispatched.push({ itemId, action, note });
    },
  } as unknown as Hub["dispatcher"];
  gl = new MrStates(async (r) => mrs[r.url] ?? { state: "unknown" });
  gh = new PrStates(async (r) => prs[r.url] ?? { state: "unknown" });
  p = new Prompter(hub, gl, new JiraStates(async () => ({ state: "unknown" }), new Set()), gh);
});

/** Tick, let lookups land, tick again; forget the cache first so a flipped stub is read. */
const run = async () => {
  gl.forget(hub.store.items().map((it) => ({ ...it, links: it.next?.refs ?? [] })));
  gh.forget(hub.store.items().map((it) => ({ ...it, links: it.next?.refs ?? [] })));
  p.tick(new Date());
  await Promise.all([gl.settled(), gh.settled()]);
  p.tick(new Date());
};
const nextCards = () => hub.store.questions("open").filter((q) => q.key.startsWith("next:"));
const job = (itemId: string, status: "running" | "done" = "done") =>
  hub.store.putJob({ id: "job_train", kind: "action", name: "work", title: "Work · train", surface: "cmux", status, itemId, tail: [], createdAt: new Date().toISOString() });
const arm = (itemId: string, next: unknown) => hub.ingestReport({ jobId: "job_train", updates: [{ id: itemId, status: "waiting", next } as never] });

test("a waiting item on an MR that flips to merged and landed gets one dispatch card with the stored prompt", async () => {
  const it = hub.createItem({ title: "Flip WORKERS_AI_VIA_BINDING", status: "doing", links: [MR(12)] });
  job(it.id);
  const res = arm(it.id, { ref: MR(12), prompt: "Flip WORKERS_AI_VIA_BINDING in prod and watch the error rate for 30 min." });
  expect(res.warnings).toBeUndefined();
  expect(hub.store.item(it.id)!.next).toMatchObject({ refs: [MR(12)], by: "job_train" });
  expect(hub.store.item(it.id)!.status).toBe("waiting");

  await run();
  expect(nextCards()).toHaveLength(0); // still open

  mrs[MR(12)] = { state: "merged", mergedAt: new Date().toISOString() }; // merge commit SHA path: landed
  await run();
  const cards = nextCards();
  expect(cards).toHaveLength(1);
  const q = cards[0]!;
  expect(q.itemId).toBe(it.id);
  expect(q.kind).toBe("dispatch");
  expect(q.prompt).toMatch(/^api-worker!12 merged \d\d-\d\d\. Next: Flip WORKERS_AI_VIA_BINDING in prod/);
  const go = q.options.find((o) => o.id === "go")!;
  expect(go.effect).toMatchObject({ type: "dispatch", action: "work" });
  expect((go.effect as { note: string }).note).toContain("Flip WORKERS_AI_VIA_BINDING in prod and watch the error rate for 30 min.");
  expect(hub.store.item(it.id)!.next!.firedAt).toBeTruthy();
  // The merged "mark done?" card doesn't also ask: the step is what comes next.
  expect(hub.store.questions("open").some((x) => x.key === "wait:merged")).toBe(false);

  // Tapping go dispatches with the stored prompt; the step never asks again.
  await hub.answer(q.id, "go");
  expect(dispatched).toEqual([{ itemId: it.id, action: "work", note: expect.stringContaining("Flip WORKERS_AI_VIA_BINDING in prod") }]);
  await run();
  await run();
  expect(nextCards()).toHaveLength(0);
});

test("without a next step the same item does get the merged card (the skip above is real)", async () => {
  const it = hub.createItem({ title: "Plain", status: "waiting", links: [MR(12)] });
  mrs[MR(12)] = { state: "merged", mergedAt: new Date().toISOString() };
  gl.forget([it]);
  await run();
  expect(hub.store.questions("open").find((x) => x.key === "wait:merged")?.itemId).toBe(it.id);
});

test("waits for every ref, and for the agent that set it to finish", async () => {
  const it = hub.createItem({ title: "Train", status: "waiting" });
  job(it.id, "running");
  arm(it.id, { refs: [MR(12), PR(7)], prompt: "Mark !13 ready." });
  mrs[MR(12)] = { state: "merged", mergedAt: new Date().toISOString() };
  prs[PR(7)] = { state: "open" };
  await run();
  expect(nextCards()).toHaveLength(0);
  prs[PR(7)] = { state: "merged", mergedAt: new Date().toISOString() };
  await run();
  expect(nextCards()).toHaveLength(0); // agent still running
  job(it.id, "done");
  await run();
  expect(nextCards()).toHaveLength(1);
});

test("merged but not landed, or a failed lookup, never fires", async () => {
  const a = hub.createItem({ title: "A", status: "waiting" });
  const b = hub.createItem({ title: "B", status: "waiting" });
  arm(a.id, { ref: MR(12), prompt: "next A" });
  arm(b.id, { ref: MR(99), prompt: "next B" }); // stub: unknown
  mrs[MR(12)] = { state: "merged-not-landed", mergedAt: new Date().toISOString(), landing: "0 of 1 commits on main" };
  await run();
  expect(nextCards()).toHaveLength(0);
  expect(hub.store.item(a.id)!.next!.firedAt).toBeUndefined();
  expect(hub.store.item(b.id)!.next!.firedAt).toBeUndefined();
});

test("a ref closed without merging spends the step, and the merged card is no longer held back", async () => {
  const it = hub.createItem({ title: "D", status: "waiting", links: [MR(12)] });
  arm(it.id, { ref: MR(13), prompt: "after 13" });
  mrs[MR(12)] = { state: "merged", mergedAt: new Date().toISOString() };
  mrs[MR(13)] = { state: "opened" };
  await run();
  expect(hub.store.questions("open").some((x) => x.key === "wait:merged")).toBe(false); // armed: held
  mrs[MR(13)] = { state: "closed" };
  await run();
  const next = hub.store.item(it.id)!.next!;
  expect(next.closed).toBe(MR(13));
  expect(next.firedAt).toBeTruthy();
  expect(nextCards()).toHaveLength(0);
  // Held back, its own MR was never looked up: the next tick starts that lookup, the one after asks.
  await run();
  expect(hub.store.questions("open").find((x) => x.key === "wait:merged")?.itemId).toBe(it.id);
  expect(hub.store.journal(20).some((j) => j.text.startsWith("Next step won't run"))).toBe(true);
});

test("recheck: forgets the step's refs, and leaves the armed item off its 'which are done?' card", async () => {
  const it = hub.createItem({ title: "E", status: "doing", links: [MR(12)] });
  arm(it.id, { ref: MR(13), prompt: "after 13" });
  mrs[MR(12)] = { state: "merged", mergedAt: new Date().toISOString() };
  mrs[MR(13)] = { state: "opened" };
  p.tick(new Date());
  await gl.settled(); // MR(13) cached as opened (30-min TTL)
  mrs[MR(13)] = { state: "merged", mergedAt: new Date().toISOString() };
  const r = await p.recheck();
  expect(r.landed.map((x) => x.id)).not.toContain(it.id);
  p.tick(new Date()); // no manual forget: the recheck refreshed MR(13)
  expect(nextCards()).toHaveLength(1);
});

test("limits: more than 5 refs, an over-long prompt, a non-http ref, a closed item", () => {
  const it = hub.createItem({ title: "F", status: "waiting" });
  expect(arm(it.id, { refs: [1, 2, 3, 4, 5, 6].map(MR), prompt: "p" }).warnings?.[0]).toMatch(/at most 5 refs/);
  expect(arm(it.id, { ref: MR(1), prompt: "x".repeat(4001) }).warnings?.[0]).toMatch(/over 4000/);
  expect(arm(it.id, { ref: "javascript://x/%0a/-/merge_requests/1", prompt: "p" }).warnings?.[0]).toMatch(/not an MR/);
  const res = hub.ingestReport({ jobId: "job_train", updates: [{ id: it.id, status: "done", next: { ref: MR(1), prompt: "p" } }] });
  expect(res.warnings?.[0]).toMatch(/item is done/);
  expect(hub.store.item(it.id)!.next).toBeUndefined();
  expect(parseNextStep({ ref: MR(1), prompt: "p", action: ["ticket"] }, undefined)).toEqual({ error: expect.stringContaining("unknown action") });
  expect(parseNextStep({ ref: MR(1), prompt: "p", action: "toString" }, undefined)).toEqual({ error: expect.stringContaining("unknown action") });

  // An armed step on an item a later report closes, with a replacement refused: the old step goes too.
  const g = hub.createItem({ title: "G", status: "waiting" });
  arm(g.id, { ref: MR(1), prompt: "old" });
  hub.ingestReport({ jobId: "job_train", updates: [{ id: g.id, status: "dropped", next: { ref: MR(2), prompt: "new" } }] });
  expect(hub.store.item(g.id)!.next).toBeNull();
});

test("whq report prints a refused next step as 'Not applied:'", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ created: [], warnings: ["it_x: next needs a prompt (not set)"] }) });
  try {
    const proc = Bun.spawn([resolve(import.meta.dir, "../bin/whq"), "report", "job_x"], {
      stdin: new Blob(['{"updates":[{"id":"it_x","next":{"ref":"x"}}]}']),
      env: { ...process.env, WORK_HQ_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("Not applied: it_x: next needs a prompt (not set)");
  } finally {
    server.stop(true);
  }
}, 30_000);

test("bad refs and empty prompts are refused with a warning; null clears; a new step gets its own card", async () => {
  const it = hub.createItem({ title: "C", status: "waiting" });
  const bad = arm(it.id, { ref: "https://example.com/not-an-mr", prompt: "x" });
  expect(bad.warnings?.[0]).toMatch(/not an MR, GitHub PR or JIRA link/);
  expect(arm(it.id, { ref: MR(12) }).warnings?.[0]).toMatch(/needs a prompt/);
  expect(arm(it.id, { ref: MR(12), prompt: "p", action: "deploy" }).warnings?.[0]).toMatch(/unknown action/);
  expect(hub.store.item(it.id)!.next).toBeUndefined();

  arm(it.id, { ref: MR(12), prompt: "first" });
  arm(it.id, null);
  expect(hub.store.item(it.id)!.next).toBeNull();
  mrs[MR(12)] = { state: "merged", mergedAt: new Date().toISOString() };
  await run();
  expect(nextCards()).toHaveLength(0);

  arm(it.id, { ref: MR(12), prompt: "second", action: "verify" });
  await run();
  const q = nextCards()[0] as Question;
  expect(q.options.find((o) => o.id === "go")!.effect).toMatchObject({ type: "dispatch", action: "verify" });
});

test("parseNextStep dedupes refs and keeps action only when not work", () => {
  const n = parseNextStep({ refs: [MR(1), MR(1)], ref: PR(2), prompt: " go " }, "job_1", new Date("2026-11-12T10:00:00Z"), new Set());
  expect(n).toEqual({ refs: [MR(1), PR(2)], prompt: "go", setAt: "2026-11-12T10:00:00.000Z", by: "job_1" });
  expect(parseNextStep("nope", undefined)).toEqual({ error: expect.stringContaining("must be an object") });
});
