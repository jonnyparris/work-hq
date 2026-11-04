import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { Prompter, staleCard as buildStaleCard, workdaysAgo } from "../src/server/prompter.ts";
import { notePrompt } from "../src/server/prompts.ts";
import type { Question } from "../src/shared/types.ts";

// 11-01: 15 open cards against a cap of 14, 8 of them over 3 workdays old. tick() returned at `budget <= 0`
// before the proposal block, and no proposal was asked for a week.

let hub: Hub;
let p: Prompter;
beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
  p = new Prompter(hub);
});

// Wednesday 2026-09-23, 15:00 local. 3 workdays back is Friday 09-18, 15:00.
const now = new Date(2026, 8, 23, 15, 0);
const fresh = new Date(2026, 8, 23, 14, 0).toISOString();
const old = new Date(2026, 8, 17, 10, 0).toISOString(); // Thu the week before
let n = 0;
const card = (createdAt: string, extra: Partial<Question> = {}) => {
  const q: Question = { id: `q_card${n}`, kind: "open", key: `agent:card${n}`, badge: "Agent asks", prompt: `Agent question ${n}`, options: [], priority: 80, status: "open", createdAt, ...extra };
  n++;
  hub.store.putQuestion(q);
  return q;
};
const openKeys = (prefix: string) => hub.store.questions("open").filter((q) => q.key.startsWith(prefix));
const staleCard = () => hub.store.openQuestionByKey("stale");

describe("reflection proposals have their own slots", () => {
  test("15 open cards that aren't deferred, 1 proposed item with proposalOf: tick asks one proposal card", () => {
    for (let i = 0; i < 15; i++) card(fresh);
    // How memory sync marks a proposal merged into an existing item (createItem drops proposalOf).
    const it = hub.createItem({ title: "Merged proposal", kind: "task", status: "proposed" });
    hub.updateItem(it.id, { proposalOf: "Proposals 2026-09-22 · High Priority" }, { quiet: true });
    p.tick(now);
    const asked = openKeys("proposal:");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.itemId).toBe(it.id);
    expect(asked[0]!.kind).toBe("dispatch");
  });

  test("open proposal cards don't eat the total budget", () => {
    for (const t of ["a", "b"]) hub.createItem({ title: t, kind: "idea", status: "proposed", source: { type: "memory", label: "Proposals 2026-09-22 · High Priority" } });
    for (let i = 0; i < 12; i++) card(fresh);
    p.tick(now); // asks both proposals
    expect(openKeys("proposal:")).toHaveLength(2);
    const inbox = hub.createItem({ title: "captured thing", status: "inbox" });
    p.tick(now);
    expect(hub.store.questions("open").some((q) => q.key === `inbox:${inbox.id}`)).toBe(true);
  });

  test("a proposal on cooldown doesn't use up a slot", () => {
    const label = "Proposals 2026-09-22 · High Priority";
    const a = hub.createItem({ title: "a", kind: "idea", status: "proposed", source: { type: "memory", label } });
    hub.store.putQuestion({ id: "q_prop_a", kind: "dispatch", itemId: a.id, key: `proposal:${a.id}`, prompt: "a", options: [], priority: 45, status: "answered", answer: "Thu 09:30", createdAt: fresh, answeredAt: new Date().toISOString() });
    const b = hub.createItem({ title: "b", kind: "idea", status: "proposed", source: { type: "memory", label } });
    const c = hub.createItem({ title: "c", kind: "idea", status: "proposed", source: { type: "memory", label } });
    p.tick(now);
    expect(openKeys("proposal:").map((q) => q.itemId).sort()).toEqual([b.id, c.id].sort());
  });

  test("still capped at CAP.proposal, and other dispatch cards (Didn't run) don't take a proposal slot", () => {
    card(fresh, { kind: "dispatch", key: "restart:job_x", badge: "Didn't run" });
    card(fresh, { kind: "dispatch", key: "restart:job_y", badge: "Didn't run" });
    for (const t of ["a", "b", "c"]) hub.createItem({ title: t, kind: "idea", status: "proposed", source: { type: "memory", label: "Proposals 2026-09-22 · High Priority" } });
    p.tick(now);
    expect(openKeys("proposal:")).toHaveLength(2);
  });
});

