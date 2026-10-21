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

const killItem = (killDate?: string): Item =>
  ({ id: "i", title: "t", kind: "task", status: "proposed", source: { type: "agent" }, signals: killDate ? { killDate } : {} }) as unknown as Item;
const killBoost = (killDate?: string) => score(killItem(killDate), NOW) - score(killItem(), NOW);

describe("score kill-date boost", () => {
  test("boosts kill dates within the next 3 days", () => {
    expect(killBoost("2026-10-21")).toBe(3);
    expect(killBoost("2026-10-23")).toBe(3);
  });
  test("no boost for kill dates further out", () => {
    expect(killBoost("2026-10-30")).toBe(0);
  });
  test("boosts just-passed kill dates (up to 3 days)", () => {
    expect(killBoost("2026-10-19")).toBe(3);
    expect(killBoost("2026-10-18")).toBe(3);
  });
  test("no boost once more than 3 days past", () => {
    expect(killBoost("2026-10-10")).toBe(0);
    expect(killBoost("2025-01-01")).toBe(0);
  });
  test("bad dates are ignored", () => {
    expect(killBoost("not-a-date")).toBe(0);
  });
});
