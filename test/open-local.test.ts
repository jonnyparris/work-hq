import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openableUrl, openLocal } from "../src/server/hub.ts";

test("test setup never lets openLocal reach the real open", () => {
  expect(process.env.WORK_HQ_OPEN_BIN).toBe("/usr/bin/true");
});

test("openableUrl allows web, obsidian and markdown/text files only", () => {
  for (const u of ["https://example.com", "http://localhost:7717", "obsidian://open?vault=x&file=y", "file:///tmp/a.md", "file:///tmp/a.TXT"]) expect(openableUrl(u)).toBe(true);
  for (const u of ["javascript:alert(1)", "file:///etc/passwd", "-a Calculator", "ftp://x", "file:///Applications/Calculator.app"]) expect(openableUrl(u)).toBe(false);
});

test("openLocal runs the open binary with the URL as one argument, and skips unopenable ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whq-open-"));
  const log = join(dir, "argv");
  const bin = join(dir, "open");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`);
  chmodSync(bin, 0o755);
  const prev = process.env.WORK_HQ_OPEN_BIN;
  process.env.WORK_HQ_OPEN_BIN = bin;
  try {
    openLocal("javascript:alert(1)");
    openLocal("https://example.com/a b");
    const read = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    for (let i = 0; i < 100 && !read().endsWith("\n"); i++) await Bun.sleep(20);
    expect(read()).toBe("https://example.com/a b\n");
  } finally {
    if (prev === undefined) delete process.env.WORK_HQ_OPEN_BIN;
    else process.env.WORK_HQ_OPEN_BIN = prev;
  }
});
