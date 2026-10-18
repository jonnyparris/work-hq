import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import type { JournalEntry } from "../src/shared/types.ts";
import { JRow, JournalPage, JournalPanel } from "../src/web/parts.tsx";

const entry = (over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id: "j1", at: "2026-10-16T20:52:00Z", who: "you", text: "Done: thing", synced: true, ...over }) as JournalEntry;

/** Walk an unrendered element tree (no DOM needed) and collect every JRow element. */
function rows(el: unknown, out: ReactElement<any>[] = []): ReactElement<any>[] {
  if (Array.isArray(el)) el.forEach((x) => rows(x, out));
  else if (isValidElement(el)) {
    if (el.type === JRow) out.push(el as ReactElement<any>);
    rows((el.props as any).children, out);
  }
  return out;
}

/** Render a JRow one level deep: its outer <div>. */
const row = (props: Parameters<typeof JRow>[0]) => JRow(props) as ReactElement<any>;

describe("journal rows open their item", () => {
  test("a row with an itemId calls onOpenItem on click and on Enter", () => {
    const opened: string[] = [];
    const el = row({ j: entry({ itemId: "it_x" }), onOpen: (id) => opened.push(id) });
    expect(el.props.role).toBe("button");
    expect(el.props.className).toBe("jr link");
    el.props.onClick();
    el.props.onKeyDown({ key: "Enter", preventDefault() {} });
    el.props.onKeyDown({ key: "a", preventDefault() {} });
    expect(opened).toEqual(["it_x", "it_x"]);
  });

  test("a row without an itemId, or without a handler, is plain text", () => {
    for (const el of [row({ j: entry(), onOpen: () => {} }), row({ j: entry({ itemId: "it_x" }) })]) {
      expect(el.props.className).toBe("jr");
      expect(el.props.onClick).toBeUndefined();
      expect(el.props.role).toBeUndefined();
    }
  });

  test("JournalPanel and JournalPage pass onOpenItem down to every row", () => {
    const onOpen = (_: string) => {};
    const journal = [entry({ itemId: "it_x" }), entry({ id: "j2" })];
    const panel = rows(JournalPanel({ journal, onAll: () => {}, onOpenItem: onOpen }));
    const page = rows(JournalPage({ journal, onOpenItem: onOpen }));
    expect(panel).toHaveLength(2);
    expect(page).toHaveLength(2);
    for (const r of [...panel, ...page]) expect(r.props.onOpen).toBe(onOpen);
  });
});
