import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { notePrompt } from "../src/server/prompts.ts";
import type { Item, NoteDecision, Question } from "../src/shared/types.ts";

// 10-13 23:28Z: "Maybe we just publish to Agent Relay for our team actually" on a blog card's question.
// The reader matched the word "publish" to the "Publish…" option, and a wiki + site publish job ran.
// The owner retyped it half an hour later. A note that moves the target must dispatch, not pick.

const post = {
  id: "it_eval_post",
  title: "GitLab said Merged. Main disagreed.",
  kind: "post",
  status: "proposed",
  source: { type: "agent", label: "Writing scout" },
  detail: "Four MRs showed Merged in GitLab while none of their commits were on main. The fix is a check that treats Merged as a claim to verify.",
  post: { venue: "both", why: "shared tooling others can reuse" },
} as unknown as Item;

const postQuestion = {
  id: "q_eval_post",
  kind: "post",
  itemId: post.id,
  prompt: "GitLab said Merged. Main disagreed.",
  context: "**internal wiki + personal site** — shared tooling others can reuse, and credit to the engineer who caught it.",
  priority: 50,
  options: [
    { id: "read", label: "Open draft", effect: { type: "open", url: "obsidian://x", keep: true } },
    { id: "publish", label: "Publish…", effect: { type: "dispatch", action: "publish" } },
    { id: "revise", label: "Revise (use the note)", effect: { type: "dispatch", action: "draft" } },
    { id: "when", label: "Scheduled for…", effect: { type: "when" } },
    { id: "no", label: "Not for me", effect: { type: "status", status: "dropped" } },
  ],
} as unknown as Question;

const venueNotes = [
  "Maybe we just publish to Agent Relay for our team actually",
  "Let's just share this in Agent Relay instead. I don't think we need to publish it.",
  "post it to the team space, not the wiki",
];

const now = new Date(2026, 9, 14, 0, 28);

describe("note reader prompt: change of venue", () => {
  const p = notePrompt(postQuestion, post, venueNotes[0]!, { now });

  test("has a venue-change rule that comes before matching an option", () => {
    const venue = p.indexOf("The note moves the target");
    expect(venue).toBeGreaterThan(-1);
    expect(venue).toBeLessThan(p.indexOf("1. The note clearly matches an option"));
    expect(p).toContain("never \"pick\"");
  });

  test("no longer offers \"publish it to Y\" as an example of picking an option", () => {
    expect(p).not.toContain("publish it to Y");
    expect(p).toContain("right action to the same target");
  });
});

// Live eval against the real model. Opt-in: WHQ_EVAL=1 bun test test/note-reader.test.ts
const live = process.env.WHQ_EVAL === "1";
describe.if(live)("note reader eval (live model)", () => {
  for (const note of venueNotes) {
    test(`"${note}" → dispatch reply/work, not the Publish option`, () => {
      const prompt = notePrompt(postQuestion, post, note, { now });
      const model = process.env.WORK_HQ_MODEL ? ["--model", process.env.WORK_HQ_MODEL] : [];
      const r = spawnSync(process.env.WORK_HQ_PI ?? `${process.env.HOME}/.local/bin/pi`, ["-p", ...model, "--thinking", "low", "-nt", "-nc", "-ns", "-np", "--no-session", prompt], {
        encoding: "utf8",
        timeout: 180_000,
      });
      const m = /\{[\s\S]*\}/.exec(r.stdout ?? "");
      if (!m) throw new Error(`no JSON from pi: ${r.error ?? ""} ${r.stderr ?? ""}`.slice(0, 500));
      const d = JSON.parse(m![0]) as NoteDecision;
      expect(d.pick).not.toBe("publish");
      expect(["reply", "work"]).toContain(d.dispatch?.action ?? "");
      expect(d.dispatch?.note ?? "").toMatch(/relay|team space|team/i);
    }, 200_000);
  }
});
