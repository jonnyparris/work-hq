import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cmuxPing } from "../src/server/cmux.ts";

// Fake cmux binaries: the boot probe must settle whatever cmux does.
const dir = mkdtempSync(resolve(tmpdir(), "cmux-ping-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function fakeBin(body: string) {
  const path = resolve(dir, `cmux${n++}`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("a cmux that answers: true", async () => {
  expect(await cmuxPing(2_000, fakeBin("exit 0"))).toBe(true);
});

test("a cmux that errors: false", async () => {
  expect(await cmuxPing(2_000, fakeBin("exit 1"))).toBe(false);
});

test("no binary, or one that isn't there: false", async () => {
  expect(await cmuxPing(2_000, "")).toBe(false);
  expect(await cmuxPing(2_000, "/nonexistent/cmux")).toBe(false);
});

test("a cmux that hangs and ignores SIGTERM: false, on time", async () => {
  const t0 = Date.now();
  expect(await cmuxPing(200, fakeBin("trap '' TERM\nexec sleep 30"))).toBe(false);
  expect(Date.now() - t0).toBeLessThan(2_000);
});
