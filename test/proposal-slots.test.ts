import { beforeEach, describe, expect, test } from "bun:test";
import { config } from "../src/server/config.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { Prompter, staleCard as buildStaleCard, workdaysAgo } from "../src/server/prompter.ts";
import { workStart } from "../src/shared/workday.ts";
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

describe("proposal cards yield their slot", () => {
  // 11-12..11-18: two proposal cards held both slots for six days; no newer reflection's proposal was asked.
  const prop = (title: string, day: string, section = "High Priority") =>
    hub.createItem({ title, kind: "idea", status: "proposed", source: { type: "memory", label: `Proposals ${day} · ${section}` } });
  const propCard = (itemId: string, createdAt: string, extra: Partial<Question> = {}) => {
    const q: Question = { id: `q_p_${itemId}`, kind: "dispatch", itemId, key: `proposal:${itemId}`, prompt: itemId, options: [], priority: 45, status: "open", createdAt, ...extra };
    hub.store.putQuestion(q);
    return q;
  };
  const status = (q: Question) => hub.store.question(q.id)!;
  const openItems = () => openKeys("proposal:").map((q) => q.itemId).sort();

  test("two cards open 3 workdays, a new proposals file imported: both yield, two cards from the new file open", () => {
    const [a, b] = [prop("a", "2026-09-16"), prop("b", "2026-09-16")];
    const [qa, qb] = [propCard(a.id, old), propCard(b.id, old)];
    const [c, d] = [prop("c", "2026-09-22"), prop("d", "2026-09-22", "Medium Priority")];
    p.tick(now);
    for (const q of [qa, qb]) {
      expect(status(q).status).toBe("expired");
      expect(status(q).answer).toBe("yielded");
    }
    expect(hub.store.item(a.id)!.status).toBe("proposed");
    expect(hub.store.item(b.id)!.status).toBe("proposed");
    expect(openItems()).toEqual([c.id, d.id].sort());
  });

  test("unanswered 2 workdays yields even with nothing newer; the item isn't re-asked straight away", () => {
    const [a, b] = [prop("a", "2026-09-16"), prop("b", "2026-09-16")];
    const qa = propCard(a.id, new Date(2026, 8, 21, 14, 0).toISOString()); // Mon 14:00: just over 2 workdays
    const qb = propCard(b.id, new Date(2026, 8, 21, 16, 0).toISOString()); // Mon 16:00: under
    p.tick(now);
    expect(status(qa).answer).toBe("yielded");
    expect(status(qb).status).toBe("open");
    expect(openItems()).toEqual([b.id]);
  });

  test("a fresh card yields to a newer reflection's proposal, oldest first, one per newer proposal; then it's stable", () => {
    const a = prop("a", "2026-09-15");
    const b = prop("b", "2026-09-16");
    const [qa, qb] = [propCard(a.id, fresh), propCard(b.id, fresh)];
    const c = prop("c", "2026-09-22");
    p.tick(now);
    expect(status(qa).answer).toBe("yielded");
    expect(status(qb).status).toBe("open");
    expect(openItems()).toEqual([b.id, c.id].sort());
    p.tick(now);
    expect(openItems()).toEqual([b.id, c.id].sort());
    expect(hub.store.questions("expired").filter((q) => q.key.startsWith("proposal:"))).toHaveLength(1);
  });

  test("cards from the newest reflection keep their slots over older proposals", () => {
    const [a, b] = [prop("a", "2026-09-22"), prop("b", "2026-09-22")];
    propCard(a.id, fresh);
    propCard(b.id, fresh);
    prop("older", "2026-09-16");
    p.tick(now);
    expect(openItems()).toEqual([a.id, b.id].sort());
  });

  test("a newer proposal on cooldown (answered or yielded lately) isn't one to yield to", () => {
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, fresh);
    const c = prop("c", "2026-09-22");
    hub.store.putQuestion({ id: "q_prev_c", kind: "dispatch", itemId: c.id, key: `proposal:${c.id}`, prompt: "c", options: [], priority: 45, status: "expired", answer: "yielded", createdAt: old, answeredAt: new Date().toISOString() });
    p.tick(now);
    expect(status(qa).status).toBe("open");
  });

  test("a free slot goes to the newer proposal first: the old card keeps its slot", () => {
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, fresh);
    const c = prop("c", "2026-09-22");
    p.tick(now);
    expect(status(qa).status).toBe("open");
    expect(openItems()).toEqual([a.id, c.id].sort());
  });

  test("two fresh cards on different dates, two newer proposals: both cards yield, both newer ones are asked", () => {
    const [a, b] = [prop("a", "2026-09-15"), prop("b", "2026-09-19")];
    const [qa, qb] = [propCard(a.id, fresh), propCard(b.id, fresh)];
    const [c, d] = [prop("c", "2026-09-20"), prop("d", "2026-09-22")];
    p.tick(now);
    expect(status(qa).answer).toBe("yielded");
    expect(status(qb).answer).toBe("yielded");
    expect(openItems()).toEqual([c.id, d.id].sort());
  });

  test("2 workdays, not 2 days: a Friday card is still open on Monday, yields on Wednesday", () => {
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, new Date(2026, 8, 18, 9, 0).toISOString()); // Fri 09:00
    p.tick(new Date(2026, 8, 21, 15, 0)); // Mon 15:00
    expect(status(qa).status).toBe("open");
    p.tick(now); // Wed 15:00
    expect(status(qa).answer).toBe("yielded");
  });

  test("a card whose item stopped being a proposal doesn't yield to an older one", () => {
    const a = prop("a", "2026-09-22");
    const qa = propCard(a.id, fresh);
    hub.updateItem(a.id, { status: "today" }, { quiet: true });
    propCard(prop("b", "2026-09-22").id, fresh);
    prop("older", "2026-09-16");
    p.tick(now);
    expect(status(qa).status).toBe("open");
  });

  test("not aged out while you're away", () => {
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, old);
    hub.store.setKv("calendarAway", JSON.stringify([{ title: "OOO", start: new Date(2026, 8, 23, 0, 0).toISOString(), end: new Date(2026, 8, 24, 0, 0).toISOString() }]));
    p.tick(now);
    expect(status(qa).status).toBe("open");
  });

  test("same reflection: a High proposal ranks out a Low card; a same-section one doesn't", () => {
    const low = prop("low", "2026-09-22", "Low Priority");
    const med = prop("med", "2026-09-22", "Medium Priority");
    const [ql, qm] = [propCard(low.id, fresh), propCard(med.id, fresh)];
    const high = prop("high", "2026-09-22");
    prop("med2", "2026-09-22", "Medium Priority");
    p.tick(now);
    expect(status(ql).answer).toBe("yielded");
    expect(status(qm).status).toBe("open");
    expect(openItems()).toEqual([high.id, med.id].sort());
  });

  test("overlapping or duplicate away blocks count once; a card made mid-block counts only the rest of it", () => {
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, new Date(2026, 8, 21, 12, 0).toISOString()); // Mon 12:00, inside the 10:00-14:00 block
    const pickup = { title: "Out of office - creche pickup", start: new Date(2026, 8, 22, 16, 30).toISOString(), end: new Date(2026, 8, 22, 17, 15).toISOString() };
    hub.store.setKv("calendarAway", JSON.stringify([
      { title: "OOO", start: new Date(2026, 8, 21, 10, 0).toISOString(), end: new Date(2026, 8, 21, 14, 0).toISOString() },
      { title: "OOO school run", start: new Date(2026, 8, 21, 11, 0).toISOString(), end: new Date(2026, 8, 21, 12, 30).toISOString() },
      pickup,
      pickup,
      { title: "bad", start: "soon", end: "later" },
    ]));
    // Clock starts Mon 12:00 + 2h (rest of the block) + 45 min (pickup once) = Mon 14:45: yields at Wed 15:00.
    // Double-counting the school run or the pickup would push it past Mon 15:00 and keep it open.
    p.tick(now);
    expect(status(qa).answer).toBe("yielded");
  });

  test("time away is left out of the age: a 4-day block pushes the clock on 4 days", () => {
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, old); // Thu 09-17 10:00
    hub.store.setKv("calendarAway", JSON.stringify([{ title: "OOO", start: new Date(2026, 8, 18, 0, 0).toISOString(), end: new Date(2026, 8, 22, 0, 0).toISOString() }]));
    p.tick(new Date(2026, 8, 22, 15, 0)); // Tue 15:00: counts as shown Mon 10:00, under 2 workdays
    expect(status(qa).status).toBe("open");
    p.tick(now); // Wed 15:00: past Mon 15:00
    expect(status(qa).answer).toBe("yielded");
  });

  test("a short daily block (creche pickup) only adds its own 45 min; one still ahead adds nothing", () => {
    // Live 11-18: restarting the clock at each block's end kept cards from ever ageing out.
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, new Date(2026, 8, 21, 14, 0).toISOString()); // Mon 14:00
    hub.store.setKv("calendarAway", JSON.stringify([
      { title: "Out of office - creche pickup", start: new Date(2026, 8, 22, 16, 30).toISOString(), end: new Date(2026, 8, 22, 17, 15).toISOString() },
      { title: "Out of office - creche pickup", start: new Date(2026, 8, 23, 16, 30).toISOString(), end: new Date(2026, 8, 23, 17, 15).toISOString() },
    ]));
    p.tick(now); // Wed 15:00: shown Mon 14:45 < Mon 15:00
    expect(status(qa).answer).toBe("yielded");
  });

  test("a card whose typed note is being read keeps its slot", () => {
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, old);
    (hub as any).reading.set(qa.id, { n: 1 });
    p.tick(now);
    expect(status(qa).status).toBe("open");
    (hub as any).reading.delete(qa.id);
    p.tick(now);
    expect(status(qa).answer).toBe("yielded");
  });

  test("a yielded item is asked again once the 5-day cooldown is over", () => {
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, old);
    p.tick(now);
    expect(status(qa).answer).toBe("yielded");
    expect(openItems()).toEqual([]);
    hub.store.putQuestion({ ...status(qa), answeredAt: new Date(Date.now() - (4 * 24 + 23) * 3600_000).toISOString() });
    p.tick(now);
    expect(openItems()).toEqual([]);
    hub.store.putQuestion({ ...status(qa), answeredAt: new Date(Date.now() - (5 * 24 + 1) * 3600_000).toISOString() });
    p.tick(now);
    expect(openItems()).toEqual([a.id]);
  });

  // 11-19 09:08:45: the 11-18 reflection's #1 and #2 yielded in the same second two 11-19 Learn proposals took the
  // slots. The rank compared file date first, so any newer Learn proposal beat an older reflection High/Medium one.
  test("a newer Learn proposal can't rank a reflection High or Medium card out", () => {
    const high = prop("high", "2026-09-22");
    const med = prop("med", "2026-09-22", "Medium Priority");
    const [qh, qm] = [propCard(high.id, fresh), propCard(med.id, fresh)];
    prop("learn1", "2026-09-23", "Learn (session 01a1eeda)");
    prop("learn2", "2026-09-23", "Learn (session 01a1eeda)");
    p.tick(now);
    expect(status(qh).status).toBe("open");
    expect(status(qm).status).toBe("open");
    expect(openItems()).toEqual([high.id, med.id].sort());
  });

  test("a newer Learn proposal does rank out a reflection Low card or an older Learn one", () => {
    const low = prop("low", "2026-09-21", "Low Priority");
    const old = prop("oldlearn", "2026-09-21", "Learn (session a)");
    const [ql, qo] = [propCard(low.id, fresh), propCard(old.id, fresh)];
    const [l1, l2] = [prop("learn1", "2026-09-23", "Learn (session b)"), prop("learn2", "2026-09-23", "Learn (session b)")];
    p.tick(now);
    expect(status(ql).answer).toBe("yielded");
    expect(status(qo).answer).toBe("yielded");
    expect(openItems()).toEqual([l1.id, l2.id].sort());
  });

  test("fill order matches: free slots go to an older reflection High before a newer Learn, so nothing churns", () => {
    const learn = prop("learn", "2026-09-23", "Learn (session b)");
    const high = prop("high", "2026-09-18");
    const med = prop("med", "2026-09-16", "Medium Priority");
    p.tick(now);
    expect(openItems()).toEqual([high.id, med.id].sort());
    p.tick(now);
    expect(openItems()).toEqual([high.id, med.id].sort());
    expect(hub.store.questions("expired").filter((q) => q.key.startsWith("proposal:"))).toHaveLength(0);
    expect(openKeys("proposal:").some((q) => q.itemId === learn.id)).toBe(false);
  });

  test("a card shown overnight starts ageing at the first work-hours moment, not when it was asked", () => {
    const [dayStart] = config.sweeps.workHours;
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, new Date(2026, 8, 21, 1, 6).toISOString()); // Mon 01:06
    p.tick(new Date(2026, 8, 23, dayStart - 1, 30)); // Wed, before work: 2 workdays from Mon 01:06 but not from Mon's start
    expect(status(qa).status).toBe("open");
    p.tick(new Date(2026, 8, 23, dayStart, 1)); // Wed just past dayStart: 2 workdays from Mon's start
    expect(status(qa).answer).toBe("yielded");
  });

  test("a card shown Friday evening starts ageing Monday morning", () => {
    const [dayStart, dayEnd] = config.sweeps.workHours;
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, new Date(2026, 8, 18, dayEnd, 30).toISOString()); // Fri after dayEnd
    p.tick(new Date(2026, 8, 23, dayStart - 1, 0)); // Wed before Mon-start + 2 workdays
    expect(status(qa).status).toBe("open");
    p.tick(new Date(2026, 8, 23, dayStart, 1));
    expect(status(qa).answer).toBe("yielded");
  });

  test("workStart: inside work hours stays; before moves to dayStart; after or at the weekend to the next workday's", () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime();
    expect(workStart(at(21, 10), [8, 19])).toBe(at(21, 10)); // Mon 10:00
    expect(workStart(at(21, 1, 6), [8, 19])).toBe(at(21, 8)); // Mon 01:06 → Mon 08:00
    expect(workStart(at(21, 19), [8, 19])).toBe(at(22, 8)); // Mon 19:00 (end is exclusive) → Tue 08:00
    expect(workStart(at(18, 22), [8, 19])).toBe(at(21, 8)); // Fri 22:00 → Mon 08:00
    expect(workStart(at(19, 3), [8, 19])).toBe(at(21, 8)); // Sat 03:00 → Mon 08:00
    expect(workStart(at(20, 12), [8.5, 19])).toBe(at(21, 8, 30)); // Sun noon, fractional start → Mon 08:30
    expect(workStart(NaN, [8, 19])).toBeNaN();
  });

  test("a card snoozed to the weekend starts ageing Monday morning", () => {
    const [dayStart] = config.sweeps.workHours;
    const a = prop("a", "2026-09-16");
    const qa = propCard(a.id, old, { notBefore: new Date(2026, 8, 19, 10, 0).toISOString() }); // back Sat 10:00
    p.tick(new Date(2026, 8, 23, dayStart - 1, 0)); // Wed before work: the clock starts Mon at dayStart, not Sat 10:00 (which would have yielded it)
    expect(status(qa).status).toBe("open");
    p.tick(new Date(2026, 8, 23, dayStart, 1));
    expect(status(qa).answer).toBe("yielded");
  });

  test("a snoozed card keeps its slot; its age counts from when it came back", () => {
    const [a, b] = [prop("a", "2026-09-16"), prop("b", "2026-09-16")];
    const qa = propCard(a.id, old, { notBefore: new Date(2026, 8, 24, 9, 30).toISOString() }); // snoozed to tomorrow
    const qb = propCard(b.id, old, { notBefore: new Date(2026, 8, 23, 9, 30).toISOString() }); // came back this morning
    prop("c", "2026-09-16");
    p.tick(now);
    expect(status(qa).status).toBe("open");
    expect(status(qb).status).toBe("open");
  });
});

