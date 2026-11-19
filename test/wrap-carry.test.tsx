import { afterEach, expect, setSystemTime, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { Item } from "../src/shared/types.ts";
import { Wrap } from "../src/web/parts.tsx";
import { api } from "../src/web/store.ts";

const realCarry = api.carry;
afterEach(() => {
  api.carry = realCarry;
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

// 11-06 22:04: Friday's wrap carried three items to Saturday 09:30. 11-12 22:43: three more to an all-day OOO
// Friday, because the browser picked the slot without the calendar. The server picks it now (Hub.carry).
test("Wrap's Carry asks the server for the slot", () => {
  const calls: string[] = [];
  api.carry = async (id) => { calls.push(id); return {}; };
  const it = { id: "it1", title: "Ship it", status: "today" } as Item;
  const carry = find(Wrap({ items: [it] }), "Carry");
  expect(carry).toBeDefined();
  carry!.props.onClick();
  expect(calls).toEqual(["it1"]);
});

test("api.carry POSTs the item's carry route", async () => {
  const realFetch = globalThis.fetch;
  const seen: Array<[string, string | undefined]> = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    seen.push([path, init?.method]);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await realCarry("it1");
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(seen).toEqual([["/api/items/it1/carry", "POST"]]);
});
