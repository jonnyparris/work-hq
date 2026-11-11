// it_mwc4qa79kigb9: no "today's three" card on a day off. The calendar sweep reports out-of-office blocks as
// `away`; the plan card waits while one covers now. Shapes are from the live calendar: a multi-day OOO is a
// dateTime block (00:00 → 00:00 days later), and a recurring "creche pickup" OOO is 45 min in the afternoon.
import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { awayMs, Hub } from "../src/server/hub.ts";
import { Prompter } from "../src/server/prompter.ts";
import { calendarSweepPrompt } from "../src/server/prompts.ts";

let hub: Hub;
let p: Prompter;
beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  p = new Prompter(hub);
});

// Wednesday 2026-09-23, local time.
const at = (h: number, m = 0, day = 23) => new Date(2026, 8, day, h, m);
const plans = () => hub.store.questions("open").filter((q) => q.kind === "plan");
const sweep = (away: unknown) => hub.ingestReport({ summary: "1 event", events: [], away } as any, "calendar");

describe("morning plan on out-of-office days", () => {
  test("a normal day still gets the plan card", () => {
    sweep([]);
    p.tick(at(10));
    expect(plans()).toHaveLength(1);
  });

  test("a multi-day OOO block that began earlier: no plan card all morning", () => {
    sweep([{ title: "Out of office", start: at(0, 0, 21).toISOString(), end: at(0, 0, 26).toISOString() }]);
    p.tick(at(9));
    p.tick(at(11, 55));
    expect(plans()).toHaveLength(0);
  });

  test("an all-day date-only block (end exclusive) is read in local time", () => {
    sweep([{ title: "PTO", start: "2026-09-23", end: "2026-09-24" }]);
    p.tick(at(10));
    expect(plans()).toHaveLength(0);
    // The next day is a workday again.
    p.tick(at(10, 0, 24));
    expect(plans()).toHaveLength(1);
  });

  test("a short afternoon OOO doesn't suppress the morning card", () => {
    sweep([{ title: "Out of office - creche pickup", start: at(16, 30).toISOString(), end: at(17, 15).toISOString() }]);
    p.tick(at(10));
    expect(plans()).toHaveLength(1);
  });

  test("a morning off: asked once you're back, before noon", () => {
    sweep([{ title: "Out of office", start: at(0).toISOString(), end: at(10, 30).toISOString() }]);
    p.tick(at(10));
    expect(plans()).toHaveLength(0);
    p.tick(at(10, 30));
    expect(plans()).toHaveLength(1);
  });

  test("a sweep without `away`, or with only junk, keeps the last list; one with [] clears it", () => {
    sweep([{ title: "Out of office", start: at(0).toISOString(), end: at(0, 0, 24).toISOString() }]);
    hub.ingestReport({ summary: "other report", events: [] }, "calendar");
    expect(hub.awayAt(at(10))).toBeTruthy();
    sweep([{ title: "bad", start: "soon", end: "later" }, { title: "backwards", start: at(12).toISOString(), end: at(9).toISOString() }]);
    expect(hub.awayAt(at(10))).toBeTruthy();
    sweep([]);
    expect(hub.away()).toHaveLength(0);
    p.tick(at(10));
    expect(plans()).toHaveLength(1);
  });

  test("only the calendar sweep sets away blocks", () => {
    hub.ingestReport({ summary: "x", away: [{ title: "OOO", start: at(0).toISOString(), end: at(0, 0, 24).toISOString() }] } as any, "agent");
    expect(hub.away()).toHaveLength(0);
  });

  test("a plan card asked before the sweep reported the day off is expired", () => {
    p.tick(at(9));
    expect(plans()).toHaveLength(1);
    sweep([{ title: "Out of office", start: at(0).toISOString(), end: at(0, 0, 24).toISOString() }]);
    p.tick(at(9, 5));
    expect(plans()).toHaveLength(0);
  });

  test("a morning off that the sweep reports after the card was asked: the card stays for when you're back", () => {
    p.tick(at(9));
    sweep([{ title: "Out of office", start: at(0).toISOString(), end: at(10).toISOString() }]);
    p.tick(at(9, 5));
    expect(plans()[0]!.notBefore).toBe(at(10).toISOString());
    p.tick(at(10, 30));
    expect(plans()).toHaveLength(1);
  });

  test("a snooze that ends inside the block, or back-to-back blocks: the hold moves to the block's end", async () => {
    p.tick(at(8, 0));
    const card = plans()[0]!;
    hub.park(card, at(9, 30).toISOString());
    sweep([
      { title: "Out of office", start: at(8).toISOString(), end: at(10).toISOString() },
      { title: "Out of office", start: at(10).toISOString(), end: at(11).toISOString() },
    ]);
    p.tick(at(9, 31));
    expect(hub.store.question(card.id)!.notBefore).toBe(at(10).toISOString());
    p.tick(at(10, 1));
    expect(hub.store.question(card.id)!.notBefore).toBe(at(11).toISOString());
  });

  test("a hold that already runs past the block's end is left alone", () => {
    p.tick(at(8, 0));
    const card = plans()[0]!;
    hub.park(card, at(11).toISOString());
    sweep([{ title: "Out of office", start: at(8).toISOString(), end: at(10).toISOString() }]);
    p.tick(at(9));
    expect(hub.store.question(card.id)!.notBefore).toBe(at(11).toISOString());
  });

  test("overlapping blocks: the day off wins whichever comes first", () => {
    const short = { title: "Out of office - school run", start: at(8).toISOString(), end: at(9, 30).toISOString() };
    const day = { title: "PTO", start: "2026-09-23", end: "2026-09-24" };
    for (const list of [[short, day], [day, short]]) {
      const h = new Hub(new Store(":memory:"));
      const pr = new Prompter(h);
      pr.tick(at(8, 30));
      h.ingestReport({ summary: "x", events: [], away: list } as any, "calendar");
      pr.tick(at(8, 35));
      expect(h.store.questions("open").filter((q) => q.kind === "plan")).toHaveLength(0);
    }
  });

  test("an afternoon block leaves the morning's open card alone", () => {
    p.tick(at(9));
    sweep([{ title: "Out of office - creche pickup", start: at(12, 30).toISOString(), end: at(13).toISOString() }]);
    p.tick(at(12, 35));
    expect(plans()).toHaveLength(1);
  });

  test("awayMs: date-only is local midnight; rolled-over dates are not dates", () => {
    expect(awayMs("2026-09-23")).toBe(new Date(2026, 8, 23).getTime());
    expect(awayMs("2026-02-31")).toBeNaN();
    expect(awayMs("2026-09-23T10:00:00+01:00")).toBe(Date.parse("2026-09-23T09:00:00Z"));
  });

  test("the calendar sweep asks for away blocks, not to skip them", () => {
    const prompt = calendarSweepPrompt("job_x", "2026-09-23", "2026-09-30").replace(/\s+/g, " ");
    expect(prompt).toContain('"away"');
    expect(prompt).toContain("outOfOffice");
    expect(prompt).toContain("began before 2026-09-23");
    expect(prompt).toContain("on every day in the range");
    expect(prompt).not.toContain("Skip all-day OOO");
  });
});
