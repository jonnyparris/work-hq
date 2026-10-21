import { describe, expect, test } from "bun:test";
import type { Item } from "../src/shared/types.ts";
import { score } from "../src/web/parts.tsx";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const item = (dueDate?: string): Item =>
  ({ id: "i", title: "t", kind: "task", status: "proposed", source: { type: "agent" }, signals: dueDate ? { dueDate } : {} }) as unknown as Item;
const boost = (dueDate?: string) => score(item(dueDate), NOW) - score(item(), NOW);

describe("score due-date boost", () => {
  test("boosts due within the next 7 days", () => {
    expect(boost("2026-10-21")).toBe(2);
    expect(boost("2026-10-26")).toBe(2);
  });
  test("no boost for far-future dates", () => {
    expect(boost("2026-11-15")).toBe(0);
  });
  test("boosts just-missed dates (up to 3 days overdue)", () => {
    expect(boost("2026-10-19")).toBe(2);
    expect(boost("2026-10-18")).toBe(2);
  });
  test("no boost once more than 3 days overdue", () => {
    expect(boost("2026-10-10")).toBe(0);
    expect(boost("2025-01-01")).toBe(0);
  });
  test("bad dates are ignored", () => {
    expect(boost("not-a-date")).toBe(0);
  });
});
