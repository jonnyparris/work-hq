import { describe, expect, test } from "bun:test";
import { dueOptions, whenOptions } from "../src/server/prompter.ts";
import { carrySlot, morningButtons, nextMonday, nextWorkdayAt, nextWorkMorningSlot } from "../src/shared/workday.ts";

// 2026-11-06 is a Friday.
const fri22 = new Date(2026, 10, 6, 22, 0);
const wed16 = new Date(2026, 10, 4, 16, 0);
const sat10 = new Date(2026, 10, 7, 10, 0);
const sun10 = new Date(2026, 10, 8, 10, 0);
const mon9_30 = new Date(2026, 10, 9, 9, 30);

describe("carried and Tomorrow slots skip weekends", () => {
  test("Friday 22:00 carry lands Monday 09:30", () => {
    const { at, label } = nextWorkMorningSlot(fri22);
    expect(at.getTime()).toBe(mon9_30.getTime());
    expect(label).toBe("Mon 09:30");
  });

  test("weekdays carry to tomorrow; the weekend to Monday", () => {
    expect(nextWorkMorningSlot(wed16)).toEqual({ at: new Date(2026, 10, 5, 9, 30), label: "Tomorrow 09:30" });
    expect(nextWorkMorningSlot(sat10)).toEqual({ at: mon9_30, label: "Mon 09:30" });
    expect(nextWorkMorningSlot(sun10)).toEqual({ at: mon9_30, label: "Tomorrow 09:30" });
    expect(nextWorkdayAt(14, 0, new Date(2026, 10, 5, 8)).getTime()).toBe(new Date(2026, 10, 6, 14, 0).getTime()); // Thu → Fri
  });

  test("next Monday is a week out on a Monday", () => {
    expect(nextMonday(mon9_30).getTime()).toBe(new Date(2026, 10, 16, 9, 30).getTime());
    expect(nextMonday(fri22).getTime()).toBe(mon9_30.getTime());
  });

  test("whenOptions: Friday offers Monday once, not Saturday", () => {
    const opts = whenOptions(fri22);
    const slots = opts.map((o) => { if (o.effect.type !== "schedule") throw new Error(`not a slot: ${o.label}`); return o.effect.at; });
    expect(opts.map((o) => o.label)).toEqual(["23:30 today", "Mon · 09:30"]);
    expect(slots[1]).toBe(mon9_30.toISOString());
    expect(slots.some((s) => [6, 0].includes(new Date(s).getDay()) && new Date(s).getHours() === 9)).toBe(false);
  });

  test("whenOptions midweek keeps Tomorrow and Next week", () => {
    expect(whenOptions(wed16).map((o) => o.label)).toEqual(["17:30 today", "Tomorrow · 09:30", "Next week · Mon 09:30"]);
    expect(whenOptions(sun10).map((o) => o.label)).toEqual(["11:30 today", "This afternoon · 14:00", "Tomorrow · 09:30"]);
  });

  test("Wrap carry from Friday 22:00 is Monday 09:30", () => {
    expect(carrySlot(fri22)).toEqual({ at: mon9_30, label: "mon 09:30 (carried)" });
    expect(carrySlot(wed16).label).toBe("tomorrow 09:30 (carried)");
  });

  test("drawer morning buttons: one Monday from Friday, two midweek", () => {
    expect(morningButtons(fri22)).toEqual([{ label: "mon 09:30", at: mon9_30 }]);
    expect(morningButtons(sun10)).toEqual([{ label: "tomorrow 09:30", at: mon9_30 }]);
    expect(morningButtons(wed16).map((b) => b.label)).toEqual(["tomorrow 09:30", "Monday 09:30"]);
  });

  test("dueOptions' morning push skips the weekend", () => {
    expect(dueOptions(undefined, 2, fri22)[0]).toMatchObject({ label: "Mon 09:30", effect: { at: mon9_30.toISOString() } });
    expect(dueOptions(undefined, 2, sat10)[0]).toMatchObject({ label: "Mon 09:30", effect: { at: mon9_30.toISOString() } });
    expect(dueOptions(undefined, 2, sun10)[0]).toMatchObject({ label: "Tomorrow 09:30", effect: { at: mon9_30.toISOString() } });
  });
});
