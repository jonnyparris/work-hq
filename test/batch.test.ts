import { beforeEach, describe, expect, test } from "bun:test";
import { deckGroup, deferHorizon, deferTargets, optionFor, quickFirst, slotLine, slotLoad } from "../src/shared/batch.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { Prompter } from "../src/server/prompter.ts";

let hub: Hub;
let p: Prompter;
const dispatched: string[] = [];
beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  p = new Prompter(hub);
  dispatched.length = 0;
  hub.dispatcher = { dispatch: async (id, action) => { dispatched.push(`${action}:${id}`); return undefined; }, scheduleFromWords: async () => {} };
});

// Tuesday 2026-10-06, 18:00 local.
const now = new Date(2026, 9, 6, 18);

describe("deferTargets", () => {
  test("Tuesday evening: tomorrow, rest of the week, next Monday", () => {
    const t = deferTargets(now);
    expect(t.map((x) => x.label)).toEqual(["Tomorrow · Wed", "Thu", "Fri", "Next week · Mon"]);
    expect(new Date(t[0]!.at).getHours()).toBe(9);
  });
  test("Friday: next working day is Monday, never a weekend", () => {
    const t = deferTargets(new Date(2026, 9, 9, 18));
    expect(t.every((x) => ![0, 6].includes(new Date(x.at).getDay()))).toBe(true);
    expect(new Date(t[0]!.at).getDay()).toBe(1);
    expect(t[0]!.label).toBe("Mon");
  });
});

describe("bulk", () => {
  const posts = () => {
    for (let i = 0; i < 2; i++) hub.createItem({ title: `post ${i}`, kind: "post", status: "proposed", post: { venue: "wiki", wikiDraft: `/tmp/p${i}.md` } });
  };

  test("defer by kind hides the questions and moves not-yet-due scheduled ones", async () => {
    posts();
    const sched = hub.createItem({ title: "post scheduled", kind: "post", status: "scheduled", scheduledFor: new Date(2026, 9, 7, 9, 30).toISOString() });
    p.tick(now);
    expect(hub.store.questions("open").filter((q) => q.kind === "post")).toHaveLength(2);
    const fri = deferTargets(now)[2]!;
    const r = await hub.bulk({ kind: "post", op: "defer", until: fri.at, label: "Fri 09:30" });
    expect(r.count).toBe(3);
    const open = hub.store.questions("open").filter((q) => q.kind === "post");
    expect(open.every((q) => q.notBefore === fri.at)).toBe(true);
    expect(hub.store.item(sched.id)!.scheduledFor).toBe(fri.at);
    expect(hub.store.journal().some((j) => j.text.startsWith("Batch — Deferred to Fri 09:30 (3)"))).toBe(true);
    // Deferred ones still hold the per-kind cap: no fresh post questions sneak in.
    hub.createItem({ title: "post new", kind: "post", status: "proposed" });
    p.tick(new Date(now.getTime() + 60_000));
    expect(hub.store.questions("open").filter((q) => q.kind === "post")).toHaveLength(2);
  });

  test("deferred questions don't eat the total budget", () => {
    for (let i = 0; i < 6; i++) hub.createItem({ title: `cap ${i}`, status: "inbox" });
    p.tick(now);
    const before = hub.store.questions("open").length;
    for (const q of hub.store.questions("open")) {
      q.notBefore = new Date(now.getTime() + 86400_000).toISOString();
      hub.store.putQuestion(q);
    }
    for (let i = 0; i < 3; i++) hub.createItem({ title: `unknown ${i}`, status: "proposed", signals: { stateUnknown: true } });
    p.tick(now);
    expect(hub.store.questions("open").length).toBeGreaterThan(before);
  });

  test("dismiss uses each group's own one-tap option", async () => {
    hub.setEvents([
      { id: "e1", title: "Sync", start: new Date(now.getTime() - 60 * 60_000).toISOString(), end: new Date(now.getTime() - 10 * 60_000).toISOString(), attendees: ["a", "b"] },
    ]);
    const inbox = hub.createItem({ title: "maybe mine", status: "inbox" });
    p.tick(now);
    await hub.bulk({ group: "review", op: "dismiss" });
    await hub.bulk({ group: "inbox", op: "dismiss" });
    expect(hub.store.questions("open").filter((q) => q.kind === "review" || q.kind === "confirm")).toHaveLength(0);
    expect(hub.store.item(inbox.id)!.status).toBe("proposed");
  });

  test("dispatch sends agents but never bulk-publishes", async () => {
    posts();
    const unk = hub.createItem({ title: "where is X", status: "proposed", signals: { stateUnknown: true } });
    p.tick(now);
    await hub.bulk({ group: "state", op: "dispatch" });
    expect(dispatched).toEqual([`verify:${unk.id}`]);
    const r = await hub.bulk({ group: "post", op: "dispatch" });
    expect(r.count).toBe(0);
    expect(r.skipped).toBe(2);
  });

  test("defer on a due item moves the time instead of hiding the prompt", async () => {
    const it = hub.createItem({ title: "reply to Sam", kind: "message", status: "scheduled", scheduledFor: new Date(now.getTime() - 3600_000).toISOString() });
    p.tick(now);
    const tmrw = deferTargets(now)[0]!;
    await hub.bulk({ group: "due", op: "defer", until: tmrw.at });
    expect(hub.store.item(it.id)!.scheduledFor).toBe(tmrw.at);
    expect(hub.store.questions("open").filter((q) => q.itemId === it.id)).toHaveLength(0);
  });

  test("never touches plan/wrap unless picked by id; empty selector does nothing", async () => {
    p.tick(new Date(2026, 9, 6, 17, 45)); // wrap window
    const wrap = hub.store.questions("open").find((q) => q.kind === "wrap");
    expect(wrap).toBeTruthy();
    expect(deckGroup(wrap!)).toBe("day");
    await hub.bulk({ op: "defer", until: deferTargets(now)[0]!.at });
    await hub.bulk({ kind: "task", op: "defer", until: deferTargets(now)[0]!.at });
    expect(hub.store.question(wrap!.id)!.notBefore).toBeUndefined();
  });
});

