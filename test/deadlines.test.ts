import { describe, expect, test } from "bun:test";
import { accept, ClairicDeadlines, cueClauses, resolveDue } from "../src/server/deadlines.ts";
import { parseActiveTodos } from "../src/server/parse.ts";

const TUE = new Date(2026, 9, 20); // Tuesday 2026-10-20

describe("resolveDue", () => {
  const cases: Array<[string, string | undefined]> = [
    ["Security review by 30 Oct: owner Ana.", "2026-10-30"],
    ["Publish by 2026-10-26 or delete it.", "2026-10-26"],
    ["Your scorecard, due 10-10, unverified.", "2026-10-10"],
    ["The 'team on the public repo by 10-19' target was missed.", "2026-10-19"],
    ["Get the fix in before Friday's release.", "2026-10-23"],
    ["Need the comment by end of next week so they can plan December.", "2026-10-30"],
    ["Reliability P0, Leo, end of November.", "2026-11-30"],
    ["Get the inventory done before December.", "2026-11-30"],
    ["Ship by Oct 28th.", "2026-10-28"],
    ["Reply by tomorrow.", "2026-10-21"],
    ["Decide by next Monday.", "2026-10-26"],
    ["Close it by the end of the month.", "2026-10-31"],
    ["Plan due by 15 January.", "2027-01-15"],
    // Not deadlines: passive "by", meeting dates, one-to-ones, vague months.
    ["Closed by Omar 10-19.", undefined],
    ["Abe got an overview by DM 10-01.", undefined],
    ["Part II booked Wed 10-21 11:30.", undefined],
    ["Prep for the 1-1 by monitoring the board.", undefined],
    ["Prod target early November after the audit.", undefined],
    ["I'll wait until I go through it with Ana.", undefined],
  ];
  for (const [text, want] of cases) test(text, () => expect(resolveDue(text, TUE)).toBe(want));

  test("first deadline in the text wins", () => {
    expect(resolveDue("Draft by 10-23, ship by 10-30.", TUE)).toBe("2026-10-23");
  });
});

test("to-do lines get dueDate from the new parser, with the old ISO form still working", () => {
  const md = `## Immediate\n\n- [ ] **Security review by 30 Oct.** Owner Ana.\n- [ ] **Launch** — target is end of next week.\n- [ ] **Old style** — by the time we ship, 2026-11-02.\n- [ ] **No date** — filed 10-20.\n`;
  const items = parseActiveTodos(md, "t", [], TUE);
  expect(items.map((i) => i.flags.dueDate)).toEqual(["2026-10-30", "2026-10-30", "2026-11-02", undefined]);
});

test("cueClauses keeps only the clauses that can carry a deadline", () => {
  expect(cueClauses("Filed 10-14. Needs an owner before the offsite. Detail in the log.")).toEqual(["Needs an owner before the offsite."]);
});

describe("accept", () => {
  test("drops a date copied from the clause (a filed / sent date, not a deadline)", () => {
    expect(accept({ value: "2026-10-01", confidence: 0.98 }, "Abe got an overview by DM 10-01", TUE)).toBeUndefined();
  });
  test("drops low confidence and far-off dates", () => {
    expect(accept({ value: "2026-11-03", confidence: 0.6 }, "Send it within two weeks", TUE)).toBeUndefined();
    expect(accept({ value: "2027-09-01", confidence: 0.99 }, "Send it within two weeks", TUE)).toBeUndefined();
  });
  test("keeps a confident relative deadline", () => {
    expect(accept({ value: "2026-11-03", confidence: 0.97 }, "Send it within two weeks", TUE)).toBe("2026-11-03");
  });
});

describe("ClairicDeadlines", () => {
  function fake(answers: Record<string, { value: string | null; confidence: number }>, status = 200) {
    const calls: any[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(status === 200 ? { result: { answers, usage: { input_tokens: 42 } } } : { errors: [{ message: "nope" }] }), { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  test("one batched call over the cue clauses; gated answers; cached per day", async () => {
    const { f, calls } = fake({ d0: { value: "2026-11-03", confidence: 0.99 }, d1: { value: "2026-10-01", confidence: 0.95 } });
    const c = new ClairicDeadlines({ accountId: "acc", token: "tok", fetch: f });
    const texts = [
      { key: "a", text: "Deck. Filed 10-14. Send it within two weeks." },
      { key: "b", text: "Intro. Abe got an overview by DM 10-01." },
      { key: "c", text: "No cue at all here." },
    ];
    const out = await c.fill(texts, TUE);
    expect([...out]).toEqual([["a", "2026-11-03"]]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clairic");
    expect(calls[0].body.reference_date).toBe("2026-10-20");
    expect(Object.keys(calls[0].body.fields)).toEqual(["d0", "d1"]);
    expect(calls[0].body.state).toContain("Item 0: Send it within two weeks.");
    expect(calls[0].body.state).not.toContain("Filed 10-14");

    const again = await c.fill(texts, TUE);
    expect([...again]).toEqual([["a", "2026-11-03"]]);
    expect(calls).toHaveLength(1);
  });

  test("a failed call returns nothing and records the error", async () => {
    const { f } = fake({}, 403);
    const c = new ClairicDeadlines({ accountId: "acc", token: "tok", fetch: f });
    const out = await c.fill([{ key: "a", text: "Send it within two weeks." }], TUE);
    expect(out.size).toBe(0);
    expect(c.lastError).toContain("403");
  });
});

test("bin/work-hq config masks every token, not just memory.token", async () => {
  const { maskSecrets } = await import("../src/cli/config.ts");
  expect(maskSecrets({ memory: { token: "a" }, deadlines: { clairic: { token: "b", accountId: "c" } }, pi: { gatewayToken: { env: "X", command: "y" } } })).toEqual({
    memory: { token: "••••" },
    deadlines: { clairic: { token: "••••", accountId: "c" } },
    pi: { gatewayToken: { env: "X", command: "y" } },
  });
});