describe("stale cards", () => {
  test("workdaysAgo skips weekends", () => {
    expect(workdaysAgo(3, now).toString()).toBe(new Date(2026, 8, 18, 15, 0).toString());
    expect(workdaysAgo(1, new Date(2026, 8, 21, 9, 0)).toString()).toBe(new Date(2026, 8, 18, 9, 0).toString()); // Mon → Fri
  });

  test("cards older than 3 workdays don't count against the cap; they fold into one card", () => {
    const stale = Array.from({ length: 14 }, () => card(old));
    card(new Date(2026, 8, 18, 16, 0).toISOString()); // Fri 16:00: under 3 workdays, counts
    const inbox = hub.createItem({ title: "captured thing", status: "inbox" });
    p.tick(now);
    expect(hub.store.questions("open").some((q) => q.key === `inbox:${inbox.id}`)).toBe(true);
    const s = staleCard()!;
    expect(s.prompt).toBe("14 cards older than 3 workdays: close or keep?");
    expect(s.picks!.map((x) => x.id).sort()).toEqual(stale.map((q) => q.id).sort());
    // The originals stay open: an agent's question keeps its buttons.
    expect(stale.every((q) => hub.store.question(q.id)!.status === "open")).toBe(true);
    // No dead button warning for "Keep them".
    expect(hub.store.journal().some((j) => j.text.startsWith("Dead button"))).toBe(false);
  });

  test("deferred and proposal cards never go on the stale card", () => {
    card(old, { notBefore: new Date(2026, 8, 25).toISOString() });
    card(old, { kind: "dispatch", key: "proposal:it_x", itemId: undefined });
    p.tick(now);
    expect(staleCard()).toBeUndefined();
  });

  test("Close ticked closes those cards only", async () => {
    const [a, b, c] = [card(old), card(old), card(old)];
    p.tick(now);
    const s = staleCard()!;
    await hub.answer(s.id, "close", undefined, { picks: [a.id, b.id] });
    expect(hub.store.question(a.id)!.status).toBe("expired");
    expect(hub.store.question(b.id)!.status).toBe("expired");
    expect(hub.store.question(c.id)!.status).toBe("open");
    // Cooldown: the leftover card doesn't come straight back.
    p.tick(now);
    expect(staleCard()).toBeUndefined();
  });

  test("Close ticked with nothing ticked keeps the card; Close all with a note closes nothing", async () => {
    const a = card(old);
    p.tick(now);
    await hub.answer(staleCard()!.id, "close");
    expect(staleCard()).toBeDefined();
    await hub.answer(staleCard()!.id, "all", "all but the agent one");
    expect(staleCard()).toBeDefined();
    expect(hub.store.question(a.id)!.status).toBe("open");
    await hub.answer(staleCard()!.id, "all");
    expect(hub.store.question(a.id)!.status).toBe("expired");
  });

  test("Keep them: those cards don't come back on the next stale card; a newly stale one does", async () => {
    const a = card(old);
    p.tick(now);
    const s = staleCard()!;
    await hub.answer(s.id, "keep");
    // Past the cooldown.
    const answered = hub.store.question(s.id)!;
    hub.store.putQuestion({ ...answered, answeredAt: new Date(Date.now() - 21 * 3600_000).toISOString() });
    p.tick(now);
    expect(staleCard()).toBeUndefined();
    expect(hub.store.question(a.id)!.status).toBe("open");
    const b = card(old);
    p.tick(now);
    expect(staleCard()!.picks!.map((x) => x.id)).toEqual([b.id]);
  });

  test("an open stale card follows the board and goes when none are left", () => {
    const [a, b] = [card(old), card(old)];
    p.tick(now);
    hub.expireQuestion(a.id, "answered elsewhere");
    p.tick(now);
    expect(staleCard()!.picks!.map((x) => x.id)).toEqual([b.id]);
    expect(staleCard()!.prompt).toBe("1 card older than 3 workdays: close it or keep it?");
    hub.expireQuestion(b.id, "answered elsewhere");
    p.tick(now);
    expect(staleCard()).toBeUndefined();
  });

  test("the card lists the oldest 20; Close all closes only those", async () => {
    const all = Array.from({ length: 25 }, (_, i) => card(new Date(2026, 8, 10, 9, i).toISOString()));
    p.tick(now);
    const s = staleCard()!;
    expect(s.prompt).toBe("25 cards older than 3 workdays: close or keep?");
    expect(s.picks!.map((x) => x.id)).toEqual(all.slice(0, 20).map((q) => q.id));
    expect(s.options.find((o) => o.id === "all")!.label).toBe("Close these 20");
    await hub.answer(s.id, "all");
    expect(all.filter((q) => hub.store.question(q.id)!.status === "open").map((q) => q.id)).toEqual(all.slice(20).map((q) => q.id));
  });

  test("closing cards that went elsewhere in the meantime journals only the one it closed", async () => {
    const [a, b] = [card(old), card(old)];
    p.tick(now);
    const s = staleCard()!;
    hub.expireQuestion(a.id, "answered elsewhere");
    await hub.answer(s.id, "close", undefined, { picks: [a.id, b.id] });
    const line = hub.store.journal().find((j) => j.text.startsWith("Closed "));
    expect(line!.text).toBe(`Closed 1 stale card: ${b.prompt}`);
    expect(line!.text).not.toContain(a.prompt);
    expect(hub.store.question(a.id)!.answer).toBe("answered elsewhere");
  });

  test("all of them closed elsewhere: no close lines in the journal", async () => {
    const a = card(old);
    p.tick(now);
    const s = staleCard()!;
    hub.expireQuestion(a.id, "answered elsewhere");
    await hub.answer(s.id, "all");
    expect(hub.store.journal().some((j) => j.text.startsWith("Closed ") || j.text.includes("→ Close it"))).toBe(false);
  });

  test("a count change behind the first 20 still redraws the prompt", () => {
    for (let i = 0; i < 25; i++) card(new Date(2026, 8, 10, 9, i).toISOString());
    p.tick(now);
    const first = staleCard()!.picks!.map((x) => x.id);
    card(old);
    p.tick(now);
    expect(staleCard()!.prompt).toBe("26 cards older than 3 workdays: close or keep?");
    expect(staleCard()!.picks!.map((x) => x.id)).toEqual(first);
  });

  test("Keep on a truncated card keeps the shown ones; the rest come back", async () => {
    const all = Array.from({ length: 22 }, (_, i) => card(new Date(2026, 8, 10, 9, i).toISOString()));
    p.tick(now);
    const s = staleCard()!;
    await hub.answer(s.id, "keep");
    hub.store.putQuestion({ ...hub.store.question(s.id)!, answeredAt: new Date(Date.now() - 21 * 3600_000).toISOString() });
    p.tick(now);
    expect(staleCard()!.picks!.map((x) => x.id)).toEqual(all.slice(20).map((q) => q.id));
  });

  test("the note reader is told a note alone closes nothing", () => {
    const q = { ...buildStaleCard([card(old)]), id: "q_stale", key: "stale", status: "open", createdAt: old } as Question;
    const prompt = notePrompt(q, undefined, "close the agent one", { now });
    expect(prompt).toContain('"Close ticked" \u2192 close cards: needs a tap, never pick this from a note');
  });
});

