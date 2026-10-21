import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Item } from "../src/shared/types.ts";
import { Board, TodayPanel } from "../src/web/parts.tsx";

const item = (id: string, status: Item["status"], title: string): Item =>
  ({ id, status, title, kind: "task", source: { type: "voice" }, createdAt: "2026-10-21T09:00:00Z", updatedAt: new Date().toISOString() }) as Item;

const items = [item("a", "today", "Commit one"), item("b", "done", "Commit two"), item("c", "inbox", "Captured thing"), item("d", "proposed", "Proposed thing"), item("e", "waiting", "Waiting thing")];

describe("Committed and the status lists start folded", () => {
  test("Committed shows a header with the count, not the list or the add box", () => {
    const html = renderToStaticMarkup(<TodayPanel items={items} onOpen={() => {}} />);
    expect(html).toContain("Committed");
    expect(html).toContain(">1<");
    expect(html).toContain("1 done today");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("folded");
    expect(html).not.toContain("Commit one");
    expect(html).not.toContain("Add a commitment");
  });

  test("the status lists show every tab with its count, no tab selected, no rows or filter", () => {
    const html = renderToStaticMarkup(<Board items={items} onOpen={() => {}} />);
    for (const l of ["Captured", "Proposed", "Scheduled", "Waiting", "Closed"]) expect(html).toContain(l);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("lane-tab on");
    expect(html).not.toContain("Captured thing");
    expect(html).not.toContain("Filter…");
  });
});
