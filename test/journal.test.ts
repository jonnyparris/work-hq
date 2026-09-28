import { expect, test } from "bun:test";
import { mergeJournal, JOURNAL_HEADER } from "../src/server/memory-sync.ts";
import type { JournalEntry } from "../src/shared/types.ts";

const e = (at: string, text: string): JournalEntry => ({ id: at, at, text, who: "you", synced: false });

test("merges into day sections, newest day first", () => {
  const first = mergeJournal("", [e("2026-09-24T10:00:00", "a"), e("2026-09-25T09:00:00", "b")], () => undefined);
  expect(first.body.startsWith(JOURNAL_HEADER)).toBe(true);
  expect(first.body.indexOf("## 2026-09-25")).toBeLessThan(first.body.indexOf("## 2026-09-24"));
  const second = mergeJournal(first.body, [e("2026-09-25T11:30:00", "c")], () => undefined);
  const day = second.body.split("## 2026-09-25")[1]!.split("## ")[0]!;
  expect(day).toContain("09:00 · you · b");
  expect(day).toContain("11:30 · you · c");
  expect(second.overflow).toBeUndefined();
});

test("spills oldest days when too big", () => {
  const many: JournalEntry[] = [];
  for (let d = 1; d <= 20; d++)
    for (let i = 0; i < 20; i++) many.push(e(`2026-09-${String(d).padStart(2, "0")}T10:${String(i).padStart(2, "0")}:00`, "x".repeat(80)));
  const out = mergeJournal("", many, () => undefined);
  expect(new TextEncoder().encode(out.body).length).toBeLessThanOrEqual(20_000);
  expect(out.overflow).toContain("## 2026-09-01");
  expect(out.body).toContain("## 2026-09-20");
});