describe("stale card buttons", () => {
  test("a note-reader pick of a close option closes nothing", async () => {
    const a = card(old);
    p.tick(now);
    const s = staleCard()!;
    for (const pick of ["close", "all"]) {
      // note() parks the card for 15 min before the reader's pick lands.
      hub.store.putQuestion({ ...hub.store.question(s.id)!, notBefore: new Date(Date.now() + 15 * 60_000).toISOString() });
      await hub.applyNote(s.id, { pick } as any, "close them all");
      expect(hub.store.question(a.id)!.status).toBe("open");
      expect(hub.store.question(s.id)!.status).toBe("open");
      expect(hub.store.question(s.id)!.notBefore).toBeUndefined(); // back in the queue for a tap
    }
  });

  test("blockedOption: closePicks ignores notes; other tick options take one", async () => {
    const { blockedOption } = await import("../src/web/parts.tsx");
    expect(blockedOption({ type: "closePicks" }, 0, "")).toBe(true);
    expect(blockedOption({ type: "closePicks" }, 0, "close the agent one")).toBe(true);
    expect(blockedOption({ type: "closePicks" }, 2, "")).toBe(false);
    expect(blockedOption({ type: "closePicks", all: true }, 0, "")).toBe(false);
    expect(blockedOption({ type: "closePicks", all: true }, 0, "all but one")).toBe(true);
    expect(blockedOption({ type: "donePicks" }, 0, "the bravo one")).toBe(false);
    expect(blockedOption({ type: "donePicks" }, 0, "")).toBe(true);
    expect(blockedOption({ type: "noop" }, 0, "")).toBe(false);
  });

  test("Close ticked waits for a tick; Close all doesn't", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Focus } = await import("../src/web/parts.tsx");
    const q = { ...buildStaleCard([card(old), card(old)]), id: "q_stale", key: "stale", status: "open", createdAt: old } as Question;
    const html = renderToStaticMarkup(createElement(Focus, { q, total: 1, items: [], onSkip: () => {}, onOpenItem: () => {} }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*><kbd>1<\/kbd>Tick the ones to close<\/button>/);
    expect(html).toMatch(/<button class="opt danger"><kbd>2<\/kbd>Close all 2<\/button>/);
  });
});
