import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { gatewayAuthError, scannedFrom } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { sameWork } from "../src/server/dedupe.ts";
import { Hub, meetingMatches } from "../src/server/hub.ts";
import { Prompter } from "../src/server/prompter.ts";

let hub: Hub;
beforeEach(() => {
  hub = new Hub(new Store(":memory:"));
});

describe("sameWork", () => {
  // Pairs seen in real use, anonymised.
  const same: Array<[string, string]> = [
    ["Q3/Q4 planning with Dana and Lee", "Q4 planning with Dana and Lee"],
    ["Get access to flows.example.org (CI account) domains", "Get domain access on the CI account for flows.example.org"],
    ["Send Mo a wish list of product-support asks (Delta, Pre-render, others)", "Send Mo the product-support wish list"],
    ["Check that new reviewer notes follow the template (spot-check about 5)", "Spot-check ~5 new reviewer notes against the e14a7fa1 template"],
    ["Write up Acme product bets on the wiki (from recent meeting transcripts)", "Acme product bets → wiki"],
  ];
  const different: Array<[string, string]> = [
    ["Sam mentioned you on PAY-1741: answer, hand to the owner, or ignore", "Kai mentioned you on SEC-130437: answer, hand to the owner, or ignore"],
    ["Prep: Sofia / Alex 1-1", "Prep: Beatriz / Alex 1-1"],
    ["CDFZG 09-24 (notes-only, lower confidence)", "Apéro 09-18 items (notes-only, lower confidence)"],
    ["Escalate GTG engineering resourcing to Dane", "GTG escalations still route to you as Eng Owner"],
  ];
  for (const [a, b] of same) test(`same: ${a}`, () => expect(sameWork(a, b)).toBe(true));
  for (const [a, b] of different) test(`different: ${a}`, () => expect(sameWork(a, b)).toBe(false));
});

describe("cross-source duplicates", () => {
  test("a retitled memory todo merges into the open item instead of becoming a second one", () => {
    const a = hub.createItem({ title: "Send Mo a wish list of product-support asks (Delta, Pre-render, others)", status: "doing", source: { type: "voice" } });
    const b = hub.createItem({ title: "Send Mo the product-support wish list", status: "proposed", source: { type: "memory", key: "memory:active-todos:send-mo" } });
    expect(b.id).toBe(a.id);
    expect(hub.store.items()).toHaveLength(1);
    // The next import finds it by the merged key, not as a new item.
    expect(hub.store.itemBySourceKey("memory:active-todos:send-mo")?.id).toBe(a.id);
  });

  test("something the owner dropped doesn't come back under a new wording", () => {
    const a = hub.createItem({ title: "Q3/Q4 planning with Dana and Lee", status: "proposed", source: { type: "memory", key: "memory:a" } });
    hub.setStatus(a.id, "dropped");
    const b = hub.createItem({ title: "Q4 planning with Dana and Lee", status: "proposed", source: { type: "memory", key: "memory:b" } });
    expect(b.id).toBe(a.id);
    expect(hub.store.item(a.id)!.status).toBe("dropped");
    expect(hub.store.journal().some((j) => j.text.startsWith("Not re-adding"))).toBe(true);
  });

  test("but saying it again brings it back", () => {
    const a = hub.createItem({ title: "Q3/Q4 planning with Dana and Lee", status: "proposed", source: { type: "memory", key: "memory:a" } });
    hub.setStatus(a.id, "dropped");
    const b = hub.createItem({ title: "Q4 planning with Dana and Lee", status: "inbox", source: { type: "voice" } });
    expect(b.id).not.toBe(a.id);
  });

  test("checks and manual adds are never merged", () => {
    const a = hub.createItem({ title: "Q4 planning with Dana and Lee", status: "proposed", source: { type: "memory", key: "memory:a" } });
    const b = hub.createItem({ title: "Q4 planning with Dana and Lee", status: "today", source: { type: "manual" } });
    expect(b.id).not.toBe(a.id);
  });

  test("dedupeExisting drops the unconfirmed copy and closes its questions", () => {
    const keep = hub.createItem({ title: "Reply to Sofia's Credential Vaults ping with RM-31582", status: "proposed", source: { type: "agent", key: "agent:x" } });
    // Simulate a copy created before this check existed.
    const now = new Date(Date.now() + 1000).toISOString();
    hub.store.putItem({ ...keep, id: "it_dup", source: { type: "memory", key: "memory:y" }, createdAt: now, updatedAt: now });
    hub.ask({ kind: "state", itemId: "it_dup", key: "state:it_dup", priority: 1, prompt: "x", options: [] });
    expect(hub.dedupeExisting()).toBe(1);
    expect(hub.store.item("it_dup")!.status).toBe("dropped");
    expect(hub.store.item(keep.id)!.status).toBe("proposed");
    expect(hub.store.openQuestionByKey("state:it_dup")).toBeUndefined();
    expect(hub.store.itemBySourceKey("memory:y")?.id).toBe(keep.id);
  });
});

