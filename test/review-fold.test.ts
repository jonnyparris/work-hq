import { describe, expect, test } from "bun:test";
import { Agents, type CmuxDeps, earlierIso, laterIso, scannedFrom } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { covered, NOTES_GRACE_MS, noNotes, reviewsSince } from "../src/server/review-fold.ts";

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
  });

  test("laterIso / earlierIso: unparseable or missing loses", () => {
    expect(laterIso("2026-09-22T10:00:00Z", "2026-09-24T00:00:00.000Z")).toBe("2026-09-24T00:00:00.000Z");
    expect(laterIso("2026-09-24T10:00:00+01:00", "2026-09-24T00:00:00.000Z")).toBe("2026-09-24T10:00:00+01:00");
    expect(laterIso(undefined, "2026-09-24T00:00:00.000Z")).toBe("2026-09-24T00:00:00.000Z");
    expect(laterIso("2026-09-24T00:00:00Z", undefined)).toBe("2026-09-24T00:00:00Z");
    expect(laterIso("garbage", "2026-09-24T00:00:00Z")).toBe("2026-09-24T00:00:00Z");
    expect(laterIso(undefined, "garbage")).toBeUndefined();
    expect(earlierIso("2026-09-24T00:00:00Z", "2026-09-22T00:00:00Z")).toBe("2026-09-22T00:00:00Z");
    expect(earlierIso(undefined, "2026-09-22T00:00:00Z")).toBe("2026-09-22T00:00:00Z");
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
    expect(toasts.join()).toContain("next one");
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
    await agents.sweep("transcripts"); // the scheduler's rerun passes no since
    expect(prompts[1]).toContain(since);
  });

  test("the folded card's scan reads at most BACKFILL_DAYS back", () => {
    const now = new Date(2026, 8, 24, 9);
    expect(reviewsSince([{ day: "2026-09-01" }], now)).toBe(new Date(now.getTime() - 7 * 86400_000).toISOString());
  });
});
