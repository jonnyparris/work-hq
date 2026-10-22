import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoadNow } from "../src/shared/types.ts";
import { AgentsPanel } from "../src/web/parts.tsx";

const load = (l1: number, max = 0): LoadNow => ({ at: new Date().toISOString(), l1, l5: 3, l15: 2, cores: 12, jobs: 4, max });

test("the Agents header shows the latest load, gold above the core count, coral and 'holding' above pi.maxLoad", () => {
  const calm = renderToStaticMarkup(<AgentsPanel jobs={[]} cmux load={load(4.26)} />);
  expect(calm).toContain("load 4.3");
  expect(calm).toContain("var(--text-3)");
  expect(calm).toContain("on 12 cores, 4 agents running");
  const busy = renderToStaticMarkup(<AgentsPanel jobs={[]} cmux load={load(20, 40)} />);
  expect(busy).toContain("var(--gold)");
  expect(busy).not.toContain("holding");
  expect(busy).toContain("above 40");
  const held = renderToStaticMarkup(<AgentsPanel jobs={[]} cmux load={load(55, 40)} />);
  expect(held).toContain("load 55.0 · holding");
  expect(held).toContain("var(--coral)");
  expect(renderToStaticMarkup(<AgentsPanel jobs={[]} cmux />)).not.toContain("load ");
});
