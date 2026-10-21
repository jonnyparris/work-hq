import { describe, expect, test } from "bun:test";
import { blocks, detailBlocks, explainKey, sentences } from "../src/shared/detail.ts";

// The drawer's "Why this exists" ran newlines, lists and long agent prose together into one block.
describe("blocks", () => {
  test("paragraphs, line breaks, lists and headings", () => {
    expect(blocks("**Problem**: three people edit it.\n**Solution**: name an owner.\n\n- one\n- two\n  wrapped\n1. first\n2) second\n# Heading")).toEqual([
      { type: "p", lines: ["**Problem**: three people edit it.", "**Solution**: name an owner."] },
      { type: "ul", items: ["one", "two wrapped"] },
      { type: "ol", items: ["first", "second"] },
      { type: "h", text: "Heading" },
    ]);
  });
  test("plain text is one paragraph", () => {
    expect(blocks("just a line")).toEqual([{ type: "p", lines: ["just a line"] }]);
  });
});

describe("sentences", () => {
  test("splits at sentence ends, not abbreviations, versions, file names or brackets", () => {
    expect(sentences("Add a file variant (e.g. OPENCODE_CF_TOKEN_FILE, read on every resolve). Then v0.1 ships. See gateway-token.ts and pi 1.2.3 for it. Done!")).toEqual([
      "Add a file variant (e.g. OPENCODE_CF_TOKEN_FILE, read on every resolve).",
      "Then v0.1 ships.",
      "See gateway-token.ts and pi 1.2.3 for it.",
      "Done!",
    ]);
  });
  test("no split inside a code span", () => {
    expect(sentences("Run `a. B` now. Next one.")).toEqual(["Run `a. B` now.", "Next one."]);
  });
});

describe("detailBlocks", () => {
  const prose = "Checked 10-20 07:35 against the jobs table. Since then 0 sweep jobs ran. Only triage and action jobs have run. The last sweep is still the transcripts one, done 10-19 17:40Z, and the first sweep under the fix should run soon after 08:00 local time, once work hours start.";
  test("long prose: lead sentence + bullets", () => {
    expect(detailBlocks(prose)).toEqual([
      { type: "p", lines: ["Checked 10-20 07:35 against the jobs table."] },
      { type: "ul", items: ["Since then 0 sweep jobs ran.", "Only triage and action jobs have run.", "The last sweep is still the transcripts one, done 10-19 17:40Z, and the first sweep under the fix should run soon after 08:00 local time, once work hours start."] },
    ]);
  });
  test("short or already-structured text is left alone", () => {
    expect(detailBlocks("One thing. Two things. Three.")).toEqual([{ type: "p", lines: ["One thing. Two things. Three."] }]);
    expect(detailBlocks(`${prose}\nSecond line.`)[0]!.type).toBe("p");
    expect(detailBlocks(`${prose}\nSecond line.`)).toHaveLength(1);
  });
});

test("explainKey changes with title, detail or quote", () => {
  const base = { title: "T", detail: "D", source: { quote: "Q" } };
  const k = explainKey(base);
  expect(explainKey({ ...base })).toBe(k);
  expect(explainKey({ ...base, title: "T2" })).not.toBe(k);
  expect(explainKey({ ...base, detail: "D2" })).not.toBe(k);
  expect(explainKey({ ...base, source: { quote: "Q2" } })).not.toBe(k);
});
