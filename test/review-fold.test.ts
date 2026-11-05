import { describe, expect, test } from "bun:test";
import { Agents, type CmuxDeps, laterIso, scannedFrom } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { BACKFILL_KEY, BACKFILL_TRIES, capSince, covered, NOTES_GRACE_MS, noNotes, outOfReach, pendingBackfill, pruneReviews, queueBackfill, readMeetings, reviewDigest, reviewsSince, settleBackfill } from "../src/server/review-fold.ts";

const T = (s: string) => Date.parse(s);

describe("folded review card helpers", () => {
  test("covered: windows joined end to end, gaps break it", () => {
    const w = [{ since: "2026-09-23T08:00:00Z", at: "2026-09-23T12:00:00Z" }, { since: "2026-09-23T11:00:00Z", at: "2026-09-23T16:00:00Z" }];
    expect(covered(w, T("2026-09-23T09:00:00Z"), T("2026-09-23T15:00:00Z"))).toBe(true);
    expect(covered(w, T("2026-09-23T07:00:00Z"), T("2026-09-23T09:00:00Z"))).toBe(false);
    expect(covered([w[0]!, { since: "2026-09-23T12:30:00Z", at: "2026-09-23T16:00:00Z" }], T("2026-09-23T09:00:00Z"), T("2026-09-23T15:00:00Z"))).toBe(false);
    expect(covered([{ since: "garbage", at: "2026-09-23T16:00:00Z" }], T("2026-09-23T09:00:00Z"), T("2026-09-23T10:00:00Z"))).toBe(false);
  });

  test("noNotes: coverage from the end to the grace period after it", () => {
    const m = { title: "X", day: "2026-09-23", start: "2026-09-23T14:00:00.000Z", end: "2026-09-23T14:30:00.000Z" };
    const end = T(m.end);
    const win = (to: number) => [{ since: "2026-09-23T13:00:00.000Z", at: new Date(to).toISOString() }];
    expect(noNotes(m, win(end + NOTES_GRACE_MS))).toBe(true);
    expect(noNotes(m, win(end + NOTES_GRACE_MS - 1))).toBe(false);
    expect(noNotes(m, [])).toBe(false);
    // A window that starts after the end doesn't vouch for it.
    expect(noNotes(m, [{ since: "2026-09-24T00:00:00.000Z", at: "2026-09-24T09:00:00.000Z" }])).toBe(false);
    // No end: start + 1 h stands in.
    expect(noNotes({ ...m, end: undefined }, win(T(m.start) + 60 * 60_000 + NOTES_GRACE_MS))).toBe(true);
    // Neither (older kv rows): unknown, the scan stays first.
    expect(noNotes({ title: "X", day: "2026-09-23" }, win(T("2026-09-30T00:00:00Z")))).toBe(false);
  });

  test("reviewsSince: local midnight of the earliest day", () => {
    expect(reviewsSince([{ day: "2026-09-23" }, { day: "2026-09-21" }], new Date(2026, 8, 24, 9))).toBe(new Date(2026, 8, 21).toISOString());
    expect(reviewsSince([])).toBeUndefined();
    expect(reviewsSince([{ day: "garbage" }])).toBeUndefined();
  });

  test("laterIso: unparseable or missing loses", () => {
    expect(laterIso("2026-09-22T10:00:00Z", "2026-09-24T00:00:00.000Z")).toBe("2026-09-24T00:00:00.000Z");
    expect(laterIso("2026-09-24T10:00:00+01:00", "2026-09-24T00:00:00.000Z")).toBe("2026-09-24T10:00:00+01:00");
    expect(laterIso(undefined, "2026-09-24T00:00:00.000Z")).toBe("2026-09-24T00:00:00.000Z");
    expect(laterIso("2026-09-24T00:00:00Z", undefined)).toBe("2026-09-24T00:00:00Z");
    expect(laterIso("garbage", "2026-09-24T00:00:00Z")).toBe("2026-09-24T00:00:00Z");
    expect(laterIso(undefined, "garbage")).toBeUndefined();
  });

  test("scannedFrom: a backfill doesn't place items' bare times on today", () => {
    const item = { source: { type: "transcript", label: "Design sync 00:01" } } as any;
    const report = { meetings: [{ title: "Design sync", start: "2026-09-23T09:00:00Z" }] } as any;
    expect(scannedFrom(report, [item], true)).toEqual([{ title: "Design sync", start: "2026-09-23T09:00:00Z" }]);
    expect(scannedFrom(report, [item]).length).toBe(2);
  });
});

