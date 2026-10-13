import { beforeEach, describe, expect, test } from "bun:test";
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
  const today = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

  test("matching: same title near the start, or read after it began", () => {
    const ev = { title: "Robin / Alex 1-1", start: today(14).toISOString() };
    expect(meetingMatches({ title: "Robin / Alex 1-1", start: today(14, 3).toISOString(), at: today(15).toISOString() }, ev)).toBe(true);
    expect(meetingMatches({ title: "Robin / Alex 1-1", start: today(9).toISOString(), at: today(15).toISOString() }, ev)).toBe(false);
    expect(meetingMatches({ title: "Robin / Alex 1-1", at: today(15).toISOString() }, ev)).toBe(true);
    expect(meetingMatches({ title: "Delta Weekly", at: today(15).toISOString() }, ev)).toBe(false);
  });

  test("a scan closes the open 'just ended' card and stops new ones", () => {
    const start = new Date(Date.now() - 60 * 60_000);
    const end = new Date(Date.now() - 10 * 60_000);
    hub.setEvents([{ id: "e1", title: "Delta Weekly", start: start.toISOString(), end: end.toISOString(), attendees: ["a@x", "b@x", "c@x"], response: "accepted" }]);
    const p = new Prompter(hub);
    p.tick();
    const q = hub.store.questions("open").find((q) => q.kind === "review");
    expect(q).toBeTruthy();
    expect(hub.markScanned([{ title: "Delta Weekly", start: start.toISOString() }])).toBe(1);
    expect(hub.store.question(q!.id)!.status).toBe("expired");
    p.tick();
    expect(hub.store.questions("open").filter((q) => q.kind === "review")).toHaveLength(0);
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
