import { afterEach, expect, setSystemTime, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { Item } from "../src/shared/types.ts";
import { Wrap } from "../src/web/parts.tsx";
import { api } from "../src/web/store.ts";

const realSchedule = api.schedule;
afterEach(() => {
  api.schedule = realSchedule;
  setSystemTime();
});

/** Depth-first: the first element whose children are exactly `text`. */
function find(node: ReactNode, text: string): ReactElement<{ onClick: () => unknown }> | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, text);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const props = node.props as { children?: ReactNode };
  if (props.children === text) return node as ReactElement<{ onClick: () => unknown }>;
  return find(props.children, text);
}

// 11-06 22:04: Friday's wrap carried three items to Saturday 09:30.
test("Wrap's Carry on Friday 22:00 schedules Monday 09:30, labelled once", () => {
  setSystemTime(new Date(2026, 10, 6, 22, 0));
  const calls: Array<[string, string, string | undefined]> = [];
  api.schedule = async (id, at, label) => { calls.push([id, at, label]); return undefined as never; };
  const it = { id: "it1", title: "Ship it", status: "today" } as Item;
  const carry = find(Wrap({ items: [it] }), "Carry");
  expect(carry).toBeDefined();
  carry!.props.onClick();
  expect(calls).toEqual([["it1", new Date(2026, 10, 9, 9, 30).toISOString(), "mon 09:30 (carried)"]]);
});