describe("quickFirst", () => {
  test("one-tap beats hand-off beats head-work, regardless of priority", () => {
    const mk = (key: string, kind: any, priority: number) => ({ id: key, key, kind, priority, createdAt: "", options: [], prompt: "", status: "open" }) as any;
    const qs = [mk("post:1:draft", "post", 99), mk("state:1", "state", 80), mk("wait:1", "state", 10)].sort(quickFirst);
    expect(qs.map((q) => q.key)).toEqual(["wait:1", "state:1", "post:1:draft"]);
  });
  test("optionFor skips options that need words", () => {
    expect(optionFor({ key: "inbox:x", kind: "confirm", options: [{ id: "when", label: "", effect: { type: "when" } }] }, "dismiss")).toBeUndefined();
  });
});

describe("slotLoad", () => {
  // Friday 2026-10-09 18:00: "Mon" is the first target.
  const fri = new Date(2026, 9, 9, 18);
  const mon = deferTargets(fri)[0]!;
  const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m).toISOString();
  const ev = (id: string, title: string, s: string, e: string, response?: "declined") => ({ id, title, start: s, end: e, response, attendees: ["Rory"] });

  test("counts what's already there and names the clash", () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ id: `i${i}`, title: `t${i}`, kind: "task", status: "scheduled", scheduledFor: mon.at, source: { type: "manual" }, createdAt: "", updatedAt: "" })) as any[];
    const questions = [
      { id: "q1", itemId: "i0", notBefore: mon.at, status: "open" }, // same item: counted once
      { id: "q2", itemId: "i9", notBefore: mon.at, status: "open" },
    ] as any[];
    const events = [ev("e1", "CluePoints", at(9, 30), at(10, 30)), ev("e2", "Skipped", at(9, 30), at(10), "declined"), ev("e3", "Standup", at(11), at(11, 15))];
    const l = slotLoad(mon.at, { items, questions, events, calendarThrough: "2026-10-12", workHours: [8, 18] });
    expect(l.count).toBe(4);
    expect(l.clashes.map((e) => e.title)).toEqual(["CluePoints"]);
    expect(l.nextFree?.hhmm).toBe("10:30");
    expect(slotLine("Mon 09:30", l)).toBe("Mon 09:30: 4 items already · clashes with CluePoints 09:30");
  });

  test("next free skips back-to-back events", () => {
    const events = [ev("a", "A", at(9, 30), at(10, 30)), ev("b", "B", at(10, 30), at(11, 15))];
    expect(slotLoad(mon.at, { items: [], questions: [], events, calendarThrough: "2026-10-12" }).nextFree?.hhmm).toBe("11:30");
  });

  test("solo holds don't count as clashes", () => {
    const hold = { id: "h", title: "Focus time", start: at(9), end: at(12), attendees: [] };
    expect(slotLoad(mon.at, { items: [], questions: [], events: [hold], calendarThrough: "2026-10-12" }).clashes).toHaveLength(0);
  });

  test("doesn't claim free when the calendar wasn't read that far", () => {
    const l = slotLoad(mon.at, { items: [], questions: [], events: [], calendarThrough: "2026-10-09" });
    expect(l.calendarKnown).toBe(false);
    expect(slotLine("Mon 09:30", l)).toBe("Mon 09:30: nothing else there yet · calendar not read that far yet");
  });

  test("horizon is the furthest defer target", () => {
    expect(deferHorizon(now)).toBe("2026-10-12");
  });

  test("setEvents with a range clears empty later days and exposes upcoming", () => {
    const hub2 = new Hub(new Store(":memory:"));
    const t = new Date();
    const iso = (d: Date) => { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00:00`; };
    const through = deferHorizon(t);
    const later = deferTargets(t)[0]!;
    const ld = new Date(later.at);
    hub2.setEvents([{ id: "x", title: "Later", start: iso(ld), end: iso(new Date(ld.getTime() + 3600_000)) }], through);
    expect(hub2.snapshot().upcoming.map((e) => e.id)).toEqual(["x"]);
    hub2.setEvents([], through);
    expect(hub2.snapshot().upcoming).toHaveLength(0);
  });
});
