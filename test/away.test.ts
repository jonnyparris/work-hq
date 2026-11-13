// it_mwc4qa79kigb9: no "today's three" card on a day off. The calendar sweep reports out-of-office blocks as
// `away`; the plan card waits while one covers now. Shapes are from the live calendar: a multi-day OOO is a
// dateTime block (00:00 → 00:00 days later), and a recurring "creche pickup" OOO is 45 min in the afternoon.
import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { awayMs, Hub } from "../src/server/hub.ts";
import { config } from "../src/server/config.ts";
import { cardDue, OOO_EXPIRY, Prompter } from "../src/server/prompter.ts";
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

  // Back-off (cardDue): a card the OOO block expired isn't an ignored day. Ignored on the 21st, OOO-expired on the
  // 22nd: the 23rd still gets its card (counted as ignored, the 22nd would make two in a row and skip it).
  test("a plan card expired by an OOO block doesn't count towards the back-off", () => {
    sweep([]);
    p.tick(at(10, 0, 21));
    p.tick(at(14, 0, 21)); // ignored: "day moved on"
    p.tick(at(9, 0, 22));
    expect(plans()).toHaveLength(1);
    sweep([{ title: "Out of office", start: at(10, 0, 22).toISOString(), end: at(17, 0, 22).toISOString() }]);
    p.tick(at(10, 30, 22));
    expect(hub.store.questions().find((q) => q.key === "plan:2026-09-22")!.answer).toBe("out of office: Out of office");
    sweep([]);
    p.tick(at(10, 0, 23));
    expect(plans().map((q) => q.key)).toEqual(["plan:2026-09-23"]);
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

// it_mwcrrhj3ipnt6: the same rule for the prep and wrap-up cards. 11-11's all-day OOO still got `wrap:` at 17:30.
describe("prep and wrap-up on out-of-office days", () => {
  const dayEnd = config.sweeps.workHours[1];
  // An hour before the end of the day: inside the wrap-up window.
  const wrapAt = (m = 0) => new Date(new Date(2026, 8, 23).getTime() + ((dayEnd - 1) * 60 + m) * 60_000);
  const wraps = () => hub.store.questions("open").filter((q) => q.kind === "wrap");
  const preps = () => hub.store.questions("open").filter((q) => q.kind === "prep");
  const oneOnOne = () =>
    hub.setEvents([{ id: "k", title: "1-1 Kevin", start: at(15).toISOString(), end: at(15, 30).toISOString(), attendees: ["Kevin"], oneOnOne: true }]);
  const dayOff = { title: "Out of office", start: at(0).toISOString(), end: at(0, 0, 24).toISOString() };

  test("a day off: no wrap-up card", () => {
    sweep([dayOff]);
    p.tick(wrapAt());
    p.tick(wrapAt(60));
    expect(wraps()).toHaveLength(0);
  });

  test("a short block in the wrap-up window delays it; one earlier in the afternoon changes nothing", () => {
    sweep([{ title: "Out of office - creche pickup", start: wrapAt(-10).toISOString(), end: wrapAt(20).toISOString() }]);
    p.tick(wrapAt());
    expect(wraps()).toHaveLength(0);
    p.tick(wrapAt(20));
    expect(wraps()).toHaveLength(1);
    const h = new Hub(new Store(":memory:"));
    const pr = new Prompter(h);
    h.ingestReport({ summary: "x", events: [], away: [{ title: "Out of office - creche pickup", start: at(13).toISOString(), end: at(13, 45).toISOString() }] } as any, "calendar");
    pr.tick(wrapAt());
    expect(h.store.questions("open").filter((q) => q.kind === "wrap")).toHaveLength(1);
  });

  test("a wrap-up card asked before the sweep reported the day off is expired, and that day isn't 'ignored'", () => {
    p.tick(wrapAt());
    expect(wraps()).toHaveLength(1);
    sweep([dayOff]);
    p.tick(wrapAt(5));
    expect(wraps()).toHaveLength(0);
    const off = hub.store.closedByPrefix("wrap:", 10)[0]!;
    expect(off.answer).toStartWith(OOO_EXPIRY);
    // One really-ignored day plus the day off: still asked. Two ignored days back off.
    const ignored = { ...off, key: "wrap:2026-09-22", status: "expired" as const, answer: "day moved on" };
    expect(cardDue("wrap:", [ignored, off], "2026-09-24")).toBe(true);
    expect(cardDue("wrap:", [ignored, { ...off, answer: "day moved on" }], "2026-09-24")).toBe(false);
    // A bare snooze earlier that day, then the follow-up expired for the block: still not an ignored day.
    const snooze = { ...off, status: "answered" as const, answer: "Ask me in an hour" };
    expect(cardDue("wrap:", [ignored, snooze, off], "2026-09-24")).toBe(true);
    // A real answer that day keeps it as an answered day: an ignored day before it is still forgiven.
    const real = { ...off, status: "answered" as const, answer: "That's the truth — save it" };
    const older = [{ ...ignored, key: "wrap:2026-09-20" }, { ...ignored, key: "wrap:2026-09-21" }, ignored];
    expect(cardDue("wrap:", [...older, real, off], "2026-09-24")).toBe(true);
    // Without it, 09-23 drops out: three ignored days, 4-day back-off from 09-22.
    expect(cardDue("wrap:", [...older, off], "2026-09-24")).toBe(false);
  });

  test("an open wrap-up card during a short block is held until it ends", () => {
    p.tick(wrapAt());
    sweep([{ title: "Out of office - school run", start: wrapAt(5).toISOString(), end: wrapAt(50).toISOString() }]);
    p.tick(wrapAt(10));
    expect(wraps()[0]!.notBefore).toBe(wrapAt(50).toISOString());
    p.tick(wrapAt(51));
    expect(wraps()).toHaveLength(1);
  });

  test("a day off: no prep card", () => {
    oneOnOne();
    sweep([dayOff]);
    p.tick(at(9));
    p.tick(at(11));
    expect(preps()).toHaveLength(0);
  });

  test("a morning off: prep asked once you're back", () => {
    oneOnOne();
    sweep([{ title: "Out of office", start: at(0).toISOString(), end: at(10).toISOString() }]);
    p.tick(at(9));
    expect(preps()).toHaveLength(0);
    p.tick(at(10));
    expect(preps()).toHaveLength(1);
  });

  test("a prep card asked before the sweep reported the day off is expired", () => {
    oneOnOne();
    p.tick(at(9));
    expect(preps()).toHaveLength(1);
    sweep([dayOff]);
    p.tick(at(9, 5));
    expect(preps()).toHaveLength(0);
  });

  test("a block over lunch holds an open prep card for the afternoon 1-1, it doesn't kill it", () => {
    oneOnOne();
    p.tick(at(9));
    sweep([{ title: "Out of office", start: at(11, 30).toISOString(), end: at(13).toISOString() }]);
    p.tick(at(11, 35));
    expect(preps()[0]!.notBefore).toBe(at(13).toISOString());
    p.tick(at(13, 5));
    expect(preps()).toHaveLength(1);
    expect(preps()[0]!.picks!.map((x) => x.id)).toEqual(["k"]);
  });

  test("a short afternoon block holds the open prep card until it ends", () => {
    oneOnOne();
    p.tick(at(9));
    sweep([{ title: "Out of office - creche pickup", start: at(13).toISOString(), end: at(13, 45).toISOString() }]);
    p.tick(at(13, 5));
    expect(preps()[0]!.notBefore).toBe(at(13, 45).toISOString());
  });

  test("an afternoon block to the end of the day expires the open prep card", () => {
    oneOnOne();
    p.tick(at(9));
    sweep([{ title: "Out of office", start: at(14).toISOString(), end: at(0, 0, 24).toISOString() }]);
    p.tick(at(14, 5));
    expect(preps()).toHaveLength(0);
  });
});
