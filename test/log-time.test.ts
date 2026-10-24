import { expect, test } from "bun:test";
import { stampConsole } from "../src/server/log-time.ts";

function fake() {
  const lines: unknown[][] = [];
  const push = (...a: unknown[]) => void lines.push(a);
  const c = { log: push, info: push, warn: push, error: push, debug: push } as unknown as Console;
  return { c, lines };
}
const at = () => new Date("2026-10-23T09:15:00.000Z");

test("every console line gets an ISO time; leading newlines stay in front", () => {
  const { c, lines } = fake();
  stampConsole(c, at);
  c.log("\n  ◆ Work HQ");
  c.error("[memory]", "boom");
  c.warn({ a: 1 });
  expect(lines).toEqual([
    ["\n[2026-10-23T09:15:00.000Z]   ◆ Work HQ"],
    ["[2026-10-23T09:15:00.000Z] [memory]", "boom"],
    ["[2026-10-23T09:15:00.000Z]", { a: 1 }],
  ]);
});

test("stamping twice (bun --hot) doesn't double the stamp", () => {
  const { c, lines } = fake();
  stampConsole(c, at);
  stampConsole(c, at);
  c.log("hi");
  expect(lines).toEqual([["[2026-10-23T09:15:00.000Z] hi"]]);
});