describe("transcript sweep with a since (the folded card's scan)", () => {
  const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };
  function setup() {
    const hub = new Hub(new Store(":memory:"));
    const agents = new Agents(hub, noCmux);
    const prompts: string[] = [];
    let release: (() => void) | undefined;
    let hold = false;
    (agents as any).runHeadless = async (_id: string, prompt: string) => {
      prompts.push(prompt);
      if (hold) await new Promise<void>((r) => (release = r));
      return { ok: true, text: JSON.stringify({ summary: "0 meetings", items: [], cursor: "2026-09-20T10:00:00Z", meetings: [] }) };
    };
    return { hub, agents, prompts, holdNext: () => (hold = true), release: () => { hold = false; release?.(); } };
  }

  test("reads from the given day (capped at BACKFILL_DAYS), keeps the later cursor, records its window", async () => {
    const { hub, agents, prompts } = setup();
    const cur = new Date(Date.now() - 60_000).toISOString();
    hub.putSync({ name: "transcripts", cursor: cur });
    const since = new Date(Date.now() - 2 * 86400_000).toISOString();
    await agents.sweep("transcripts", { since });
    expect(prompts[0]).toContain(since);
    expect(hub.store.syncState("transcripts").cursor).toBe(cur);
    expect(hub.sweepWindows().map((w) => w.since)).toEqual([since]);
    // Weeks back: clamped.
    await agents.sweep("transcripts", { since: new Date(Date.now() - 30 * 86400_000).toISOString() });
    const used = hub.sweepWindows()[1]!.since;
    expect(Date.now() - Date.parse(used)).toBeLessThanOrEqual(7 * 86400_000 + 5_000);
    expect(Date.now() - Date.parse(used)).toBeGreaterThan(7 * 86400_000 - 5_000);
  });

  test("a scan tapped while a sweep runs rides the next sweep, not nowhere", async () => {
    const { hub, agents, prompts, holdNext, release } = setup();
    const toasts: string[] = [];
    hub.subscribe((e) => e.type === "toast" && toasts.push((e.data as any).text ?? String(e.data)));
    holdNext();
    const first = agents.sweep("transcripts");
    await Bun.sleep(5);
    const since = new Date(Date.now() - 86400_000).toISOString();
    expect(await agents.sweep("transcripts", { since })).toBeUndefined();
    expect(toasts.join()).toContain("next scheduled scan");
    release();
    await first;
    expect(prompts).toHaveLength(1); // nothing chained past the scheduler
    await agents.sweep("transcripts"); // the next scheduled sweep
    expect(prompts[1]).toContain(since);
    await agents.sweep("transcripts");
    expect(prompts[2]).not.toContain(since); // used once
  });

  test("a backfill that slept mid-run is carried by the rerun", async () => {
    const { agents, prompts } = setup();
    let slept = true;
    (agents as any).runHeadless = async (_id: string, prompt: string) => {
      prompts.push(prompt);
      if (slept) return (slept = false), { ok: false, slept: true, error: "slept", text: "" };
      return { ok: true, text: JSON.stringify({ summary: "0", items: [], meetings: [] }) };
    };
    const since = new Date(Date.now() - 86400_000).toISOString();
    expect(await agents.sweep("transcripts", { since })).toEqual({ rerun: true });
    expect(pendingBackfill((agents as any).hub)?.tries).toBe(0); // a sleep doesn't use up a try
    await agents.sweep("transcripts"); // the scheduler's rerun passes no since
    expect(prompts[1]).toContain(since);
  });

  test("the folded card's scan reads at most BACKFILL_DAYS back", () => {
    const now = new Date(2026, 8, 24, 9);
    expect(reviewsSince([{ day: "2026-09-01" }], now)).toBe(new Date(now.getTime() - 7 * 86400_000).toISOString());
  });
});