describe("meeting cards vs transcript scans", () => {
  // Mid-afternoon, always: "an hour ago" just after midnight is yesterday, and these tests read today's
  // calendar (bun test runs in UTC, so they failed 00:00–01:00 UTC, 10-23).
  beforeEach(() => { const d = new Date(); d.setHours(16, 0, 0, 0); setSystemTime(d); });
  afterEach(() => setSystemTime());
  const today = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

  test("matching: same title near the start, or read after it began", () => {
    const ev = { title: "Robin / Alex 1-1", start: today(14).toISOString() };
    expect(meetingMatches({ title: "Robin / Alex 1-1", start: today(14, 3).toISOString(), at: today(15).toISOString() }, ev)).toBe(true);
    expect(meetingMatches({ title: "Robin / Alex 1-1", start: today(9).toISOString(), at: today(15).toISOString() }, ev)).toBe(false);
    expect(meetingMatches({ title: "Robin / Alex 1-1", at: today(15).toISOString() }, ev)).toBe(true);
    expect(meetingMatches({ title: "Delta Weekly", at: today(15).toISOString() }, ev)).toBe(false);
  });

  // The end-of-day card (prompter askUnrecorded) is asked from 90 min before the end of the day: pin a weekday evening.
  const eve = (h: number, m = 0) => new Date(2026, 8, 23, h, m); // Wed
  const card = () => hub.store.questions("open").find((q) => q.key === "reviews:eod:2026-09-23");

  test("a scan closes the unrecorded-meetings card and keeps the meeting off it", () => {
    const start = eve(17), end = eve(17, 30);
    hub.setEvents([{ id: "e1", title: "Delta Weekly", start: start.toISOString(), end: end.toISOString(), attendees: ["a@x", "b@x", "c@x"], response: "accepted" }]);
    const p = new Prompter(hub);
    p.tick(eve(17, 40));
    const q = card();
    expect(q?.context).toBe("- Delta Weekly");
    expect(hub.markScanned([{ title: "Delta Weekly", start: start.toISOString() }], eve(17, 45))).toBe(1);
    expect(hub.store.question(q!.id)!.status).toBe("expired");
    p.tick(eve(17, 50));
    expect(hub.store.questions("open").filter((q) => q.kind === "review")).toHaveLength(0);
    // A later meeting with no notes asks again: the scan closed the card, nobody answered it.
    hub.setEvents([
      { id: "e1", title: "Delta Weekly", start: start.toISOString(), end: end.toISOString(), attendees: ["a@x", "b@x", "c@x"], response: "accepted" },
      { id: "e2", title: "Echo sync", start: eve(18).toISOString(), end: eve(18, 20).toISOString(), attendees: ["a@x", "b@x"], response: "accepted" },
    ]);
    p.tick(eve(18, 30));
    expect(card()?.context).toBe("- Echo sync");
  });

  test("a meeting joins the card after the notes hold, only when the transcript sweep runs", async () => {
    const { REVIEW_HOLD_MIN } = await import("../src/shared/meetings.ts");
    const { config } = await import("../src/server/config.ts");
    const prev = { ...config.sweeps, disabled: [...config.sweeps.disabled] };
    try {
      hub.setEvents([{ id: "e2", title: "Echo Weekly", start: eve(17).toISOString(), end: eve(17, 30).toISOString(), attendees: ["a@x", "b@x", "c@x"], response: "accepted" }]);
      config.sweeps.enabled = true;
      config.sweeps.disabled = [];
      new Prompter(hub).tick(eve(17, 29 + REVIEW_HOLD_MIN));
      expect(card()).toBeUndefined();
      // A scan inside the hold finds its notes: it never goes on the card.
      hub.markScanned([{ title: "Echo Weekly", start: eve(17).toISOString() }], eve(18, 15));
      new Prompter(hub).tick(eve(17, 31 + REVIEW_HOLD_MIN));
      expect(card()).toBeUndefined();
      // No transcript sweep: nothing to wait for, so no hold.
      hub.setEvents([{ id: "e3", title: "Foxtrot sync", start: eve(18).toISOString(), end: eve(18, 30).toISOString(), attendees: ["a@x", "b@x", "c@x"], response: "accepted" }]);
      config.sweeps.disabled = ["transcripts"];
      new Prompter(hub).tick(eve(18, 31));
      expect(card()?.context).toBe("- Foxtrot sync");
    } finally {
      Object.assign(config.sweeps, prev);
    }
  });

  test("a meeting answered on its row, or by its own pre-upgrade card, stays off the card", () => {
    const evs = ["Row talk", "Old card", "Plain"].map((title, i) => ({ id: `r${i}`, title, start: eve(9 + i).toISOString(), end: eve(9 + i, 30).toISOString(), attendees: ["a@x", "b@x"], response: "accepted" as const }));
    hub.setEvents(evs);
    hub.markReviewed("r0", eve(10));
    hub.store.putQuestion({ id: "q-old", kind: "review", eventId: "r1", key: "review:r1", prompt: "Old card just ended.", options: [], priority: 70, status: "answered", answer: "Nothing new", answeredAt: eve(11).toISOString(), createdAt: eve(10, 40).toISOString() });
    const p = new Prompter(hub);
    p.tick(eve(17, 40));
    expect(card()?.context).toBe("- Plain");
    // Words sent from the row after it joined the card (a draft outlives the row's hour): it comes off, the card closes.
    const q = card()!;
    expect(hub.markReviewed("r2", eve(17, 45))).toBe(1);
    expect(hub.store.question(q.id)).toMatchObject({ status: "expired", answer: "answered on its row" });
    p.tick(eve(17, 50));
    expect(card()).toBeUndefined();
    p.tick(new Date(2026, 8, 24, 7)); // and it isn't handed to the morning card
    expect(hub.store.questions("open").filter((q) => q.kind === "review")).toHaveLength(0);
  });

  test("words from a row take only that meeting off a card", () => {
    hub.setEvents(["Alpha sync", "Bravo sync"].map((title, i) => ({ id: `w${i}`, title, start: eve(15 + i).toISOString(), end: eve(15 + i, 30).toISOString(), attendees: ["a@x", "b@x"], response: "accepted" as const })));
    const p = new Prompter(hub);
    p.tick(eve(17, 40));
    const q = card()!;
    expect(hub.markReviewed("w0", eve(17, 45))).toBe(0);
    expect(hub.store.question(q.id)).toMatchObject({ status: "open", context: "- Bravo sync" });
    p.tick(eve(17, 50));
    expect(card()?.context).toBe("- Bravo sync");
  });

  test("row answers match the event, not a lookalike: same-title neighbours, twins, start-less rows, a vanished event", () => {
    const e = (id: string, title: string, h: number, m = 0) => ({ id, title, start: eve(h, m).toISOString(), end: eve(h, m + 20).toISOString(), attendees: ["a@x", "b@x"], response: "accepted" as const });
    // Back-to-back same title, a longer title that contains it, and a twin instance of the first (re-created series).
    hub.setEvents([e("s1", "Sync", 14), e("s2", "Sync", 14, 30), e("s3", "Sync planning", 15), e("s1b", "Sync", 14)]);
    // A morning card from yesterday with a start-less row of the same title.
    hub.store.setKv("reviews:2026-09-23", JSON.stringify([{ title: "Sync", day: "2026-09-22" }, { title: "Other", day: "2026-09-22" }]));
    hub.store.putQuestion({ id: "morning", kind: "review", key: "reviews:2026-09-23", prompt: "Yesterday's meetings (2)", context: "- Sync\n- Other", options: [], priority: 70, status: "open", createdAt: eve(7).toISOString() });
    const p = new Prompter(hub);
    p.tick(eve(17, 40));
    expect(card()?.context).toBe("- Sync\n- Sync\n- Sync planning"); // s1 and s1b are one meeting
    hub.markReviewed("s1", eve(17, 45));
    expect(card()?.context).toBe("- Sync\n- Sync planning");
    expect(JSON.parse(hub.store.kv("reviews:2026-09-23")!).map((m: any) => m.title)).toEqual(["Sync", "Other"]);
    p.tick(eve(17, 50)); // the twin isn't re-added
    expect(card()?.context).toBe("- Sync\n- Sync planning");
    // Answering a twin takes the row stored under the other id off too.
    const twin = new Hub(new Store(":memory:"));
    twin.setEvents([e("t1", "Sync", 14), e("t1b", "Sync", 14)]);
    const tp = new Prompter(twin);
    tp.tick(eve(17, 40));
    expect(JSON.parse(twin.store.kv("unrecordedMeetings")!).meetings.map((m: any) => m.eventId)).toEqual(["t1"]);
    expect(twin.store.questions("open").filter((q) => q.kind === "review").map((q) => q.context)).toEqual(["- Sync"]);
    twin.markReviewed("t1b", eve(17, 45));
    expect(twin.store.questions("open").filter((q) => q.kind === "review")).toHaveLength(0);
    tp.tick(eve(17, 50));
    expect(twin.store.questions("open").filter((q) => q.kind === "review")).toHaveLength(0);
    expect(JSON.parse(twin.store.kv("unrecordedMeetings")!).meetings).toEqual([]);
    // The event left the calendar before the words were sent: its row still comes off, by id.
    hub.store.replaceEvents("2026-09-23", "2026-09-23", [e("s3", "Sync planning", 15)]);
    hub.markReviewed("s2", eve(17, 55));
    expect(card()?.context).toBe("- Sync planning");
    p.tick(new Date(2026, 8, 24, 7));
    expect(hub.store.questions("open").filter((q) => q.kind === "review" && q.key.startsWith("reviews:2026-09-24")).map((q) => q.context)).toEqual(["- Sync planning"]);
  });

  test("items' meeting labels count as scanned", () => {
    const past = new Date(Date.now() - 30 * 60_000);
    const hhmm = past.toTimeString().slice(0, 5);
    const it = hub.createItem({ title: "x", source: { type: "transcript", label: `Delta Weekly ${hhmm}` } });
    expect(scannedFrom({}, [it]).map((m) => m.title)).toEqual(["Delta Weekly"]);
  });
});

