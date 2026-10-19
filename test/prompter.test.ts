import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { isOwner, Prompter } from "../src/server/prompter.ts";
import { config } from "../src/server/config.ts";
import { type MrInfo, MrStates, parseMrRef } from "../src/server/mr-state.ts";

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

  test("after two 'Push 1 hour' taps today, lead with tomorrow 09:30 and drop the hourly push", async () => {
    const it = hub.createItem({ title: "reply to Sam", kind: "message", status: "scheduled", scheduledFor: new Date(Date.now() - 60_000).toISOString() });
    const due = () => hub.store.questions("open").find((q) => q.itemId === it.id)!;
    const push = async () => {
      p.tick(new Date());
      await hub.answer(due().id, "1h");
      hub.schedule(it.id, new Date(Date.now() - 5 * 60_000).toISOString(), "now"); // the hour is up (new slot, new key)
    };
    await push();
    p.tick(new Date());
    expect(due().options.map((o) => o.id)).toContain("1h"); // one push: still offered
    await hub.answer(due().id, "1h");
    hub.schedule(it.id, new Date(Date.now() - 10 * 60_000).toISOString(), "now");
    p.tick(new Date());
    const q = due();
    expect(q.options.map((o) => o.id)).not.toContain("1h");
    expect(q.options[0]).toMatchObject({ id: "am", tone: "primary", effect: { type: "schedule" } });
    expect(q.options.filter((o) => o.tone === "primary")).toHaveLength(1);
    const at = new Date((q.options[0]!.effect as { at: string }).at);
    expect([at.getHours(), at.getMinutes()]).toEqual([9, 30]);
    expect(at.getDay()).not.toBe(0);
    expect(at.getDay()).not.toBe(6);
    // Other items aren't affected.
    const other = hub.createItem({ title: "other", kind: "message", status: "scheduled", scheduledFor: new Date(Date.now() - 60_000).toISOString() });
    p.tick(new Date());
    expect(hub.store.questions("open").find((x) => x.itemId === other.id)!.options.map((o) => o.id)).toContain("1h");
  });

  test("yesterday's pushes don't count", () => {
    const it = hub.createItem({ title: "reply to Sam", kind: "message", status: "scheduled", scheduledFor: new Date(Date.now() - 60_000).toISOString() });
    const old = new Date(Date.now() - 86_400_000);
    old.setHours(12);
    for (const n of [1, 2, 3]) {
      hub.store.putQuestion({ id: `q${n}`, kind: "when", itemId: it.id, key: `due:${it.id}:old${n}`, prompt: "x", options: [], priority: 90,
        status: "answered", answer: "Push 1 hour", createdAt: old.toISOString(), answeredAt: old.toISOString() });
    }
    p.tick(new Date());
    expect(hub.store.questions("open").find((q) => q.itemId === it.id)!.options.map((o) => o.id)).toContain("1h");
  });

  test("next work morning skips the weekend", async () => {
    const { dueOptions, nextWorkMorning } = await import("../src/server/prompter.ts");
    expect(nextWorkMorning(new Date(2026, 8, 25, 16)).getDay()).toBe(1); // Fri → Mon
    expect(nextWorkMorning(new Date(2026, 8, 23, 16)).getDate()).toBe(24); // Wed → Thu
    expect(dueOptions(undefined, 2, new Date(2026, 8, 25, 16))[0]!.label).toBe("Mon 09:30");
    expect(dueOptions(undefined, 2, new Date(2026, 8, 23, 16))[0]!.label).toBe("Tomorrow 09:30");
    expect(dueOptions(undefined, 1, new Date(2026, 8, 23, 16)).map((o) => o.id)).toEqual(["doing", "done", "1h", "when"]);
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

  test("meeting prep 15 minutes before a small meeting: card only, no desktop ping", () => {
    const seen: string[] = [];
    hub.subscribe((e) => e.type === "notify" && seen.push(e.data.body));
    hub.setEvents([{ id: "e1", title: "1-1 Sam", start: at(10, 15).toISOString(), end: at(10, 45).toISOString(), attendees: ["Sam", "Alex"], oneOnOne: true }]);
    p.tick(at(10));
    expect(hub.store.questions("open").some((q) => q.kind === "prep")).toBe(true);
    expect(seen.some((b) => b.startsWith("1-1 Sam"))).toBe(false);
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

describe("state cards check the item's MR first", () => {
  const MR = "https://gitlab.example.com/me/agent-relay-mcp/-/merge_requests/1";
  const MR2 = "https://gitlab.example.com/me/agent-relay-mcp/-/merge_requests/2#note_9";
  const stub = (states: Record<string, MrInfo>) => {
    const calls: string[] = [];
    const mrs = new MrStates(async (r) => (calls.push(r.url), states[r.url] ?? { state: "unknown" }));
    return { mrs, calls, p: new Prompter(hub, mrs) };
  };
  const merged: MrInfo = { state: "merged", mergedAt: "2026-10-14T08:49:37Z" };

  test("state-unknown item with a merged MR: 'Done (merged MM-DD)' is the primary option", async () => {
    const { mrs, p } = stub({ [MR]: merged });
    const it = hub.createItem({ title: "events MR", status: "proposed", links: [MR], signals: { stateUnknown: true } });
    p.tick(at(15));
    expect(hub.store.questions("open").filter((q) => q.itemId === it.id)).toHaveLength(0); // held until glab replies
    await mrs.settled();
    p.tick(at(15, 1));
    const q = hub.store.questions("open").find((q) => q.key === `state:${it.id}`)!;
    expect(q.options[0]).toMatchObject({ label: "Done (merged 10-14)", tone: "primary", effect: { type: "status", status: "done" } });
    expect(q.options.filter((o) => o.tone === "primary")).toHaveLength(1);
    expect(q.context).toContain("agent-relay-mcp!1 merged 10-14");
    await hub.answer(q.id, "done");
    expect(hub.store.item(it.id)!.status).toBe("done");
  });

  test("long-waiting item with a merged MR leads with Done, not 'Chase them'", async () => {
    const { mrs, p } = stub({ [MR]: merged });
    const it = hub.createItem({ title: "waiting on review", status: "waiting", links: [MR] });
    const later = new Date(Date.now() + 4 * 86_400_000);
    p.tick(later);
    await mrs.settled();
    p.tick(later);
    const q = hub.store.questions("open").find((q) => q.key === `wait:${it.id}`)!;
    expect(q.badge).toBe("MR merged");
    expect(q.options[0]).toMatchObject({ label: "Done (merged 10-14)", tone: "primary" });
    expect(q.options.find((o) => o.id === "chase")!.tone).toBe("quiet");
  });

  test("an open MR (or one of two still open) keeps the usual card", async () => {
    const { mrs, p } = stub({ [MR]: merged, [MR2.split("#")[0]!]: { state: "opened" } });
    const it = hub.createItem({ title: "two MRs", status: "proposed", links: [MR, MR2], signals: { stateUnknown: true } });
    p.tick(at(15));
    await mrs.settled();
    p.tick(at(15, 1));
    const q = hub.store.questions("open").find((q) => q.key === `state:${it.id}`)!;
    expect(q.options[0]!.label).toBe("Done");
    expect(q.context).toStartWith("Memory doesn't know");
  });

  test("glab failing falls back to the usual card; non-MR items never call glab", async () => {
    const { mrs, p, calls } = stub({});
    const a = hub.createItem({ title: "MR, glab down", status: "proposed", links: [MR], signals: { stateUnknown: true } });
    const b = hub.createItem({ title: "no MR", status: "proposed", links: ["https://jira.example.com/browse/X-1"], signals: { stateUnknown: true } });
    p.tick(at(15));
    expect(hub.store.questions("open").some((q) => q.itemId === b.id)).toBe(true); // asked straight away
    await mrs.settled();
    p.tick(at(15, 1));
    expect(hub.store.questions("open").find((q) => q.itemId === a.id)!.options[0]!.label).toBe("Done");
    expect(calls).toEqual([MR]);
  });

  test("one lookup per MR, not one per tick", async () => {
    const { mrs, p, calls } = stub({ [MR]: merged });
    hub.createItem({ title: "x", status: "proposed", links: [MR, `${MR}#note_1`], signals: { stateUnknown: true } });
    for (let i = 0; i < 5; i++) p.tick(at(15, i));
    await mrs.settled();
    for (let i = 5; i < 10; i++) p.tick(at(15, i));
    expect(calls).toHaveLength(1);
  });
});

test("parseMrRef reads MR URLs and ignores everything else", () => {
  expect(parseMrRef("https://gitlab.example.com/a/b/c/-/merge_requests/12#note_3")).toEqual({
    url: "https://gitlab.example.com/a/b/c/-/merge_requests/12",
    host: "gitlab.example.com",
    project: "a/b/c",
    iid: 12,
  });
  expect(parseMrRef("https://gitlab.example.com/a/b/-/merge_requests/12/diffs")).toBeUndefined();
  expect(parseMrRef("https://jira.example.com/browse/X-1")).toBeUndefined();
  expect(parseMrRef("not a url")).toBeUndefined();
});

describe("reflection proposals", () => {
  // Memory sync writes a file's proposals top to bottom, so `updated` creeps up a millisecond at a time in file
  // order (10-19 prod: #1-#3 at …25.816Z, #4-#9 at …25.817Z) and store.items()' ORDER BY updated DESC reverses them.
  // createdAt carries the file order.
  let tick = 0;
  const proposal = (title: string, label: string, createdAt: string) => {
    const it = hub.createItem({ title, kind: "idea", status: "proposed", source: { type: "memory", label, key: `memory:proposals:${title}` } });
    hub.store.putItem({ ...it, createdAt, updatedAt: new Date(Date.parse("2026-10-19T15:22:25.816Z") + tick++).toISOString() });
    return it;
  };

  test("same-day proposals are asked in file order, not last-synced first", () => {
    const a = proposal("a", "Proposals 2026-10-18 · High Priority (High Value, Low Effort)", "2026-10-18T00:41:37.565Z");
    const b = proposal("b", "Proposals 2026-10-18 · High Priority (High Value, Low Effort)", "2026-10-18T00:41:37.569Z");
    const c = proposal("c", "Proposals 2026-10-18 · High Priority (High Value, Low Effort)", "2026-10-18T00:41:37.573Z");
    p.tick(at(15));
    const ids = hub.store.questions("open").filter((q) => q.key.startsWith("proposal:")).map((q) => q.itemId);
    expect(ids.sort()).toEqual([a.id, b.id].sort()); // CAP.proposal = 2: the first two, not the last two
    expect(ids).not.toContain(c.id);
  });

  test("High Priority beats an older Medium row within a day; a newer reflection beats an older one", () => {
    proposal("old", "Proposals 2026-10-17 · High Priority (High Value, Low Effort)", "2026-10-17T00:00:00.000Z");
    proposal("med", "Proposals 2026-10-18 · Medium Priority", "2026-10-16T23:00:30.687Z"); // re-proposed, row from 10-16
    const h1 = proposal("h1", "Proposals 2026-10-18 · High Priority (High Value, Low Effort)", "2026-10-18T00:41:37.565Z");
    const h2 = proposal("h2", "Proposals 2026-10-18 · High Priority (High Value, Low Effort)", "2026-10-18T00:41:37.569Z");
    p.tick(at(15));
    const ids = hub.store.questions("open").filter((q) => q.key.startsWith("proposal:")).map((q) => q.itemId);
    expect(ids.sort()).toEqual([h1.id, h2.id].sort());
  });
});