describe("queued backfill survives failures and restarts", () => {
  const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };
  const ok = { ok: true, text: JSON.stringify({ summary: "0", items: [], meetings: [] }) };
  function setup(results: Array<object | Error>) {
    const hub = new Hub(new Store(":memory:"));
    const prompts: string[] = [];
    const mk = () => {
      const agents = new Agents(hub, noCmux);
      (agents as any).runHeadless = async (_id: string, prompt: string) => {
        prompts.push(prompt);
        const r = results.shift() ?? ok;
        if (r instanceof Error) throw r;
        return r;
      };
      return agents;
    };
    return { hub, prompts, mk };
  }
  const since = () => new Date(Date.now() - 2 * 86400_000).toISOString();

  test("a plain failure keeps it for the next sweep; success clears it", async () => {
    const { hub, prompts, mk } = setup([{ ok: false, error: "timeout", text: "" }]);
    const agents = mk();
    const s = since();
    expect(await agents.sweep("transcripts", { since: s })).toBeUndefined();
    expect(pendingBackfill(hub)?.since).toBe(s);
    await agents.sweep("transcripts");
    expect(prompts[1]).toContain(s);
    expect(pendingBackfill(hub)).toBeUndefined();
    await agents.sweep("transcripts");
    expect(prompts[2]).not.toContain(s);
  });

  test("a throw keeps it, and a restart (new Agents, same store) picks it up", async () => {
    const { hub, prompts, mk } = setup([new Error("pi died")]);
    const s = since();
    await expect(mk().sweep("transcripts", { since: s })).rejects.toThrow("pi died");
    expect(hub.store.kv(BACKFILL_KEY)).toContain(s);
    await mk().sweep("transcripts");
    expect(prompts[1]).toContain(s);
    expect(pendingBackfill(hub)).toBeUndefined();
  });

  test("capped when asked for, then used verbatim; dropped once queued over BACKFILL_DAYS ago", async () => {
    const { hub, prompts, mk } = setup([]);
    const asked = new Date(Date.now() - 3 * 86400_000);
    // Asked 3 days ago for 30 days back: capped to 7 days before the ask (10 days before now), not before the run.
    const capped = capSince(new Date(asked.getTime() - 30 * 86400_000).toISOString(), asked);
    expect(Date.parse(capped)).toBe(asked.getTime() - 7 * 86400_000);
    queueBackfill(hub, capped, asked);
    await mk().sweep("transcripts");
    expect(prompts[0]).toContain(capped);
    // Queued 8 days ago: stale, ignored.
    const old = new Date(Date.now() - 8 * 86400_000);
    queueBackfill(hub, old.toISOString(), old);
    expect(pendingBackfill(hub)).toBeUndefined();
    expect(capSince("garbage", asked)).toBe(new Date(asked.getTime() - 7 * 86400_000).toISOString());
  });

  test("dropped after BACKFILL_TRIES failed runs, so a broken scan doesn't reread days every tick", async () => {
    const fail = { ok: false, error: "no JSON", text: "" };
    const { hub, prompts, mk } = setup(Array.from({ length: BACKFILL_TRIES }, () => fail));
    const agents = mk();
    const s = since();
    await agents.sweep("transcripts", { since: s });
    for (let i = 1; i < BACKFILL_TRIES; i++) await agents.sweep("transcripts");
    expect(prompts.every((p) => p.includes(s))).toBe(true);
    expect(pendingBackfill(hub)?.tries).toBe(BACKFILL_TRIES);
    await agents.sweep("transcripts");
    expect(prompts[BACKFILL_TRIES]).not.toContain(s);
    expect(pendingBackfill(hub)).toBeUndefined();
    // A new ask starts over.
    await agents.sweep("transcripts", { since: s });
    expect(prompts.at(-1)).toContain(s);
  });

  test("queueing keeps the earlier; settling keeps one queued earlier than the run read", () => {
    const hub = new Hub(new Store(":memory:"));
    const a = new Date(Date.now() - 2 * 86400_000).toISOString(), b = new Date(Date.now() - 3 * 86400_000).toISOString();
    queueBackfill(hub, a);
    expect(queueBackfill(hub, b).since).toBe(b);
    expect(queueBackfill(hub, a).since).toBe(b);
    settleBackfill(hub, a); // a run that read from a: b still waits
    expect(pendingBackfill(hub)?.since).toBe(b);
    settleBackfill(hub, b);
    expect(pendingBackfill(hub)).toBeUndefined();
  });
});

