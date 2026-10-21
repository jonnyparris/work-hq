// "Yes, dispatch" that does nothing. Two layers:
// 1. Static: walk every option literal in the server and fail on an affirmative label with a noop effect.
// 2. Runtime: hub.ask() journals a "Dead button" line the moment such a card is asked.
import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { AFFIRMATIVE, deadOptions, doesNothing } from "../src/shared/dead-button.ts";

const SERVER = join(import.meta.dir, "../src/server");

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
    // Not vacuous: prompter + agents still have a handful of noop options ("Nothing new", "Not now").
    expect(found.length).toBeGreaterThanOrEqual(5);
    const dead = found.filter((o) => AFFIRMATIVE.test(o.label)).map((o) => `${o.file}:${o.line} "${o.label}"`);
    expect(dead).toEqual([]);
  });

  test("deadOptions: noop and all-noop multi count; real effects don't, and no option id is exempt", () => {
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
        o("look2", "Yes, show me the session", { type: "focusSession" }),
      ],
    };
    expect(deadOptions(q).map((x) => x.id)).toEqual(["a", "b", "look"]);
    expect(deadOptions({ options: [o("plan", "Yes, commit", { type: "noop" })] })).toHaveLength(1);
    expect(deadOptions({ options: [o("plan", "Yes, commit", { type: "commitPlan" })] })).toEqual([]);
    expect(doesNothing({ type: "multi", effects: [] })).toBe(true);
  });

  test("hub.ask journals a dead button when asked, not after a tap", () => {
    const hub = new Hub(new Store(":memory:"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const toasts: { text: string; tone?: string }[] = [];
    hub.subscribe((e) => e.type === "toast" && toasts.push(e.data));
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
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.tone).toBe("warn");
    expect(toasts[0]!.text).toContain("“Yes, dispatch”");
    warn.mockRestore();
  });

  test("a healthy card writes nothing", () => {
    const hub = new Hub(new Store(":memory:"));
    const toasts: unknown[] = [];
    hub.subscribe((e) => e.type === "toast" && toasts.push(e));
    hub.ask({ kind: "open", key: "t:2", priority: 50, prompt: "Ship?", options: [{ id: "y", label: "Yes", effect: { type: "dispatch", action: "work" } }] });
    expect(hub.store.journal(10).filter((j) => j.text.startsWith("Dead button"))).toHaveLength(0);
    expect(toasts).toHaveLength(0);
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

  // whq report prints these, so an agent sees a dead or remapped button in the same run, not when the owner taps it.
  test("ingestReport echoes each question's option effects; a duplicate says it wasn't asked", () => {
    const hub = new Hub(new Store(":memory:"));
    const it = hub.createItem({ title: "thing", status: "proposed" });
    const r = { questions: [{ prompt: "Send the summary?", itemId: it.id, options: ["Yes, send it", "Not now", "Mark done"] }, { prompt: "Ticket it?", itemId: it.id, options: [{ label: "File it", action: "ticket" }] as any }] };
    expect(hub.ingestReport(r).questions).toEqual([
      { prompt: "Send the summary?", asked: true, options: ["Yes, send it → dispatch work", "Not now → noop (does nothing)", "Mark done → status done"] },
      { prompt: "Ticket it?", asked: true, options: ["File it → dispatch ticket"] },
    ]);
    expect(hub.ingestReport({ questions: [r.questions[0]!] }).questions).toEqual([{ prompt: "Send the summary?", asked: false, options: [] }]);
    expect(hub.ingestReport({ journal: ["x"] }).questions).toBeUndefined();
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

  // plan/flush/scan/look used to be noop options the answer route special-cased by id
  // (ROUTE_HANDLED, "keep in step with that route"). Now they are Effect types; tapping one
  // through hub.answer does the work with no route code, and so does a note that picks it.
  describe("former route-handled options are real effects", () => {
    const setup = () => {
      const hub = new Hub(new Store(":memory:"));
      const calls: string[] = [];
      hub.dispatcher = {
        dispatch: async () => undefined,
        scheduleFromWords: async () => {},
        sweep: async (n: string) => void calls.push(`sweep:${n}`),
        focus: (id: string) => void calls.push(`focus:${id}`),
      };
      hub.journalFlusher = async () => void calls.push("flush");
      return { hub, calls };
    };
    const ask = (hub: Hub, kind: any, id: string, effect: any) =>
      hub.ask({ kind, key: `k:${kind}:${id}`, priority: 50, prompt: `${kind}?`, options: [{ id, label: "Go", effect }] })!;

    test("commitPlan puts the picked items on today and journals the answer", async () => {
      const { hub } = setup();
      const a = hub.createItem({ title: "a", status: "proposed" });
      const b = hub.createItem({ title: "b", status: "proposed" });
      const q = ask(hub, "plan", "plan", { type: "commitPlan" });
      await hub.answer(q.id, "plan", undefined, { itemIds: [a.id] });
      expect(hub.store.item(a.id)!.status).toBe("today");
      expect(hub.store.item(b.id)!.status).toBe("proposed");
      expect(hub.store.journal(20).some((j) => j.text === "plan? → Go")).toBe(true);
    });

    test("flushJournal and sweep run their jobs", async () => {
      const { hub, calls } = setup();
      await hub.answer(ask(hub, "wrap", "flush", { type: "flushJournal" }).id, "flush");
      await hub.answer(ask(hub, "review", "scan", { type: "sweep", name: "transcripts" }).id, "scan");
      expect(calls).toEqual(["flush", "sweep:transcripts"]);
    });

    test("focusSession focuses the item's job workspace, or says it was closed", async () => {
      const { hub, calls } = setup();
      const toasts: string[] = [];
      hub.subscribe((e) => e.type === "toast" && void toasts.push((e.data as any).text));
      const it = hub.createItem({ title: "x", status: "doing" });
      hub.store.putJob({ id: "j1", kind: "action", name: "work", title: "x", itemId: it.id, workspace: "ws:1", status: "done", tail: [], createdAt: new Date().toISOString() } as any);
      const q = hub.ask({ kind: "open", itemId: it.id, key: "after:j1", priority: 50, prompt: "Done?", options: [{ id: "look", label: "Show me the session", effect: { type: "focusSession" } }] })!;
      await hub.answer(q.id, "look");
      expect(calls).toEqual(["focus:j1"]);
      const other = hub.createItem({ title: "y", status: "doing" });
      const q2 = hub.ask({ kind: "open", itemId: other.id, key: "after:j2", priority: 50, prompt: "Done?", options: [{ id: "look", label: "Show me the session", effect: { type: "focusSession" } }] })!;
      await hub.answer(q2.id, "look");
      expect(toasts.some((t) => t.includes("session was closed"))).toBe(true);
    });

    test("'Show me the session' with keep leaves the card open and the item on doing (10-19 kitesurf-oss!3)", async () => {
      const { hub, calls } = setup();
      const it = hub.createItem({ title: "rebuild", status: "doing" });
      hub.store.putJob({ id: "j1", kind: "action", name: "work", title: "x", itemId: it.id, workspace: "ws:1", status: "failed", tail: [], createdAt: new Date().toISOString() } as any);
      const q = hub.ask({ kind: "state", itemId: it.id, key: "after:j1", priority: 75, prompt: "Agent stopped", options: [
        { id: "done", label: "Done", effect: { type: "status", status: "done" } },
        { id: "look", label: "Show me the session", effect: { type: "focusSession", keep: true } },
      ] })!;
      await hub.answer(q.id, "look");
      expect(calls).toEqual(["focus:j1"]);
      const open = hub.store.questions("open").filter((x) => x.key === "after:j1");
      expect(open).toHaveLength(1);
      await hub.answer(open[0]!.id, "done");
      expect(hub.store.item(it.id)!.status).toBe("done");
    });

    test("a pre-10-21 focusSession card gets keep on load", () => {
      const store = new Store(":memory:");
      store.putQuestion({ id: "a", kind: "state", key: "after:j", priority: 1, prompt: "a", status: "open", createdAt: new Date().toISOString(),
        options: [{ id: "look", label: "look", effect: { type: "focusSession" } }] });
      (store as any).upgradeRouteEffects();
      expect(store.question("a")!.options[0]!.effect).toEqual({ type: "focusSession", keep: true });
    });

    test("an open card asked before the change gets its noop upgraded on load", () => {
      const store = new Store(":memory:");
      const now = new Date().toISOString();
      const card = (id: string, kind: any, opts: [string, any][]) =>
        store.putQuestion({ id, kind, key: id, priority: 1, prompt: id, status: "open", createdAt: now, options: opts.map(([oid, effect]) => ({ id: oid, label: oid, effect })) });
      card("p", "plan", [["plan", { type: "noop" }], ["later", { type: "snooze", minutes: 30 }]]);
      card("w", "wrap", [["flush", { type: "noop" }]]);
      card("r", "review", [["scan", { type: "noop" }], ["none", { type: "noop" }]]);
      card("o", "open", [["look", { type: "noop" }], ["plan", { type: "noop" }]]);
      (store as any).upgradeRouteEffects();
      const eff = (id: string) => store.question(id)!.options.map((o) => o.effect);
      expect(eff("p")).toEqual([{ type: "commitPlan" }, { type: "snooze", minutes: 30 }]);
      expect(eff("w")).toEqual([{ type: "flushJournal" }]);
      expect(eff("r")).toEqual([{ type: "sweep", name: "transcripts" }, { type: "noop" }]);
      expect(eff("o")).toEqual([{ type: "focusSession", keep: true }, { type: "noop" }]); // "plan" only means commit on a plan card
    });
  });
});
