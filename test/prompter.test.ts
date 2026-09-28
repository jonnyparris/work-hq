import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { Prompter } from "../src/server/prompter.ts";

let hub: Hub;
let p: Prompter;
beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  p = new Prompter(hub);
});

// Wednesday 2026-09-23, 10:00 local.
const at = (h: number, m = 0) => new Date(2026, 8, 23, h, m);

describe("prompter", () => {
  test("morning plan once per day, only in the morning", () => {
    p.tick(at(10));
    p.tick(at(10, 5));
    expect(hub.store.questions("open").filter((q) => q.kind === "plan")).toHaveLength(1);
    const h2 = new Hub(new Store(":memory:"));
    new Prompter(h2).tick(at(15));
    expect(h2.store.questions("open").filter((q) => q.kind === "plan")).toHaveLength(0);
  });

  test("state-unknown items get asked, capped", () => {
    for (let i = 0; i < 6; i++) hub.createItem({ title: `thing ${i}`, status: "proposed", signals: { stateUnknown: true } });
    p.tick(at(15));
    expect(hub.store.questions("open").filter((q) => q.key.startsWith("state:"))).toHaveLength(3);
  });

  test("answering sets status, records journal, and expires sibling questions", async () => {
    const it = hub.createItem({ title: "close CR", status: "proposed", signals: { stateUnknown: true, killDate: "2026-09-23" } });
    p.tick(at(15));
    const qs = hub.store.questions("open").filter((q) => q.itemId === it.id);
    expect(qs.length).toBe(2); // kill + state
    await hub.answer(qs[0]!.id, "done");
    expect(hub.store.item(it.id)!.status).toBe("done");
    expect(hub.store.item(it.id)!.confirmedAt).toBeTruthy();
    expect(hub.store.questions("open").filter((q) => q.itemId === it.id)).toHaveLength(0);
    expect(hub.store.journal().some((j) => j.text.startsWith("Done: close CR"))).toBe(true);
  });

  test("scheduled item that's due asks 'it's time' and notifies", () => {
    const seen: string[] = [];
    hub.subscribe((e) => e.type === "notify" && seen.push(e.data.body));
    const it = hub.createItem({ title: "reply to Sam", kind: "message", status: "scheduled", scheduledFor: at(9, 30).toISOString() });
    p.tick(at(10));
    const q = hub.store.questions("open").find((q) => q.itemId === it.id)!;
    expect(q.kind).toBe("when");
    expect(q.options[0]!.effect).toEqual({ type: "dispatch", action: "reply" });
    expect(seen).toContain("It's time: reply to Sam");
  });

  test("meeting prep 15 minutes before a small meeting", () => {
    hub.setEvents([{ id: "e1", title: "1-1 Sam", start: at(10, 15).toISOString(), end: at(10, 45).toISOString(), attendees: ["Sam", "Alex"], oneOnOne: true }]);
    p.tick(at(10));
    expect(hub.store.questions("open").some((q) => q.kind === "prep")).toBe(true);
  });

  test("no prep for solo holds", () => {
    hub.setEvents([{ id: "h1", title: "🚫 No interviews", start: at(10, 15).toISOString(), end: at(11).toISOString(), attendees: [] }]);
    p.tick(at(10));
    expect(hub.store.questions("open").some((q) => q.kind === "prep")).toBe(false);
  });

  test("snooze re-asks later with notBefore", async () => {
    p.tick(at(10));
    const plan = hub.store.questions("open").find((q) => q.kind === "plan")!;
    await hub.answer(plan.id, "later");
    const again = hub.store.questions("open").find((q) => q.kind === "plan")!;
    expect(again.id).not.toBe(plan.id);
    expect(Date.parse(again.notBefore!)).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  test("memory re-import doesn't undo a confirmed status", () => {
    const it = hub.createItem({ title: "x", status: "proposed", source: { type: "memory", key: "memory:k" } });
    hub.setStatus(it.id, "done");
    hub.createItem({ title: "x (reworded)", status: "proposed", source: { type: "memory", key: "memory:k" } });
    const after = hub.store.item(it.id)!;
    expect(after.status).toBe("done");
    expect(after.title).toBe("x (reworded)");
  });
});

import { effectFromLabel } from "../src/server/hub.ts";
test("agent option labels map to effects", () => {
  expect(effectFromLabel("Mark done")).toEqual({ type: "status", status: "done" });
  expect(effectFromLabel("Keep open — waiting on PAY-1484")).toEqual({ type: "status", status: "waiting" });
  expect(effectFromLabel("Drop")).toEqual({ type: "status", status: "dropped" });
  expect(effectFromLabel("Keep open — create launch ticket next")).toEqual({ type: "status", status: "proposed" });
  expect(effectFromLabel("Hmm")).toEqual({ type: "noop" });
});

describe("scheduled for… and blog posts", () => {
  test("item questions offer 'Scheduled for…'", () => {
    const it = hub.createItem({ title: "reply to Sam", kind: "message", status: "scheduled", scheduledFor: at(9, 30).toISOString() });
    p.tick(at(10));
    const q = hub.store.questions("open").find((q) => q.itemId === it.id)!;
    expect(q.options.some((o) => o.effect.type === "when")).toBe(true);
  });

  test("'when' hands the words to the dispatcher; no words puts the question back", async () => {
    const calls: Array<[string, string]> = [];
    hub.dispatcher = { dispatch: async () => undefined, scheduleFromWords: async (id, w) => void calls.push([id, w]) };
    const it = hub.createItem({ title: "offsite plan", status: "proposed", signals: { stateUnknown: true } });
    p.tick(at(15));
    const q = hub.store.questions("open").find((q) => q.itemId === it.id)!;
    await hub.answer(q.id, "when");
    expect(calls).toHaveLength(0);
    const again = hub.store.questions("open").find((x) => x.itemId === it.id)!;
    expect(again.key).toBe(q.key);
    await hub.answer(again.id, "when", "booked it for Thursday 2pm");
    expect(calls).toEqual([[it.id, "booked it for Thursday 2pm"]]);
  });

  test("post ideas: drafts come first, ideas get 'Draft it', capped at 2", () => {
    hub.createItem({ title: "idea A", kind: "post", status: "proposed", post: { venue: "wiki" } });
    hub.createItem({ title: "idea B", kind: "post", status: "proposed", post: { venue: "site" } });
    const drafted = hub.createItem({ title: "Work HQ", kind: "post", status: "proposed", post: { venue: "both", wikiDraft: "/tmp/work-hq-test/blog-drafts/2026-09-26-work-hq.md" } });
    p.tick(at(15));
    const posts = hub.store.questions("open").filter((q) => q.kind === "post");
    expect(posts).toHaveLength(2);
    const d = posts.find((q) => q.itemId === drafted.id)!;
    expect(d.badge).toBe("Draft to review");
    expect(d.options[0]!.effect).toMatchObject({ type: "open", keep: true });
    expect(d.options.some((o) => o.effect.type === "dispatch" && o.effect.action === "publish")).toBe(true);
    const idea = posts.find((q) => q.itemId !== drafted.id)!;
    expect(idea.options[0]!.effect).toEqual({ type: "dispatch", action: "draft" });
  });
});

test("an idea question makes way for the draft question once a draft lands", () => {
  const it = hub.createItem({ title: "idea", kind: "post", status: "proposed", post: { venue: "wiki" } });
  p.tick(at(15));
  hub.updateItem(it.id, { post: { venue: "wiki", wikiDraft: "/tmp/x.md" } });
  p.tick(at(15, 1));
  const qs = hub.store.questions("open").filter((q) => q.itemId === it.id);
  expect(qs.map((q) => q.badge)).toEqual(["Draft to review"]);
});