describe("stale cards", () => {
  test("workdaysAgo skips weekends", () => {
    expect(workdaysAgo(3, now).toString()).toBe(new Date(2026, 8, 18, 15, 0).toString());
    expect(workdaysAgo(1, new Date(2026, 8, 21, 9, 0)).toString()).toBe(new Date(2026, 8, 18, 9, 0).toString()); // Mon → Fri
  });

  // 11-14/15: the cutoff kept the time of day on Sat/Sun, jumped back a day at midnight, and the stale card emptied at
  // 00:00 and reopened three times.
  test("workdaysAgo stands still over the weekend and never moves back", () => {
    const sat = workdaysAgo(3, new Date(2026, 8, 19, 9, 30)).getTime(); // Sat 09-19
    expect(workdaysAgo(3, new Date(2026, 8, 20, 20, 0)).getTime()).toBe(sat); // Sun 20:00
    expect(sat).toBe(new Date(2026, 8, 16).getTime()); // from Fri midnight: Wed 00:00
    let prev = -Infinity;
    for (let t = new Date(2026, 8, 18, 9, 0).getTime(); t <= new Date(2026, 8, 21, 12, 0).getTime(); t += 15 * 60_000) {
      const cut = workdaysAgo(3, new Date(t)).getTime();
      expect(cut).toBeGreaterThanOrEqual(prev);
      prev = cut;
    }
  });

  test("a new stale card waits for work time: not at the weekend or outside work hours", () => {
    card(old);
    p.tick(new Date(2026, 8, 26, 9, 30)); // Sat
    p.tick(new Date(2026, 8, 27, 20, 0)); // Sun
    p.tick(new Date(2026, 8, 28, 7, 59)); // Mon, before dayStart (8)
    expect(staleCard()).toBeUndefined();
    p.tick(new Date(2026, 8, 28, 8, 0));
    expect(staleCard()).toBeDefined();
  });

  test("a new stale card waits after dayEnd and through an out-of-office block", () => {
    card(old);
    p.tick(new Date(2026, 8, 22, 20, 4)); // Tue, after dayEnd (19)
    expect(staleCard()).toBeUndefined();
    hub.ingestReport({ summary: "1 event", events: [], away: [{ title: "OOO", start: "2026-09-23", end: "2026-09-24" }] } as any, "calendar");
    p.tick(now); // Wed 15:00, away all day
    expect(staleCard()).toBeUndefined();
    p.tick(new Date(2026, 8, 24, 10, 0)); // Thu, back
    expect(staleCard()).toBeDefined();
  });

  test("an open stale card keeps its rows over the weekend midnights", () => {
    card(new Date(2026, 8, 15, 12, 0).toISOString()); // Tue 09-15 12:00
    p.tick(new Date(2026, 8, 18, 15, 0)); // Fri: cutoff Tue 15:00
    const s = staleCard()!;
    const rows = s.picks!.map((x) => x.id);
    // Wed 12:00: the old cutoff (Wed, weekend time of day) took it in at Sat 20:00 and dropped it at Sun 00:00.
    card(new Date(2026, 8, 16, 12, 0).toISOString());
    for (const [d, h, m] of [[19, 0, 0], [19, 20, 0], [20, 0, 0], [20, 20, 0], [21, 0, 0], [21, 9, 30]] as const) {
      p.tick(new Date(2026, 8, d, h, m));
      expect(staleCard()?.id).toBe(s.id);
      expect(staleCard()!.picks!.map((x) => x.id)).toEqual(rows);
    }
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
    // Not disabled; the title is the button's "what happens" tooltip (shared/explain-option.ts).
    expect(html).toMatch(/<button class="opt danger"(?![^>]*disabled)[^>]*><kbd>2<\/kbd>Close all 2<\/button>/);
  });
});
