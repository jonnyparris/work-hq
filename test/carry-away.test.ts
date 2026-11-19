// it_mwfmcy4ibg34t: Wrap up's Carry skips days off, not just weekends. 11-12 22:43 (Thursday) three carries became
// three 09:30 cards on an all-day out-of-office Friday. Hub.carry reads the calendar sweep's away blocks.
import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { carrySlot } from "../src/shared/workday.ts";

let hub: Hub;
beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
});

// 2026-11-12 is a Thursday, 11-13 a Friday, 11-16 a Monday.
const d = (day: number, h = 0, m = 0) => new Date(2026, 10, day, h, m);
const iso = (day: number, h = 0, m = 0) => d(day, h, m).toISOString();
const carried = (now: Date) => {
  const it = hub.createItem({ title: "Signal group", status: "today" });
  const out = hub.carry(it.id, now);
  return { at: out.scheduledFor, when: out.when, status: out.status };
};

describe("Wrap up's Carry skips weekends and days off", () => {
  test("Friday 22:43, no away blocks: Monday 09:30", () => {
    expect(carried(d(13, 22, 43))).toEqual({ at: iso(16, 9, 30), when: "mon 09:30 (carried)", status: "scheduled" });
  });

  test("Thursday 22:43 before an all-day OOO Friday (date-only, end exclusive): Monday 09:30", () => {
    hub.setAway([{ title: "OOO", start: "2026-11-13", end: "2026-11-14" }]);
    expect(carried(d(12, 22, 43))).toEqual({ at: iso(16, 9, 30), when: "mon 09:30 (carried)", status: "scheduled" });
  });

  test("Thursday 22:43 before a dateTime OOO block 00:00 -> 00:00: Monday 09:30", () => {
    hub.setAway([{ title: "Out of office", start: iso(13), end: iso(14) }]);
    expect(carried(d(12, 22, 43)).at).toBe(iso(16, 9, 30));
  });

  test("a short afternoon OOO (creche pickup) doesn't skip the day", () => {
    hub.setAway([{ title: "Out of office - creche pickup", start: iso(13, 16, 30), end: iso(13, 17, 15) }]);
    expect(carried(d(12, 22, 43))).toEqual({ at: iso(13, 9, 30), when: "tomorrow 09:30 (carried)", status: "scheduled" });
  });

  test("a morning off doesn't skip the day", () => {
    hub.setAway([{ title: "Out of office", start: iso(13), end: iso(13, 12) }]);
    expect(carried(d(12, 22, 43)).at).toBe(iso(13, 9, 30));
  });

  test("a week off after the weekend: the Monday after, labelled with its date", () => {
    hub.setAway([{ title: "PTO", start: "2026-11-16", end: "2026-11-21" }]);
    expect(carried(d(13, 22, 43))).toEqual({ at: iso(23, 9, 30), when: "mon 23 nov 09:30 (carried)", status: "scheduled" });
  });

  test("a day off split into back-to-back blocks is still a day off", () => {
    hub.setAway([
      { title: "Out of office", start: iso(13), end: iso(13, 13) },
      { title: "Out of office", start: iso(13, 13), end: iso(14) },
    ]);
    expect(carried(d(12, 22, 43)).at).toBe(iso(16, 9, 30));
  });

  test("a gap between two blocks (back at 13:00 for an hour) isn't a day off; out of order is read the same", () => {
    hub.setAway([
      { title: "Out of office", start: iso(13, 14), end: iso(14) },
      { title: "Out of office", start: iso(13), end: iso(13, 13) },
    ]);
    expect(carried(d(12, 22, 43)).at).toBe(iso(13, 9, 30));
  });

  test("a block of exactly 09:30-17:00 is a day off", () => {
    hub.setAway([{ title: "Out of office", start: iso(13, 9, 30), end: iso(13, 17) }]);
    expect(carried(d(12, 22, 43)).at).toBe(iso(16, 9, 30));
  });

  test("six months off: the first day back", () => {
    hub.setAway([{ title: "Parental leave", start: "2026-11-13", end: "2027-05-17" }]);
    expect(carried(d(12, 22, 43)).at).toBe(new Date(2027, 4, 17, 9, 30).toISOString());
  });

  test("every day off (no end in sight): falls back to the next plain workday", () => {
    expect(carrySlot(d(12, 22, 43), () => true).at.getTime()).toBe(d(13, 9, 30).getTime());
  });
});
