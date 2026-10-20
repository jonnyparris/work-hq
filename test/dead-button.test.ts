// "Yes, dispatch" that does nothing. Two layers:
// 1. Static: walk every option literal in the server and fail on an affirmative label with a noop effect.
// 2. Runtime: hub.ask() journals a "Dead button" line the moment such a card is asked.
import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { AFFIRMATIVE, deadOptions, doesNothing, ROUTE_HANDLED } from "../src/shared/dead-button.ts";

const SERVER = join(import.meta.dir, "../src/server");
const routeIds = new Set(Object.values(ROUTE_HANDLED).flat());

/** Lines with `type: "noop"` that aren't an option literal. Anything else must parse as one. */
const NOT_AN_OPTION = [
  /case "noop":/, // applyEffect
  /^\s*return \{ type: "noop" \};/, // effectFromLabel fallback (agent strings; caught at runtime)
  /^\s*\{ type: "noop" \}, \/\/ keeps the/, // inside a multi next to a real effect
  /const effect = typeof o === "string"/, // ingestReport maps agent options (agentStringEffect for strings and label-only objects)
];

interface Found { file: string; line: number; id: string; label: string }

function walk(): { found: Found[]; unparsed: string[] } {
  const found: Found[] = [];
  const unparsed: string[] = [];
  for (const f of readdirSync(SERVER).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(SERVER, f), "utf8");
    const consts = new Map([...src.matchAll(/const (\w+) = "([^"]+)";/g)].map((m) => [m[1]!, m[2]!]));
    const str = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : consts.get(s));
    src.split("\n").forEach((text, i) => {
      if (!/type: "noop"/.test(text) || NOT_AN_OPTION.some((r) => r.test(text))) return;
      // opt("id", "label" | CONST, { type: "noop" } ...)
      const a = text.match(/opt\("([^"]+)",\s*("[^"]*"|\w+),\s*\{ type: "noop"/);
      // { id: "x", label: "y" | CONST, ... effect: { type: "noop" ... } }
      const b = text.match(/id: "([^"]+)",\s*label: ("[^"]*"|\w+),.*effect: \{ type: "noop"/);
      const m = a ?? b;
      const label = m ? str(m[2]!) : undefined;
      if (!m || label === undefined) unparsed.push(`${f}:${i + 1}: ${text.trim()}`);
      else found.push({ file: f, line: i + 1, id: m[1]!, label });
    });
  }
  return { found, unparsed };
}

