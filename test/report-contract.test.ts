import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { IDEA_CAP } from "../src/shared/ideas.ts";
import { IDEA_RULE, REPORT_CONTRACT, REPORT_HELP } from "../src/server/prompts.ts";

const WHQ = resolve(import.meta.dir, "../bin/whq");

describe("report contract", () => {
  test("the short form keeps the rules agents get wrong without it", () => {
    const c = REPORT_CONTRACT("job_x");
    expect(c).toContain("bin/whq report job_x <<'JSON'");
    expect(c).toContain("report --help");
    expect(c).toContain('"key": "stable-dedupe-key"');
    expect(c).toContain("Could also:");
    expect(c).toContain('needs action "work" + note');
    expect(c).toContain(IDEA_RULE);
    expect(REPORT_HELP).toContain(IDEA_RULE);
    expect(IDEA_RULE).toContain("defect in code you touched");
    expect(IDEA_RULE).toContain(`Unless the note asks for ideas, Work HQ files at most ${IDEA_CAP} new idea items`);
    expect(c).toContain('"progress" reports welcome');
  });

  test("whq report --help prints the full schema; a missing job id fails", () => {
    for (const flag of ["--help", "-h"]) {
      const r = Bun.spawnSync([WHQ, "report", flag]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain('"key": "stable-dedupe-key"');
    }
    const help = Bun.spawnSync([WHQ, "report", "--help"]);
    expect(help.stdout.toString()).toContain(REPORT_HELP.split("\n")[0]!);
    expect(help.stdout.toString()).toContain('"key": "stable-dedupe-key"');
    for (const args of [[], ["-x"]]) {
      const bad = Bun.spawnSync([WHQ, "report", ...args], { stdin: "ignore" });
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr.toString()).toContain("usage: whq report <jobId>");
    }
  });
});
