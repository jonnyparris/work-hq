import { afterEach, expect, test } from "bun:test";
import { config } from "../src/server/config.ts";
import { template } from "../src/server/prompts.ts";

// 10-19: a plain `open obsidian://…` from a background agent raised Obsidian mid-dictation and a 1-1 note
// landed in a research file. {{openFile}} must tell agents to open notes with `open -g` (no focus steal).

const before = config.workspace.obsidianVault;
afterEach(() => { config.workspace.obsidianVault = before; });

test("default prompts open Obsidian notes with open -g", () => {
  config.workspace.obsidianVault = "my vault";
  for (const name of ["actions/prep", "actions/draft"]) {
    const out = template(name);
    expect(out).toContain('`open -g "obsidian://open?vault=my%20vault&file=');
    expect(out).not.toMatch(/open "obsidian:/);
  }
});

test("no vault: plain open <path>", () => {
  config.workspace.obsidianVault = undefined;
  expect(template("actions/prep")).toContain("`open <path>`");
});