describe("dead buttons", () => {
  test("no affirmative-labelled option literal in the server has a noop effect", () => {
    const { found, unparsed } = walk();
    // A noop line the walker can't read is a gap, not a pass: extend the walker or NOT_AN_OPTION.
    expect(unparsed).toEqual([]);
    // Not vacuous: prompter + agents have a dozen-odd noop options today.
    expect(found.length).toBeGreaterThanOrEqual(10);
    const dead = found.filter((o) => AFFIRMATIVE.test(o.label) && !routeIds.has(o.id)).map((o) => `${o.file}:${o.line} "${o.label}"`);
    expect(dead).toEqual([]);
  });

  test("deadOptions: noop and all-noop multi count; real effects and route-handled ids don't", () => {
    const o = (id: string, label: string, effect: any) => ({ id, label, effect });
    const q = {
      kind: "open" as const,
      options: [
        o("a", "Yes, dispatch", { type: "noop" }),
        o("b", "Send it", { type: "multi", effects: [{ type: "noop" }] }),
        o("c", "Yes, research it", { type: "multi", effects: [{ type: "noop" }, { type: "triage", text: "x", mode: "chat" }] }),
        o("d", "Draft it", { type: "dispatch", action: "draft" }),
        o("e", "Not now", { type: "noop" }),
        o("look", "Yes, show me the session", { type: "noop" }),
      ],
    };
    expect(deadOptions(q).map((x) => x.id)).toEqual(["a", "b"]);
    expect(deadOptions({ kind: "plan", options: [o("plan", "Yes, commit", { type: "noop" })] })).toEqual([]);
    expect(deadOptions({ kind: "open", options: [o("plan", "Yes, commit", { type: "noop" })] })).toHaveLength(1);
    expect(doesNothing({ type: "multi", effects: [] })).toBe(true);
  });

  test("hub.ask journals a dead button when asked, not after a tap", () => {
    const hub = new Hub(new Store(":memory:"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const q = hub.ask({
      kind: "open",
      key: "t:1",
      priority: 50,
      prompt: "Want an agent to find both?",
      options: [
        { id: "y", label: "Yes, dispatch", effect: { type: "noop" } },
        { id: "n", label: "No", effect: { type: "noop" } },
      ],
    });
    expect(q).toBeDefined(); // warn only: the card still shows
    const lines = hub.store.journal(10).filter((j) => j.text.startsWith("Dead button"));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("“Yes, dispatch”");
    expect(lines[0]!.who).toBe("hq");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("a healthy card writes nothing", () => {
    const hub = new Hub(new Store(":memory:"));
    hub.ask({ kind: "open", key: "t:2", priority: 50, prompt: "Ship?", options: [{ id: "y", label: "Yes", effect: { type: "dispatch", action: "work" } }] });
    expect(hub.store.journal(10).filter((j) => j.text.startsWith("Dead button"))).toHaveLength(0);
  });

  // A label-only object ({ label: "Yes, send it" }) used to be a noop the runtime guard flagged.
  // It now maps like the same string; an explicit url/action/status still wins.
  test("agent object options with only a label map like strings; explicit effects win", () => {
    const hub = new Hub(new Store(":memory:"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const it = hub.createItem({ title: "thing", status: "proposed" });
    hub.ingestReport({
      questions: [
        { prompt: "Want me to send the summary?", itemId: it.id, options: [{ label: "Yes, send it" }, { label: "No, leave it" }, { label: "Mark done" }, { label: "Yes", status: "waiting" }] as any },
        { prompt: "Research the vendor?", options: [{ label: "Research it" }, { label: "Not now" }] as any },
      ],
    });
    const qs = hub.store.questions("open");
    const eff = (p: string) => qs.find((q) => q.prompt === p)!.options.map((o) => o.effect);
    expect(eff("Want me to send the summary?")).toEqual([
      { type: "dispatch", action: "work", note: "Agent asked: Want me to send the summary?\nThey answered: Yes, send it" },
      { type: "noop" },
      { type: "status", status: "done" },
      { type: "status", status: "waiting" },
    ]);
    expect(eff("Research the vendor?")).toEqual([
      { type: "triage", text: "Agent asked: Research the vendor?\nThey answered: Research it", mode: "chat" },
      { type: "noop" },
    ]);
    expect(hub.store.journal(50).filter((j) => j.text.startsWith("Dead button"))).toEqual([]);
    warn.mockRestore();
  });

  // The string path used to fall through effectFromLabel to noop: "Yes", "Send it", the bare
  // Yes/No default. Now an item dispatches work with the question; no item re-runs triage.
  test("agent string options: affirmative labels start something, nothing is flagged", () => {
    const hub = new Hub(new Store(":memory:"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const it = hub.createItem({ title: "thing", status: "proposed" });
    hub.ingestReport({
      questions: [
        { prompt: "Want me to send the summary?", itemId: it.id, options: ["Yes, send it", "Verify it first", "No, don't send it", "Mark done"] },
        { prompt: "Shall I chase it?", itemId: it.id },
        { prompt: "Research the vendor?", options: ["Research it", "Not now"] },
      ],
    });
    const qs = hub.store.questions("open");
    const eff = (p: string) => qs.find((q) => q.prompt === p)!.options.map((o) => o.effect);
    expect(eff("Want me to send the summary?")).toEqual([
      { type: "dispatch", action: "work", note: "Agent asked: Want me to send the summary?\nThey answered: Yes, send it" },
      { type: "dispatch", action: "verify", note: "Agent asked: Want me to send the summary?\nThey answered: Verify it first" },
      { type: "noop" },
      { type: "status", status: "done" },
    ]);
    expect(eff("Shall I chase it?")).toEqual([
      { type: "dispatch", action: "work", note: "Agent asked: Shall I chase it?\nThey answered: Yes" },
      { type: "noop" },
    ]);
    expect(eff("Research the vendor?")).toEqual([
      { type: "triage", text: "Agent asked: Research the vendor?\nThey answered: Research it", mode: "chat" },
      { type: "noop" },
    ]);
    expect(hub.store.journal(50).filter((j) => j.text.startsWith("Dead button"))).toEqual([]);
    warn.mockRestore();
  });

  test("tapping an agent's 'Yes' dispatches with the question, plus anything typed", async () => {
    const hub = new Hub(new Store(":memory:"));
    const calls: Array<[string, string, string | undefined]> = [];
    hub.dispatcher = { dispatch: async (id: string, a: string, n?: string) => void calls.push([id, a, n]) } as any;
    const it = hub.createItem({ title: "thing", status: "proposed" });
    hub.ingestReport({ questions: [{ prompt: "Send the summary?", itemId: it.id, options: ["Yes", "No"] }] });
    const [q] = hub.store.questions("open");
    await hub.answer(q!.id, "o0", "only to Ana");
    expect(calls).toEqual([[it.id, "work", "Agent asked: Send the summary?\nThey answered: Yes\nThey added: only to Ana"]]);
  });
});
