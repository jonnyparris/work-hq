import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { isOwner, Prompter } from "../src/server/prompter.ts";
import { config } from "../src/server/config.ts";

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

  test("'Push 1 hour' counts from the click, not from when it was asked", async () => {
    const it = hub.createItem({ title: "reply to Sam", kind: "message", status: "scheduled", scheduledFor: new Date(Date.now() - 3 * 3600_000).toISOString() });
    p.tick(new Date(Date.now() - 2 * 3600_000)); // asked two hours ago, ignored since
    const q = hub.store.questions("open").find((q) => q.itemId === it.id)!;
    await hub.answer(q.id, "1h");
    expect(Date.parse(hub.store.item(it.id)!.scheduledFor!)).toBeGreaterThan(Date.now() + 59 * 60_000);
    p.tick(new Date());
    expect(hub.store.questions("open").filter((q) => q.itemId === it.id)).toHaveLength(0);
  });

  test("'Scheduled for…' on a due prompt doesn't re-ask while the time is being parsed", async () => {
    const it = hub.createItem({ title: "reply to Sam", kind: "message", status: "scheduled", scheduledFor: new Date(Date.now() - 60_000).toISOString() });
    p.tick(new Date());
    const q = hub.store.questions("open").find((q) => q.itemId === it.id)!;
    hub.dispatcher = { scheduleFromWords: () => new Promise(() => {}) } as any; // parse still in flight
    await hub.answer(q.id, "when", "friday morning");
    p.tick(new Date());
    expect(hub.store.questions("open").filter((q) => q.itemId === it.id)).toHaveLength(0);
  });

  test("a due prompt for a slot that's since been rescheduled expires", () => {
    const it = hub.createItem({ title: "reply to Sam", kind: "message", status: "scheduled", scheduledFor: new Date(Date.now() - 60_000).toISOString() });
    p.tick(new Date());
    hub.schedule(it.id, new Date(Date.now() + 3600_000).toISOString(), "later");
    p.tick(new Date());
    expect(hub.store.questions("open").filter((q) => q.itemId === it.id)).toHaveLength(0);
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

  test("no prep or wrap-up when you're the only attendee (personal block from your own addresses)", () => {
    const prev = config.owner.aliases;
    config.owner.aliases = ["alex"];
    try {
      const me = ["alex@example.com", "alex.owner@gmail.com"];
      hub.setEvents([
        { id: "m1", title: "Cuf", start: at(10, 15).toISOString(), end: at(11).toISOString(), attendees: me },
        { id: "m2", title: "Cuf shoulder", start: at(9).toISOString(), end: at(9, 45).toISOString(), attendees: me },
      ]);
      p.tick(at(10));
      expect(hub.store.questions("open").some((q) => q.kind === "prep" || q.kind === "review")).toBe(false);
    } finally {
      config.owner.aliases = prev;
    }
  });

  test("no wrap-up for a meeting you never RSVP'd to, unless it's a 1-1", () => {
    hub.setEvents([
      { id: "v1", title: "Vibe check", start: at(9, 15).toISOString(), end: at(9, 45).toISOString(), attendees: ["Sam", "Alex", "Jo"], response: "needsAction" },
      { id: "o1", title: "Jo / Alex", start: at(9, 15).toISOString(), end: at(9, 45).toISOString(), attendees: ["Jo", "Alex"], oneOnOne: true, response: "needsAction" },
    ]);
    p.tick(at(10));
    const reviews = hub.store.questions("open").filter((q) => q.kind === "review");
    expect(reviews.map((q) => q.eventId)).toEqual(["o1"]);
  });

  test("wrap-up after a 1-1 whose invite lists only the other person", () => {
    // Real sweep output since 09-29: { title: "Sam / Alex", attendees: ["sam@example.com"], oneOnOne: true }.
    hub.setEvents([
      { id: "c1", title: "Sam / Alex", start: at(9, 15).toISOString(), end: at(9, 45).toISOString(), attendees: ["sam@example.com"], oneOnOne: true, response: "accepted" },
      { id: "h1", title: "Hold", start: at(9, 15).toISOString(), end: at(9, 45).toISOString(), attendees: ["kim@example.com"], response: "accepted" },
    ]);
    p.tick(at(10));
    const reviews = hub.store.questions("open").filter((q) => q.kind === "review");
    expect(reviews.map((q) => q.eventId)).toEqual(["c1"]);
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

test("isOwner matches emails, dotted names and display names, not lookalikes", () => {
  const a = ["alex"];
  expect(isOwner("alex@example.com", a)).toBe(true);
  expect(isOwner("alex.owner@gmail.com", a)).toBe(true);
  expect(isOwner("Alex Owner", a)).toBe(true);
  expect(isOwner("alexc@example.com", a)).toBe(false);
  expect(isOwner("sam@example.com", a)).toBe(false);
  expect(isOwner("Alex Owner", ["alex owner"])).toBe(true);
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

// Regression: answering the wrap-up used to re-ask it on the next 30s tick (no cooldown on a per-day key).
test("wrap-up asked once per day, not again after it's answered", async () => {
  const [, end] = (await import("../src/server/config.ts")).config.sweeps.workHours;
  const t = (m: number) => new Date(2026, 8, 23, end - 1, m);
  p.tick(t(0));
  const wrap = () => hub.store.questions("open").filter((q) => q.kind === "wrap");
  expect(wrap()).toHaveLength(1);
  await hub.answer(wrap()[0]!.id, "flush");
  p.tick(t(1));
  p.tick(t(30));
  expect(wrap()).toHaveLength(0);
});

test("snoozed wrap-up comes back once, then stays answered", async () => {
  const [, end] = (await import("../src/server/config.ts")).config.sweeps.workHours;
  const t = (m: number) => new Date(2026, 8, 23, end - 1, m);
  p.tick(t(0));
  const wrap = () => hub.store.questions("open").filter((q) => q.kind === "wrap");
  await hub.answer(wrap()[0]!.id, "later");
  p.tick(t(1));
  expect(wrap()).toHaveLength(1); // the snoozed one, not a second copy
  await hub.answer(wrap()[0]!.id, "flush");
  p.tick(t(2));
  expect(wrap()).toHaveLength(0);
});

// Regression: a wrap snoozed on one day kept its old key and sat next to the next day's wrap.
test("yesterday's snoozed wrap-up expires instead of doubling up", async () => {
  const [, end] = (await import("../src/server/config.ts")).config.sweeps.workHours;
  p.tick(new Date(2026, 8, 23, end - 1));
  const wrap = () => hub.store.questions("open").filter((q) => q.kind === "wrap");
  await hub.answer(wrap()[0]!.id, "later");
  p.tick(new Date(2026, 8, 24, end - 1));
  expect(wrap().map((q) => q.key)).toEqual(["wrap:2026-09-24"]);
});

test("morning plan not re-asked after it's answered", async () => {
  p.tick(at(10));
  const plan = () => hub.store.questions("open").filter((q) => q.kind === "plan");
  await hub.answer(plan()[0]!.id, "plan");
  p.tick(at(10, 1));
  expect(plan()).toHaveLength(0);
});

describe("inbox triage while an agent works the item", () => {
  const job = (itemId: string, status: "queued" | "running" | "done") =>
    hub.putJob({ id: `job_${itemId}_${status}`, kind: "verify", name: "verify", title: "verify", surface: "headless", status, itemId, tail: [], createdAt: new Date().toISOString() } as any);

  test("no inbox question for an item with a queued or running job", () => {
    const a = hub.createItem({ title: "check policy", kind: "decision", status: "inbox" });
    const b = hub.createItem({ title: "apply cuts", kind: "decision", status: "inbox" });
    const c = hub.createItem({ title: "finished one", kind: "decision", status: "inbox" });
    job(a.id, "queued");
    job(b.id, "running");
    job(c.id, "done");
    p.tick(at(15));
    const asked = hub.store.questions("open").filter((q) => q.key.startsWith("inbox:")).map((q) => q.itemId);
    expect(asked).not.toContain(a.id);
    expect(asked).not.toContain(b.id);
    expect(asked).toContain(c.id);
  });

  test("answering 'Gather the facts' doesn't re-ask on the next ticks", async () => {
    const it = hub.createItem({ title: "check policy", kind: "decision", status: "inbox" });
    hub.dispatcher = { dispatch: async () => job(it.id, "done") } as any; // agent already finished, item still inbox
    p.tick(at(15));
    const q = hub.store.questions("open").find((q) => q.key === `inbox:${it.id}`)!;
    expect(q.options[0]!.effect).toEqual({ type: "dispatch", action: "verify" });
    await hub.answer(q.id, "go");
    for (let i = 0; i < 4; i++) p.tick(at(15, i));
    expect(hub.store.questions("open").filter((q) => q.key === `inbox:${it.id}`)).toHaveLength(0);
  });
});

describe("meeting-ended cards from earlier days", () => {
  const thu = (h: number, m = 0) => new Date(2026, 8, 24, h, m);
  const ev = (id: string, title: string, h: number, day = 23) => ({
    id, title, start: new Date(2026, 8, day, h).toISOString(), end: new Date(2026, 8, day, h, 30).toISOString(),
    attendees: ["Sam", "Jo", "Alex"], response: "accepted" as const,
  });

  test("fold into one card the next morning, titles listed, typed input kept", () => {
    hub.setEvents([ev("a", "Design sync", 9), ev("b", "Jo / Alex", 14), ev("c", "Ops review", 16)], "2026-09-24");
    p.tick(at(9, 40));
    p.tick(at(14, 40));
    p.tick(at(16, 40));
    expect(hub.store.questions("open").filter((q) => q.kind === "review")).toHaveLength(3);
    p.tick(thu(7));
    const open = hub.store.questions("open").filter((q) => q.kind === "review");
    expect(open).toHaveLength(1);
    const d = open[0]!;
    expect(d.key).toBe("reviews:2026-09-24");
    expect(d.prompt).toBe("Yesterday's meetings (3): anything you committed to?");
    expect(d.context).toBe("- Design sync\n- Jo / Alex\n- Ops review");
    expect(d.options.map((o) => o.id)).toEqual(["scan", "none"]);
    expect(Date.parse(d.notBefore!)).toBe(thu(8).getTime()); // waits for the workday
    // Later ticks don't duplicate it.
    p.tick(thu(10));
    expect(hub.store.questions("open").filter((q) => q.kind === "review")).toHaveLength(1);
  });

  // Regression: the list followed the open-question order (ORDER BY updated, ties within a ms), so it flaked.
  test("folded titles are in meeting order, not card order", async () => {
    hub.setEvents([ev("a", "Design sync", 9), ev("b", "Jo / Alex", 14), ev("c", "Ops review", 16)], "2026-09-24");
    // Cards created out of meeting order (restart / clock skew), each in its own ms.
    p.tick(at(16, 40)); // Ops review
    await Bun.sleep(3);
    p.tick(at(9, 40)); // Design sync
    await Bun.sleep(3);
    p.tick(at(14, 40)); // Jo / Alex, most recently updated
    expect(hub.store.questions("open").filter((q) => q.kind === "review")).toHaveLength(3);
    p.tick(thu(7));
    const open = hub.store.questions("open").filter((q) => q.kind === "review");
    expect(open.map((q) => q.context)).toEqual(["- Design sync\n- Jo / Alex\n- Ops review"]);
  });

  test("today's meeting-ended card is left alone", () => {
    hub.setEvents([ev("t", "Standup", 9, 24)], "2026-09-24");
    p.tick(thu(9, 40));
    p.tick(thu(10));
    const open = hub.store.questions("open").filter((q) => q.kind === "review");
    expect(open.map((q) => q.eventId)).toEqual(["t"]);
  });

  test("a late straggler merges into the open card", () => {
    hub.setEvents([ev("a", "Design sync", 9), ev("z", "Late call", 22)], "2026-09-24");
    p.tick(at(9, 40));
    p.tick(thu(7)); // folds Design sync
    p.tick(at(22, 40)); // clock skew / restart: Late call card appears with yesterday's date…
    p.tick(thu(8)); // …and merges
    const open = hub.store.questions("open").filter((q) => q.kind === "review");
    expect(open).toHaveLength(1);
    expect(open[0]!.prompt).toBe("Yesterday's meetings (2): anything you committed to?");
  });

  test("reviewUtterance carries the meeting list for a folded card only", async () => {
    const { reviewUtterance } = await import("../src/server/prompter.ts");
    expect(reviewUtterance({ prompt: "X just ended.", key: "review:e1", context: "Type it" }, "will do Y")).toBe("X just ended.\nwill do Y");
    expect(reviewUtterance({ prompt: "Yesterday's meetings (1): …", key: "reviews:2026-09-24", context: "- X" }, "will do Y")).toBe(
      "Yesterday's meetings (1): …\n- X\nwill do Y",
    );
  });
});