describe("folded card list from kv", () => {
  const now = new Date();
  const day = (n: number) => {
    const d = new Date(now.getTime() - n * 86400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  function card(hub: Hub, kv: string | undefined, key = `reviews:${day(0)}`) {
    if (kv !== undefined) hub.store.setKv(key, kv);
    const meetings = [{ title: "A", day: day(1) }];
    return hub.ask({ ...reviewDigest(meetings, now), key })!;
  }
  const open = (hub: Hub, id: string) => hub.store.questions("open").some((q) => q.id === id);

  test("readMeetings: missing/unparseable/all-bad → undefined; [] → []; bad rows dropped", () => {
    const hub = new Hub(new Store(":memory:"));
    const k = "reviews:x";
    expect(readMeetings(hub, k)).toBeUndefined();
    hub.store.setKv(k, "{oops");
    expect(readMeetings(hub, k)).toBeUndefined();
    hub.store.setKv(k, "{}");
    expect(readMeetings(hub, k)).toBeUndefined();
    hub.store.setKv(k, "[null, 3]");
    expect(readMeetings(hub, k)).toBeUndefined();
    hub.store.setKv(k, "[]");
    expect(readMeetings(hub, k)).toEqual([]);
    hub.store.setKv(k, JSON.stringify([null, { title: "A", day: "2026-09-23" }, { title: "B", day: "nope" }, { title: "C", day: "2026-09-23", start: "x" }]));
    expect(readMeetings(hub, k)).toEqual([{ title: "A", day: "2026-09-23" }]);
  });

  test("pruneReviews: a real [] closes the card, an unreadable list leaves it, a malformed row doesn't throw", () => {
    const hub = new Hub(new Store(":memory:"));
    const empty = card(hub, "[]");
    expect(pruneReviews(hub, () => false, now)).toBe(1);
    expect(open(hub, empty.id)).toBe(false);
    const bad = card(hub, "{oops", `reviews:${day(0)}b`);
    expect(pruneReviews(hub, () => false, now)).toBe(0);
    expect(open(hub, bad.id)).toBe(true);
    const mixed = card(hub, JSON.stringify([null, { title: "B", day: day(1), start: new Date(now.getTime() - 86400_000).toISOString() }]), `reviews:${day(0)}c`);
    expect(() => pruneReviews(hub, () => false, now)).not.toThrow();
    expect(open(hub, mixed.id)).toBe(true);
  });

  test("meetings older than the scan can reach drop off after a sweep; the card closes when only they were left", () => {
    const hub = new Hub(new Store(":memory:"));
    const old = { title: "Old", day: day(9), start: new Date(now.getTime() - 9 * 86400_000).toISOString() };
    const oldBare = { title: "Older row", day: day(9) };
    const recent = { title: "Recent", day: day(1), start: new Date(now.getTime() - 86400_000).toISOString() };
    expect(outOfReach(old, now)).toBe(true);
    expect(outOfReach(oldBare, now)).toBe(true);
    expect(outOfReach(recent, now)).toBe(false);
    const k = `reviews:${day(0)}`;
    const q = card(hub, JSON.stringify([old, oldBare, recent]), k);
    expect(pruneReviews(hub, () => false, now)).toBe(0);
    expect(readMeetings(hub, k)!.map((m) => m.title)).toEqual(["Recent"]);
    expect(pruneReviews(hub, (ev) => ev.title === "Recent", now)).toBe(1);
    expect(open(hub, q.id)).toBe(false);
  });

  test("a still-queued backfill keeps the meetings it would read; only-old cards close as 'older than'", () => {
    const hub = new Hub(new Store(":memory:"));
    const old = { title: "Old", day: day(9), start: new Date(now.getTime() - 9 * 86400_000).toISOString() };
    const k = `reviews:${day(0)}`;
    const q = card(hub, JSON.stringify([old]), k);
    queueBackfill(hub, new Date(now.getTime() - 10 * 86400_000).toISOString(), now);
    expect(pruneReviews(hub, () => false, now)).toBe(0);
    expect(readMeetings(hub, k)!.map((m) => m.title)).toEqual(["Old"]);
    settleBackfill(hub, new Date(now.getTime() - 10 * 86400_000).toISOString(), now);
    const reasons: string[] = [];
    const orig = hub.expireQuestion.bind(hub);
    (hub as any).expireQuestion = (id: string, why?: string) => (reasons.push(why ?? ""), orig(id, why));
    expect(pruneReviews(hub, () => false, now)).toBe(1);
    expect(open(hub, q.id)).toBe(false);
    expect(reasons).toEqual(["older than 7 days"]);
  });
});