describe("gateway auth", () => {
  test("recognises pi's provider key failure and the Access app", () => {
    const err = `API key auth failed for provider corp-llm: Failed to resolve API key for provider "corp-llm" from shell command: if [ -n "\${CORP_LLM_TOKEN:-}" ]; then printf %s "$CORP_LLM_TOKEN"; else exec 'cloudflared' access token -app='https://llm.example.com'; fi`;
    expect(gatewayAuthError(err)).toEqual({ provider: "corp-llm", app: "https://llm.example.com" });
    expect(gatewayAuthError("Request timed out.")).toBeUndefined();
  });
});

test("a run we killed on timeout says so, not pi's last stderr line", async () => {
  const { runError } = await import("../src/server/agents.ts");
  const stderr = "Warning: Extension package builtin:mcp is slow\n";
  expect(runError({ code: 143, timedOut: true, timeoutMin: 12, stderr })).toBe("timed out after 12 min");
  expect(runError({ code: 143, timedOut: true, timeoutMin: 12, lastError: "Request timed out.", stderr })).toBe("timed out after 12 min");
  expect(runError({ code: 1, timedOut: false, timeoutMin: 12, stderr })).toBe("pi exited 1: Warning: Extension package builtin:mcp is slow");
  expect(runError({ code: 1, timedOut: false, timeoutMin: 12, lastError: "Request timed out.", stderr })).toBe("Request timed out.");
  expect(runError({ code: null, signal: "SIGKILL", timedOut: false, timeoutMin: 12, stderr: "" })).toStartWith("pi killed by SIGKILL");
  expect(runError({ code: null, signal: "SIGTERM", timedOut: false, timeoutMin: 12, stderr: "" })).toBe("pi killed by SIGTERM");
});
