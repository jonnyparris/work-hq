import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { isOwner, Prompter, workMsBetween } from "../src/server/prompter.ts";
import { config } from "../src/server/config.ts";
import { type MrInfo, MrStates, parseMrRef } from "../src/server/mr-state.ts";
import { optionFor } from "../src/shared/batch.ts";
import { type JiraInfo, JiraStates, parseIssue, parseJiraRef } from "../src/server/jira-state.ts";
import { type PrInfo, PrStates, parsePrRef, parsePull } from "../src/server/pr-state.ts";

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

  test("'Chase them' only when there's someone to chase", () => {
    const later = new Date(Date.now() + 4 * 86_400_000);
    const nobody = hub.createItem({ title: "fix the bug", status: "waiting", people: [] });
    const omar = hub.createItem({ title: "Omar's review", status: "waiting", people: ["Omar"] });
    p.tick(later);
    const card = (id: string) => hub.store.questions("open").find((q) => q.key === `wait:${id}`)!;
    const q = card(nobody.id);
    expect(q.options.some((o) => o.id === "chase")).toBe(false);
    expect(q.options.filter((o) => o.tone === "primary")).toMatchObject([{ id: "done", label: "Resolved" }]);
    expect(optionFor(q, "dispatch")).toBeUndefined(); // "Chase all" skips it
    expect(card(omar.id).options[0]).toMatchObject({ id: "chase", tone: "primary", effect: { type: "dispatch", action: "reply" } });
  });

  test("a blank name is nobody to chase", () => {
    const it = hub.createItem({ title: "blank", status: "waiting", people: [" "] });
    p.tick(new Date(Date.now() + 4 * 86_400_000));
    const q = hub.store.questions("open").find((q) => q.key === `wait:${it.id}`)!;
    expect(q.options.some((o) => o.id === "chase")).toBe(false);
  });

  test("followup with nobody named: inbox and due cards send an agent, not a chase", () => {
    const nobody = hub.createItem({ title: "check the fix landed", kind: "followup", status: "inbox" });
    const omar = hub.createItem({ title: "nudge Omar", kind: "followup", status: "inbox", people: ["Omar"] });
    const due = hub.createItem({ title: "follow up on deploy", kind: "followup", status: "scheduled", people: [], scheduledFor: at(9, 30).toISOString() });
    p.tick(at(15));
    const first = (id: string) => hub.store.questions("open").find((q) => q.itemId === id)!.options[0]!;
    expect(first(nobody.id)).toMatchObject({ label: "Send an agent", effect: { type: "dispatch", action: "work" } });
    expect(first(omar.id)).toMatchObject({ label: "Chase them for me", effect: { type: "dispatch", action: "reply" } });
    expect(first(due.id).effect).toEqual({ type: "dispatch", action: "work" });
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

  test("a day with six 1-1s: exactly one prep card in the morning, none before each meeting, no desktop ping", () => {
    const seen: string[] = [];
    hub.subscribe((e) => e.type === "notify" && seen.push(e.data.body));
    const names = ["Sam", "Kevin", "Kuba", "Jo", "Omar", "Lee"];
    hub.setEvents(names.map((n, i) => ({ id: `o${i}`, title: `1-1 ${n}`, start: at(10 + i, 30).toISOString(), end: at(11 + i).toISOString(), attendees: [n], oneOnOne: true })));
    for (let m = 0; m <= 8 * 60; m += 5) p.tick(new Date(at(9, 30).getTime() + m * 60_000));
    const all = hub.store.questions().filter((q) => q.kind === "prep");
    expect(all).toHaveLength(1);
    expect(all[0]!.key).toBe("prep:2026-09-23");
    expect(all[0]!.eventId).toBeUndefined();
    expect(seen.some((b) => /1-1s and small meetings|Want a brief/.test(b))).toBe(false);
  });

  test("the prep card lists today's meetings still to start, follows the calendar, and goes when they've all started", () => {
    hub.setEvents([
      { id: "a", title: "1-1 Kevin", start: at(10, 30).toISOString(), end: at(11).toISOString(), attendees: ["kevin@x.com"], oneOnOne: true },
      { id: "b", title: "Design sync", start: at(11, 30).toISOString(), end: at(12).toISOString(), attendees: ["Sam", "Jo", "Lee"] },
      { id: "big", title: "All hands", start: at(11).toISOString(), end: at(12).toISOString(), attendees: ["a", "b", "c", "d", "e", "f"] },
      { id: "past", title: "1-1 Jo", start: at(9).toISOString(), end: at(9, 30).toISOString(), attendees: ["Jo"], oneOnOne: true },
      { id: "no", title: "1-1 Omar", start: at(11).toISOString(), end: at(11, 30).toISOString(), attendees: ["Omar"], oneOnOne: true, response: "declined" },
    ]);
    p.tick(at(10));
    const q = () => hub.store.questions("open").find((x) => x.kind === "prep");
    expect(q()!.picks!.map((x) => x.id)).toEqual(["a", "b"]);
    expect(q()!.picks![0]).toMatchObject({ label: "10:30 · 1-1 Kevin", hint: "kevin" });
    expect(q()!.prompt).toBe("2 1-1s and small meetings today. Any worth a brief?");
    expect(q()!.context).toContain("- 11:30 · Design sync (Sam, Jo, Lee)");
    p.tick(at(10, 40)); // Kevin's started
    expect(q()!.picks!.map((x) => x.id)).toEqual(["b"]);
    p.tick(at(11, 40)); // nothing left
    expect(q()).toBeUndefined();
    expect(hub.store.questions().filter((x) => x.kind === "prep")).toHaveLength(1);
  });

  test("no prep card in the afternoon, at the weekend, or on a day with no small meetings", () => {
    const ev = { id: "a", title: "1-1 Kevin", start: at(16).toISOString(), end: at(16, 30).toISOString(), attendees: ["Kevin"], oneOnOne: true };
    hub.setEvents([ev]);
    p.tick(at(13));
    expect(hub.store.questions("open").some((q) => q.kind === "prep")).toBe(false);
    const h2 = new Hub(new Store(":memory:"));
    h2.setEvents([{ ...ev, start: new Date(2026, 8, 26, 16).toISOString(), end: new Date(2026, 8, 26, 16, 30).toISOString() }]);
    new Prompter(h2).tick(new Date(2026, 8, 26, 10)); // Saturday
    expect(h2.store.questions("open").some((q) => q.kind === "prep")).toBe(false);
  });

  test("ticking meetings on the prep card sends one prep agent each; a typed note picks by name", async () => {
    const sent: Array<{ id: string; action: string }> = [];
    hub.dispatcher = { dispatch: async (id: string, action: string) => { sent.push({ id, action }); } } as any;
    hub.setEvents([
      { id: "a", title: "1-1 Kevin", start: at(10, 30).toISOString(), end: at(11).toISOString(), attendees: ["Kevin"], oneOnOne: true },
      { id: "b", title: "1-1 Kuba", start: at(11, 30).toISOString(), end: at(12).toISOString(), attendees: ["Kuba"], oneOnOne: true },
      { id: "c", title: "1-1 Sam", start: at(11, 45).toISOString(), end: at(12).toISOString(), attendees: ["Sam"], oneOnOne: true },
    ]);
    p.tick(at(10));
    const q = hub.store.questions("open").find((x) => x.kind === "prep")!;
    await hub.answer(q.id, "prep", undefined, { picks: ["a", "c"] });
    expect(sent.map((s) => s.action)).toEqual(["prep", "prep"]);
    expect(sent.map((s) => hub.store.item(s.id)!.title)).toEqual(["Prep: 1-1 Kevin", "Prep: 1-1 Sam"]);
    expect(hub.store.item(sent[0]!.id)!.source.key).toBe("cal:prep:a");

    const { picksFromNote } = await import("../src/server/hub.ts");
    expect(picksFromNote(q.picks!, "prep kuba and kevin please")).toEqual(["a", "b"]);
    expect(picksFromNote(q.picks!, "all of them")).toEqual(["a", "b", "c"]);
    expect(picksFromNote(q.picks!, "just the sync")).toEqual([]);
    expect(picksFromNote(q.picks!, "not all, just Kuba")).toEqual(["b"]);
    expect(picksFromNote([{ id: "x", label: "10:30 · 1-1", hint: "kevin" }], "prep Kevin")).toEqual(["x"]);
  });

  test("prep card: a stray or stale id dispatches nothing; nothing matched keeps the card open", async () => {
    const sent: string[] = [];
    hub.dispatcher = { dispatch: async (id: string) => { sent.push(id); } } as any;
    hub.setEvents([
      { id: "a", title: "1-1 Kevin", start: at(10, 30).toISOString(), end: at(11).toISOString(), attendees: ["Kevin"], oneOnOne: true },
      { id: "z", title: "Big thing", start: at(11).toISOString(), end: at(12).toISOString(), attendees: ["a", "b", "c", "d", "e", "f"] },
    ]);
    p.tick(at(10));
    // reopen() puts the same card back under a new id.
    const card = () => hub.store.openQuestionByKey("prep:2026-09-23");
    await hub.answer(card()!.id, "prep", undefined, { picks: ["z"] });
    expect(sent).toEqual([]);
    expect(card()).toBeTruthy();
    await hub.answer(card()!.id, "prep", "the design review");
    expect(sent).toEqual([]);
    expect(card()).toBeTruthy();
    await hub.answer(card()!.id, "prep", "kevin");
    expect(sent).toHaveLength(1);
    expect(card()).toBeUndefined();
  });

  test("an open prep card keeps following the calendar after noon and expires once its meetings start", () => {
    hub.setEvents([{ id: "a", title: "1-1 Kevin", start: at(14).toISOString(), end: at(14, 30).toISOString(), attendees: ["Kevin"], oneOnOne: true }]);
    p.tick(at(10));
    expect(hub.store.questions("open").some((q) => q.kind === "prep")).toBe(true);
    p.tick(at(13));
    expect(hub.store.questions("open").some((q) => q.kind === "prep")).toBe(true);
    p.tick(at(14, 5));
    expect(hub.store.questions("open").some((q) => q.kind === "prep")).toBe(false);
  });

  test("yesterday's prep card expires", () => {
    hub.store.putQuestion({ id: "old", kind: "prep", key: "prep:2026-09-22", prompt: "x", options: [], priority: 75, status: "open", createdAt: at(9).toISOString() });
    p.tick(at(15));
    expect(hub.store.question("old")!.status).toBe("expired");
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

  // 10-19: a 1-1 moved to a new series; the old instance's card stayed open beside the real one.
  test("today's card whose event left the calendar expires as 'event removed', not folded", () => {
    hub.setEvents([ev("old", "Jo / Sam", 9, 24), ev("new", "Jo / Sam", 9, 24)], "2026-09-24");
    p.tick(thu(9, 40));
    expect(hub.store.questions("open").filter((q) => q.kind === "review").map((q) => q.eventId).sort()).toEqual(["new", "old"]);
    const old = hub.store.questions("open").find((q) => q.eventId === "old")!;
    hub.store.replaceEvents("2026-09-24", "2026-09-24", [ev("new", "Jo / Sam", 9, 24)]); // next sync drops it
    p.tick(thu(10));
    expect(hub.store.questions("open").filter((q) => q.kind === "review").map((q) => q.eventId)).toEqual(["new"]);
    expect(hub.store.question(old.id)).toMatchObject({ status: "expired", answer: "event removed" });
    // Next morning only the real meeting folds.
    p.tick(new Date(2026, 8, 25, 7));
    const open = hub.store.questions("open").filter((q) => q.kind === "review");
    expect(open.map((q) => q.context)).toEqual(["- Jo / Sam"]);
  });

  test("an earlier day's card whose event is gone still folds", () => {
    hub.setEvents([ev("a", "Design sync", 9)], "2026-09-23");
    p.tick(at(9, 40));
    const q = hub.store.questions("open").find((q) => q.kind === "review")!;
    hub.store.putQuestion({ ...q, createdAt: at(9, 40).toISOString() }); // asked yesterday, in test time
    hub.store.replaceEvents("2026-09-23", "2026-09-23", []);
    p.tick(thu(7));
    expect(hub.store.question(q.id)).toMatchObject({ status: "expired", answer: "day moved on" });
    const open = hub.store.questions("open").filter((q) => q.kind === "review");
    expect(open.map((q) => q.context)).toEqual(["- Design sync"]);
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

  test("long-waiting item with a merged MR, kept waiting on the batch card, leads with Done, not 'Chase them'", async () => {
    const { mrs, p } = stub({ [MR]: merged });
    const it = hub.createItem({ title: "waiting on review", status: "waiting", links: [MR], people: ["Omar"] });
    p.tick(new Date());
    await mrs.settled();
    p.tick(new Date());
    const batch = hub.store.questions("open").find((q) => q.key === "wait:merged")!;
    await hub.answer(batch.id, "keep");
    expect(hub.store.item(it.id)!.status).toBe("waiting");
    const later = new Date(Date.now() + 4 * 86_400_000);
    p.tick(later);
    expect(hub.store.questions("open").some((q) => q.key === "wait:merged")).toBe(false); // kept: not batched again
    const q = hub.store.questions("open").find((q) => q.key === `wait:${it.id}`)!;
    expect(q.badge).toBe("MR merged");
    expect(q.options[0]).toMatchObject({ label: "Done (merged 10-14)", tone: "primary" });
    expect(q.options.find((o) => o.id === "chase")!.tone).toBe("quiet");
  });

  test("long-waiting item with a merged MR and nobody named: Done leads, no chase", async () => {
    const { mrs, p } = stub({ [MR]: merged });
    const it = hub.createItem({ title: "my own fix", status: "waiting", links: [MR], people: [] });
    p.tick(new Date());
    await mrs.settled();
    p.tick(new Date());
    await hub.answer(hub.store.questions("open").find((q) => q.key === "wait:merged")!.id, "keep");
    p.tick(new Date(Date.now() + 4 * 86_400_000));
    const q = hub.store.questions("open").find((q) => q.key === `wait:${it.id}`)!;
    expect(q.options[0]).toMatchObject({ label: "Done (merged 10-14)", tone: "primary" });
    expect(q.options.some((o) => o.id === "chase" || o.label === "Resolved")).toBe(false);
    expect(q.options.filter((o) => o.tone === "primary")).toHaveLength(1);
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

describe("waiting items whose MRs merged: one daily card", () => {
  const mr = (n: number) => `https://gitlab.example.com/me/incident-call-agent/-/merge_requests/${n}`;
  const merged = (d: string): MrInfo => ({ state: "merged", mergedAt: d });
  const states: Record<string, MrInfo> = { [mr(1)]: merged("2026-10-14T10:00:00Z"), [mr(2)]: merged("2026-10-15T10:00:00Z"), [mr(3)]: { state: "opened" } };
  const setup = () => {
    const calls: string[] = [];
    const mrs = new MrStates(async (r) => (calls.push(r.url), states[r.url] ?? { state: "unknown" }));
    return { mrs, calls, p: new Prompter(hub, mrs) };
  };
  const card = () => hub.store.questions("open").find((q) => q.key === "wait:merged");
  const run = async (p: Prompter, mrs: MrStates, now = new Date()) => {
    p.tick(now);
    await mrs.settled();
    p.tick(now);
  };

  test("fresh waiting items with merged MRs go on one card, no 3-day wait; open MRs and MR-less items stay off it", async () => {
    const { mrs, p } = setup();
    const a = hub.createItem({ title: "adapter", status: "waiting", links: [mr(1)] });
    const b = hub.createItem({ title: "dedupe", status: "waiting", links: [mr(2), mr(1)] });
    hub.createItem({ title: "still open", status: "waiting", links: [mr(3)] });
    hub.createItem({ title: "no MR", status: "waiting" });
    hub.createItem({ title: "not waiting", status: "proposed", links: [mr(1)] });
    p.tick(new Date());
    expect(card()).toBeUndefined(); // held until glab answers
    await mrs.settled();
    p.tick(new Date());
    const q = card()!;
    expect(q.prompt).toBe("2 waiting items: their MRs merged. Mark all done?");
    expect(q.badge).toBe("MR merged");
    expect(q.context).toContain("- adapter — incident-call-agent!1 merged 10-14.");
    expect(q.context).toContain("- dedupe — incident-call-agent!2, incident-call-agent!1 all merged 10-15.");
    expect(q.options.map((o) => o.id)).toEqual(["done", "split", "keep"]);
    expect(q.options[0]!.label).toBe("Mark all 2 done");
    expect(hub.store.questions("open").some((x) => x.key === `wait:${a.id}` || x.key === `wait:${b.id}`)).toBe(false);
    await hub.answer(q.id, "done");
    expect(hub.store.item(a.id)!.status).toBe("done");
    expect(hub.store.item(b.id)!.status).toBe("done");
    expect(hub.store.journal().some((j) => j.text === "Done: dedupe — incident-call-agent!2, incident-call-agent!1 all merged 10-15.")).toBe(true);
  });

  test("once a day: answered → no new card for 20 hours, even for a new item", async () => {
    const { mrs, p } = setup();
    hub.createItem({ title: "adapter", status: "waiting", links: [mr(1)] });
    await run(p, mrs);
    await hub.answer(card()!.id, "done");
    hub.createItem({ title: "another", status: "waiting", links: [mr(2)] });
    await run(p, mrs, new Date(Date.now() + 2 * 3600_000));
    expect(card()).toBeUndefined();
    await run(p, mrs, new Date(Date.now() + 21 * 3600_000));
    expect(card()!.prompt).toBe("Waiting on this, but its MRs merged: another");
    expect(card()!.options[0]!.label).toBe("Done (merged 10-15)");
  });

  test("an open card follows items closed on their own, and expires when none are left", async () => {
    const { mrs, p } = setup();
    const a = hub.createItem({ title: "adapter", status: "waiting", links: [mr(1)] });
    const b = hub.createItem({ title: "dedupe", status: "waiting", links: [mr(2)] });
    await run(p, mrs);
    hub.setStatus(a.id, "done");
    p.tick(new Date());
    expect(card()!.context).not.toContain("adapter");
    expect(card()!.options[0]!.label).toBe("Done (merged 10-15)");
    hub.setStatus(b.id, "dropped");
    p.tick(new Date());
    expect(card()).toBeUndefined();
  });

  test("'Mark all done' skips an item closed after the card was drawn", async () => {
    const { mrs, p } = setup();
    const a = hub.createItem({ title: "adapter", status: "waiting", links: [mr(1)] });
    hub.createItem({ title: "dedupe", status: "waiting", links: [mr(2)] });
    await run(p, mrs);
    hub.setStatus(a.id, "dropped");
    await hub.answer(card()!.id, "done");
    expect(hub.store.item(a.id)!.status).toBe("dropped");
  });

  test("'One by one' hands each item to its own card straight away (2 at a time), and never batches them again", async () => {
    const { mrs, p } = setup();
    const ids = [1, 2, 1].map((n, i) => hub.createItem({ title: `item ${i}`, status: "waiting", links: [mr(n)] }).id);
    await run(p, mrs);
    await hub.answer(card()!.id, "split");
    await run(p, mrs, new Date(Date.now() + 21 * 3600_000));
    expect(card()).toBeUndefined();
    const each = hub.store.questions("open").filter((q) => q.key.startsWith("wait:") && q.key !== "wait:merged");
    expect(each).toHaveLength(2);
    expect(each[0]!.options[0]!.label).toMatch(/^Done \(merged 10-1[45]\)$/);
    expect(ids).toContain(each[0]!.itemId!);
  });

  test("bulk 'done' and a typed 'done' both pick 'Mark all done'", async () => {
    const { mrs, p } = setup();
    const a = hub.createItem({ title: "adapter", status: "waiting", links: [mr(1)] });
    hub.createItem({ title: "dedupe", status: "waiting", links: [mr(2)] });
    await run(p, mrs);
    expect(optionFor(card()!, "done")?.id).toBe("done");
    expect(optionFor(card()!, "dismiss")?.id).toBe("keep");
    await hub.note(card()!.id, "done");
    expect(hub.store.item(a.id)!.status).toBe("done");
  });
});

describe("waiting items whose JIRA tickets are done share the merged card", () => {
  const J = (k: string) => `https://jira.example.org/browse/${k}`;
  const MR = "https://gitlab.example.com/me/api-worker/-/merge_requests/17";
  const tickets: Record<string, JiraInfo> = {
    "PAY-1": { state: "done", status: "Done", doneAt: "2026-10-14T10:00:00Z" },
    "PAY-2": { state: "done", status: "Closed", doneAt: "2026-10-15T10:00:00Z" },
    "OPS-3": { state: "open", status: "In Progress" },
    "STALE-1": { state: "unknown" },
  };
  const setup = (mrStates: Record<string, MrInfo> = { [MR]: { state: "merged", mergedAt: "2026-10-13T10:00:00Z" } }) => {
    const calls: string[] = [];
    const mrs = new MrStates(async (r) => mrStates[r.url] ?? { state: "unknown" });
    const jira = new JiraStates(async (r) => (calls.push(r.key), tickets[r.key] ?? { state: "unknown" }), new Set(["jira.example.org"]));
    return { calls, jira, mrs, p: new Prompter(hub, mrs, jira) };
  };
  const card = () => hub.store.questions("open").find((q) => q.key === "wait:merged");
  const run = async (s: ReturnType<typeof setup>, now = new Date()) => {
    s.p.tick(now);
    await Promise.all([s.mrs.settled(), s.jira.settled()]);
    s.p.tick(now);
  };

  test("JIRA-only and MR+JIRA items join MR-only ones; an open, unknown or half-done item stays off", async () => {
    const s = setup();
    const a = hub.createItem({ title: "geo-egress", status: "waiting", links: [J("PAY-1")] });
    const b = hub.createItem({ title: "fix pay-2", status: "waiting", links: [J("PAY-2"), MR], source: { type: "agent", url: `${J("PAY-1")}` } });
    hub.createItem({ title: "open ticket", status: "waiting", links: [J("OPS-3")] });
    hub.createItem({ title: "stale token", status: "waiting", links: [J("STALE-1")] });
    hub.createItem({ title: "merged MR, open ticket", status: "waiting", links: [MR, J("OPS-3")] });
    s.p.tick(new Date());
    expect(card()).toBeUndefined(); // held until JIRA answers
    await Promise.all([s.mrs.settled(), s.jira.settled()]);
    s.p.tick(new Date());
    const q = card()!;
    expect(q.prompt).toBe("2 waiting items: their MRs merged or tickets closed. Mark all done?");
    expect(q.badge).toBe("Merged / done");
    expect(q.context).toBe("- geo-egress — PAY-1 Done 10-14.\n- fix pay-2 — api-worker!17 merged 10-13; PAY-2 Closed 10-15.");
    await hub.answer(q.id, "done");
    expect(hub.store.item(a.id)!.status).toBe("done");
    expect(hub.store.item(b.id)!.status).toBe("done");
  });

  test("one JIRA-only item: 'Done (ticket closed MM-DD)', badge 'Ticket done'; one lookup per key", async () => {
    const s = setup();
    hub.createItem({ title: "geo-egress", status: "waiting", links: [J("PAY-1"), `${J("PAY-1")}?focusedId=1`] });
    await run(s);
    for (let i = 0; i < 3; i++) s.p.tick(new Date());
    expect(card()!.prompt).toBe("Waiting on this, but its tickets are done: geo-egress");
    expect(card()!.badge).toBe("Ticket done");
    expect(card()!.options[0]!.label).toBe("Done (ticket closed 10-14)");
    expect(s.calls).toEqual(["PAY-1"]);
  });

  test("a done ticket only in the source URL doesn't count: it's the parent, not the work", async () => {
    const s = setup();
    hub.createItem({ title: "live-test follow-up", status: "waiting", source: { type: "agent", url: J("PAY-1") } });
    await run(s);
    expect(card()).toBeUndefined();
    expect(s.calls).toEqual([]);
  });

  test("an open MR keeps a done-ticket item off the card without waiting on JIRA", async () => {
    const s = setup({ [MR]: { state: "opened" } });
    hub.createItem({ title: "x", status: "waiting", links: [MR, J("PAY-1")] });
    await run(s);
    expect(card()).toBeUndefined();
  });

  test("state-unknown item whose ticket is done leads with Done", async () => {
    const s = setup();
    const it = hub.createItem({ title: "billing", status: "proposed", links: [J("PAY-2")], signals: { stateUnknown: true } });
    s.p.tick(at(15));
    await s.jira.settled();
    s.p.tick(at(15, 1));
    const q = hub.store.questions("open").find((q) => q.key === `state:${it.id}`)!;
    expect(q.badge).toBe("Ticket done");
    expect(q.options[0]).toMatchObject({ label: "Done (ticket closed 10-15)", tone: "primary" });
    expect(q.context).toBe("PAY-2 Closed 10-15. Probably done.");
  });
});

describe("waiting items whose GitHub PRs merged share the merged card", () => {
  const PR = (n: number) => `https://github.com/acme/memory-svc/pull/${n}`;
  const MR = "https://gitlab.example.com/me/api-worker/-/merge_requests/17";
  const J = (k: string) => `https://jira.example.org/browse/${k}`;
  const pulls: Record<string, PrInfo> = {
    [PR(19)]: { state: "merged", mergedAt: "2026-10-19T12:16:49Z" },
    [PR(21)]: { state: "merged", mergedAt: "2026-10-20T09:00:00Z" },
    [PR(20)]: { state: "open" },
    [PR(22)]: { state: "closed" },
  };
  const setup = () => {
    const calls: string[] = [];
    const mrs = new MrStates(async () => ({ state: "merged", mergedAt: "2026-10-13T10:00:00Z" }));
    const jira = new JiraStates(async () => ({ state: "done", status: "Done", doneAt: "2026-10-14T10:00:00Z" }), new Set(["jira.example.org"]));
    const prs = new PrStates(async (r) => (calls.push(r.url), pulls[r.url] ?? { state: "unknown" }));
    return { calls, prs, p: new Prompter(hub, mrs, jira, prs), settle: () => Promise.all([mrs.settled(), jira.settled(), prs.settled()]) };
  };
  const card = () => hub.store.questions("open").find((q) => q.key === "wait:merged");

  test("one PR-only item: held until gh answers, then 'PR merged' with the merge date; one lookup per PR", async () => {
    const s = setup();
    hub.createItem({ title: "drop legacy table", status: "waiting", links: [PR(19), `${PR(19)}/files#r3`] });
    s.p.tick(new Date());
    expect(card()).toBeUndefined();
    await s.settle();
    for (let i = 0; i < 3; i++) s.p.tick(new Date());
    expect(card()!.prompt).toBe("Waiting on this, but its PRs merged: drop legacy table");
    expect(card()!.badge).toBe("PR merged");
    expect(card()!.options[0]!.label).toBe("Done (merged 10-19)");
    expect(card()!.context).toBe("- drop legacy table — memory-svc#19 merged 10-19.");
    expect(s.calls).toEqual([PR(19)]);
  });

  test("an open, closed-unmerged or unknown PR keeps the item off; mixed MR + PR + ticket items join", async () => {
    const s = setup();
    hub.createItem({ title: "half merged", status: "waiting", links: [PR(19), PR(20)] });
    hub.createItem({ title: "closed unmerged", status: "waiting", links: [PR(22)] });
    hub.createItem({ title: "gh logged out", status: "waiting", links: [PR(99)] });
    const a = hub.createItem({ title: "both", status: "waiting", links: [PR(19), PR(21)] });
    const b = hub.createItem({ title: "mixed", status: "waiting", links: [MR, PR(21), J("PAY-1")] });
    s.p.tick(new Date());
    await s.settle();
    s.p.tick(new Date());
    const q = card()!;
    expect(q.prompt).toBe("2 waiting items: their MR/PRs merged or tickets closed. Mark all done?");
    expect(q.badge).toBe("Merged / done");
    expect(q.context).toBe(
      "- both — memory-svc#19, memory-svc#21 all merged 10-20.\n- mixed — api-worker!17 merged 10-13; memory-svc#21 merged 10-20; PAY-1 Done 10-14.",
    );
    await hub.answer(q.id, "done");
    expect(hub.store.item(a.id)!.status).toBe("done");
    expect(hub.store.item(b.id)!.status).toBe("done");
  });
});

test("parsePrRef: github.com /o/r/pull/N (files, anchors, trailing slash ignored); issues and other hosts aren't refs", () => {
  expect(parsePrRef("https://github.com/cloudflare/playwright/pull/12/files#r3")).toEqual({
    url: "https://github.com/cloudflare/playwright/pull/12",
    owner: "cloudflare",
    repo: "playwright",
    number: 12,
  });
  expect(parsePrRef("https://github.com/o/r/pull/12/")?.number).toBe(12);
  expect(parsePrRef("https://github.com/o/r/issues/12")).toBeUndefined();
  expect(parsePrRef("https://gitlab.example.com/o/r/pull/12")).toBeUndefined();
  expect(parsePrRef("not a url")).toBeUndefined();
});

test("parsePull: merged_at → merged; closed without it → closed; errors and junk → unknown, never merged", () => {
  expect(parsePull('{"number":19,"state":"closed","merged_at":"2026-10-19T12:16:49Z"}')).toEqual({ state: "merged", mergedAt: "2026-10-19T12:16:49Z" });
  expect(parsePull('{"number":20,"state":"open","merged_at":null}')).toEqual({ state: "open" });
  expect(parsePull('{"number":22,"state":"closed","merged_at":null}')).toEqual({ state: "closed" });
  expect(parsePull('{"message":"Not Found","status":"404"}').state).toBe("unknown");
  expect(parsePull("").state).toBe("unknown");
});

test("parseJiraRef: only configured JIRA hosts, /browse/KEY-N, query and trailing slash ignored", () => {
  const hosts = new Set(["jira.example.org"]);
  expect(parseJiraRef("https://jira.example.org/browse/OPS-3?focusedId=1", hosts)).toEqual({
    url: "https://jira.example.org/browse/OPS-3",
    host: "jira.example.org",
    key: "OPS-3",
  });
  expect(parseJiraRef("https://jira.example.com/browse/X-1", hosts)).toBeUndefined();
  expect(parseJiraRef("https://jira.example.org/projects/OPS", hosts)).toBeUndefined();
  expect(parseJiraRef("not a url", hosts)).toBeUndefined();
});

test("parseIssue: statusCategory done is done; 401, Access login HTML or a 404 are unknown, never done", () => {
  const issue = (cat: string, name: string, res: string | null) =>
    JSON.stringify({ key: "X-1", fields: { resolutiondate: res, status: { name, statusCategory: { key: cat } } } });
  expect(parseIssue(200, issue("done", "Resolved", "2026-10-14T11:53:30.000+0000"))).toEqual({ state: "done", status: "Resolved", doneAt: "2026-10-14T11:53:30.000Z" });
  expect(parseIssue(200, issue("indeterminate", "In Review", null))).toEqual({ state: "open", status: "In Review", doneAt: undefined });
  expect(parseIssue(401, issue("done", "Done", null)).state).toBe("unknown");
  expect(parseIssue(200, "<html>Cloudflare Access</html>").state).toBe("unknown");
  expect(parseIssue(404, '{"errorMessages":["Issue Does Not Exist"]}').state).toBe("unknown");
  expect(parseIssue(200, "{}").state).toBe("unknown");
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

describe("due cards while an agent works the item", () => {
  const job = (itemId: string, status: "queued" | "running" | "done") =>
    hub.putJob({ id: `job_${itemId}_${status}`, kind: "verify", name: "verify", title: "verify", surface: "headless", status, itemId, tail: [], createdAt: new Date().toISOString() } as any);
  const due = (title: string) =>
    hub.createItem({ title, kind: "task", status: "scheduled", scheduledFor: new Date(Date.now() - 3 * 3600_000).toISOString() });
  /** A due card for `it` answered `min` minutes ago. */
  const answeredDue = (it: { id: string; scheduledFor?: string }, min: number) => {
    const t = new Date(Date.now() - min * 60_000).toISOString();
    hub.store.putQuestion({ id: `q_due_${it.id}`, kind: "when", itemId: it.id, key: `due:${it.id}:${it.scheduledFor}`, prompt: "It's time", options: [], priority: 90,
      status: "answered", answer: "verify", createdAt: t, answeredAt: t });
  };
  const dueCards = (id: string) => hub.store.questions("open").filter((q) => q.itemId === id && q.key.startsWith("due:"));

  test("past due, live job, due card answered 16 min ago: no 'It's time'", () => {
    const a = due("queued one");
    const b = due("running one");
    for (const it of [a, b]) answeredDue(it, 16);
    job(a.id, "queued");
    job(b.id, "running");
    p.tick(new Date());
    expect(dueCards(a.id)).toHaveLength(0);
    expect(dueCards(b.id)).toHaveLength(0);
  });

  test("job finished but its question is still open (10-19 replay): no 'It's time'", () => {
    const it = due("incident-call agent phase 1");
    answeredDue(it, 16);
    job(it.id, "done");
    hub.ask({ kind: "open", itemId: it.id, key: "agent:abc", prompt: "Phase 1 isn't started. Which route?", options: [], priority: 80 });
    p.tick(new Date());
    expect(dueCards(it.id)).toHaveLength(0);
  });

  test("job done, nothing open, cooldown over: asks again — the promise is still due", () => {
    const it = due("follow through");
    answeredDue(it, 16);
    job(it.id, "done");
    p.tick(new Date());
    expect(dueCards(it.id)).toHaveLength(1);
  });

  /** A non-due question about `it` (an agent's card) answered `min` minutes ago. */
  const answeredOther = (it: { id: string }, min: number) => {
    const t = new Date(Date.now() - min * 60_000).toISOString();
    hub.store.putQuestion({ id: `q_agent_${it.id}_${min}`, kind: "open", itemId: it.id, key: `agent:${it.id}`, prompt: "Which route?", options: [], priority: 80,
      status: "answered", answer: "noted", createdAt: t, answeredAt: t });
  };

  test("agent's question answered 5 min ago, item still past due: no 'It's time' yet", () => {
    const it = due("answered with a noop");
    answeredDue(it, 40);
    answeredOther(it, 5);
    p.tick(new Date());
    expect(dueCards(it.id)).toHaveLength(0);
  });

  test("agent's question answered 16 min ago: asks again", () => {
    const it = due("answered a while back");
    answeredDue(it, 40);
    answeredOther(it, 16);
    p.tick(new Date());
    expect(dueCards(it.id)).toHaveLength(1);
  });

  test("an answer on another item doesn't hold this one back", () => {
    const it = due("mine");
    const other = due("theirs");
    answeredOther(other, 5);
    p.tick(new Date());
    expect(dueCards(it.id)).toHaveLength(1);
  });

  test("an open due card for the same item doesn't block itself", () => {
    const it = due("reply");
    p.tick(new Date());
    p.tick(new Date());
    expect(dueCards(it.id)).toHaveLength(1);
  });
});

describe("coaching move follow-up", () => {
  const coaching = (date: string, when: string) =>
    hub.setCoaching({
      date,
      when,
      signal: "Mixed",
      move: "- Spend ten minutes on the two things only you can do:\n  1. Reply to Tom's `AAACI3KC3Q4` thread.\n  2. Book the Priya Q4 session.",
      wins: [],
      gaps: [],
    });
  const coach = () => hub.store.questions("open").filter((q) => q.key.startsWith("coach:"));

  test("due time comes from the move's 'when'", async () => {
    const { coachDue } = await import("../src/server/prompter.ts");
    const d = (date: string, when: string) => {
      const x = coachDue({ date, when })!;
      return `${x.getMonth() + 1}-${x.getDate()} ${x.toTimeString().slice(0, 5)}`;
    };
    expect(d("2026-10-19", "tomorrow (Tue 10-20, before the 09:30 blog slot)")).toBe("10-20 09:30");
    expect(d("2026-10-18", "Monday (10-19, 09:30–09:45)")).toBe("10-19 09:45");
    expect(d("2026-10-15", "tomorrow (Friday, before the 10:30 Druppov interview)")).toBe("10-16 10:30");
    expect(d("2026-10-14", "tomorrow (Thursday, before BUPK FedRAMP part two)")).toBe("10-15 09:30");
    expect(d("2026-10-16", "tomorrow")).toBe("10-19 09:30"); // Friday → Monday
    expect(d("2026-12-30", "Mon 01-04")).toBe("1-4 09:30");
  });

  test("asked once at the move's time, not before", async () => {
    coaching("2026-10-19", "tomorrow (Tue 10-20, before the 10:00 blog slot)");
    p.tick(new Date(2026, 9, 20, 9, 59));
    expect(coach()).toHaveLength(0);
    p.tick(new Date(2026, 9, 20, 10, 0));
    expect(coach()).toHaveLength(1);
    const q = coach()[0]!;
    expect(q.prompt).toBe("M5 move: Spend ten minutes on the two things only you can do. Did it happen?");
    expect(q.options.map((o) => o.label)).toEqual(["Done", "Hand to an agent", "Not today"]);
    await hub.answer(q.id, "not", "Ryan reply drafted, not sent");
    p.tick(new Date(2026, 9, 20, 15));
    expect(coach()).toHaveLength(0);
    expect(hub.store.journal().some((j) => j.text === `${q.prompt} → Not today — Ryan reply drafted, not sent`)).toBe(true);
  });

  test("bulk ops leave it alone", () => {
    coaching("2026-10-19", "tomorrow");
    p.tick(new Date(2026, 9, 20, 10));
    expect(optionFor(coach()[0]!, "done")).toBeUndefined();
  });

  test("a newer reflection expires the old card; a stale one is never asked", () => {
    coaching("2026-10-19", "tomorrow");
    p.tick(new Date(2026, 9, 20, 10));
    expect(coach()).toHaveLength(1);
    coaching("2026-10-20", "tomorrow");
    p.tick(new Date(2026, 9, 21, 8));
    expect(coach()).toHaveLength(0);
    const h2 = new Hub(new Store(":memory:"));
    h2.setCoaching({ date: "2026-10-12", when: "tomorrow", signal: "", move: "- x", wins: [], gaps: [] });
    new Prompter(h2).tick(new Date(2026, 9, 20, 10));
    expect(h2.store.questions("open").filter((q) => q.key.startsWith("coach:"))).toHaveLength(0);
  });

  test("the panel's history: each move's answer, newest first; an expired card is 'missed'", async () => {
    hub.dispatcher = { dispatch: async () => {} } as any;
    const sent: any[] = [];
    hub.subscribe((e: any) => e.type === "coaching" && sent.push(e.data));
    const run = async (date: string, day: number, opt?: string, note?: string) => {
      coaching(date, "tomorrow");
      p.tick(new Date(2026, 9, day, 10));
      if (opt) await hub.answer(coach()[0]!.id, opt, note);
    };
    await run("2026-10-12", 13, "done");
    await run("2026-10-13", 14, "not", "ran out of time");
    await run("2026-10-14", 15); // left open, then the next reflection expires it
    await run("2026-10-15", 16, "agent");
    await run("2026-10-18", 19, "done");
    await run("2026-10-19", 20, "done");
    const h = hub.coaching()!.history!;
    expect(h.map((x) => `${x.date.slice(5)} ${x.outcome}`)).toEqual(["10-19 done", "10-18 done", "10-15 agent", "10-14 missed", "10-13 not"]);
    expect(hub.coachHistory(10).at(-1)).toEqual({ date: "2026-10-12", outcome: "done" });
    expect(hub.coachHistory(10).find((x) => x.outcome === "not")!.note).toBe("ran out of time");
    // Not stored: the kv row stays the plain block, so an unchanged import doesn't re-emit.
    expect(JSON.parse(hub.store.kv("coaching")!).history).toBeUndefined();
    // Answering the card re-sends the block, so the panel updates without a reload.
    expect(sent.at(-1).history[0]).toEqual({ date: "2026-10-19", outcome: "done" });
  });

  test("'Hand to an agent' journals the answer and dispatches work on a new item", async () => {
    const sent: Array<{ itemId: string; action: string; note?: string }> = [];
    hub.dispatcher = { dispatch: async (itemId: string, action: string, note?: string) => void sent.push({ itemId, action, note }) } as any;
    coaching("2026-10-19", "tomorrow");
    p.tick(new Date(2026, 9, 20, 10));
    const q = coach()[0]!;
    await hub.answer(q.id, "agent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.action).toBe("work");
    expect(sent[0]!.note).toContain("Book the Priya Q4 session");
    const it = hub.store.item(sent[0]!.itemId)!;
    expect(it.title).toBe("M5 move (10-19): Spend ten minutes on the two things only you can do");
    expect(it.source.key).toBe("coach:move:2026-10-19");
    expect(hub.store.journal().some((j) => j.text === `${q.prompt} → Hand to an agent`)).toBe(true);
  });

  test("a handed-off move counts once its agent item closes: done → done (via agent), dropped → not", async () => {
    const sent: string[] = [];
    hub.dispatcher = { dispatch: async (itemId: string) => void sent.push(itemId) } as any;
    const pushed: any[] = [];
    hub.subscribe((e: any) => e.type === "coaching" && pushed.push(e.data));
    const hand = async (date: string, day: number) => {
      coaching(date, "tomorrow");
      p.tick(new Date(2026, 9, day, 10));
      await hub.answer(coach()[0]!.id, "agent");
      return sent.at(-1)!;
    };
    const a = await hand("2026-10-18", 19);
    const b = await hand("2026-10-19", 20);
    expect(hub.coachHistory().map((x) => x.outcome)).toEqual(["agent", "agent"]);
    hub.setStatus(b, "done", undefined, "agent");
    expect(hub.coachHistory()[0]).toEqual({ date: "2026-10-19", outcome: "done", via: "agent" });
    // Closing the item re-sends the panel, so it updates without a reload.
    expect(pushed.at(-1).history[0]).toEqual({ date: "2026-10-19", outcome: "done", via: "agent" });
    hub.setStatus(a, "dropped");
    expect(hub.coachHistory()[1]).toEqual({ date: "2026-10-18", outcome: "not", via: "agent" });
    // Reopened: back to handed off.
    hub.setStatus(b, "doing");
    expect(hub.coachHistory()[0]!.outcome).toBe("agent");
  });
});

describe("doing with nobody on it", () => {
  // Wed 2026-09-23. Work hours come from config (default 8–19).
  const doing = (title: string, since: Date) => {
    const it = hub.createItem({ title, status: "doing" });
    hub.store.putItem({ ...it, updatedAt: since.toISOString() });
    return it;
  };
  const cards = (id: string) => hub.store.questions("open").filter((q) => q.itemId === id && q.key.startsWith("doing:"));

  test("workMsBetween counts weekday work hours only", () => {
    const h = 3600_000;
    expect(workMsBetween(at(9), at(14), [8, 19])).toBe(5 * h);
    expect(workMsBetween(at(6), at(9), [8, 19])).toBe(1 * h);
    // Fri 17:00 → Mon 11:00: 2 h Friday + 3 h Monday, the weekend is free.
    expect(workMsBetween(new Date(2026, 8, 25, 17), new Date(2026, 8, 28, 11), [8, 19])).toBe(5 * h);
  });

  test("5 work hours with no job: exactly one 'Still on it?' card, not again on the next ticks", () => {
    const it = doing("devtools!5962", new Date(at(15).getTime() - 5 * 3600_000));
    p.tick(at(15));
    p.tick(at(15, 5));
    p.tick(at(16));
    const qs = cards(it.id);
    expect(qs).toHaveLength(1);
    expect(qs[0]!.kind).toBe("state");
    expect(qs[0]!.options.map((o) => o.effect)).toEqual([
      { type: "status", status: "done" },
      { type: "status", status: "waiting" },
      { type: "status", status: "today" },
      { type: "status", status: "dropped" },
    ]);
  });

  test("under 4 work hours, or 5 wall hours that are mostly night: no card", () => {
    const [start, end] = config.sweeps.workHours;
    const a = doing("fresh", at(end - 3));
    p.tick(at(end - 1)); // 2 work hours
    expect(cards(a.id)).toHaveLength(0);
    // Yesterday 1 h before close → today 2 h after open: 3 work hours, ~13+ wall hours.
    const b = doing("overnight", new Date(2026, 8, 22, end - 1));
    p.tick(at(start + 2));
    expect(cards(b.id)).toHaveLength(0);
  });

  test("a live job, or any open card about it (the after-card), holds it back", () => {
    const a = doing("agent running", at(8));
    const b = doing("after-card open", at(8));
    hub.putJob({ id: "j_live", kind: "action", name: "work", title: "x", surface: "headless", status: "running", itemId: a.id, tail: [], createdAt: at(8).toISOString() } as any);
    hub.ask({ kind: "state", itemId: b.id, key: "after:j", priority: 75, prompt: "Agent stopped", options: [] });
    p.tick(at(15));
    expect(cards(a.id)).toHaveLength(0);
    expect(cards(b.id)).toHaveLength(0);
  });

  test("the clock starts at the last job's finish or answered card, not when it went to doing", () => {
    const it = doing("redispatched", at(8));
    hub.putJob({ id: "j_done", kind: "action", name: "work", title: "x", surface: "headless", status: "done", itemId: it.id, tail: [], createdAt: at(8).toISOString(), finishedAt: at(13).toISOString() } as any);
    p.tick(at(15));
    expect(cards(it.id)).toHaveLength(0);
    p.tick(at(17, 30));
    expect(cards(it.id)).toHaveLength(1);
  });

  test("answering moves it off doing; an expired card waits 24 h", async () => {
    const it = doing("answered", at(8));
    p.tick(at(15));
    await hub.answer(cards(it.id)[0]!.id, "today");
    expect(hub.store.item(it.id)!.status).toBe("today");
    const other = doing("ignored", at(8));
    p.tick(at(15));
    const q = cards(other.id)[0]!;
    hub.store.putQuestion({ ...q, status: "answered", answer: "x", answeredAt: new Date().toISOString() }); // closed without moving it
    p.tick(at(16));
    expect(cards(other.id)).toHaveLength(0);
  });

  test("the card expires once the item leaves doing or an agent picks it up", () => {
    const a = doing("moved", at(8));
    const b = doing("picked up", at(8));
    p.tick(at(15));
    hub.store.putItem({ ...hub.store.item(a.id)!, status: "today" });
    hub.putJob({ id: "j_b", kind: "action", name: "work", title: "x", surface: "headless", status: "queued", itemId: b.id, tail: [], createdAt: new Date().toISOString() } as any);
    p.tick(at(15, 1));
    expect(cards(a.id)).toHaveLength(0);
    expect(cards(b.id)).toHaveLength(0);
  });
});
