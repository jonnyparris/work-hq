// `whq access-login <app>`: a local job's Cloudflare Access login lapsed. One keyed "Log in now" card per app per day,
// not a free-text 🍍 that sends a triage job every run (10-22..10-29: six for one ClickHouse app, two failed triages).
import { expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { Agents } from "../src/server/agents.ts";

const APP = "https://analytics.example.com";
const day = (d: string, h = 9) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00`);
const open = (hub: Hub) => hub.store.questions("open").filter((q) => q.key.startsWith("access-login:"));

test("two lapsed runs on the same day leave one open card with a working login button", () => {
  const hub = new Hub(new Store(":memory:"));
  expect(hub.accessLoginCard({ app: APP, reason: "browser-run-growth daily skipped" }, day("2026-11-04", 8)).asked).toBe(true);
  expect(hub.accessLoginCard({ app: APP }, day("2026-11-04", 12)).asked).toBe(false);
  const cards = open(hub);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.key).toBe("access-login:analytics.example.com:2026-11-04");
  expect(cards[0]!.context).toContain("browser-run-growth daily skipped");
  expect(cards[0]!.options.find((o) => o.id === "login")?.effect).toEqual({ type: "accessLogin", app: APP });
  expect(hub.store.jobs().filter((j) => j.kind === "triage")).toHaveLength(0);
});

test("answered (Later) is not asked again that day; the next day asks again and closes yesterday's", async () => {
  const hub = new Hub(new Store(":memory:"));
  hub.accessLoginCard({ app: APP }, day("2026-11-04"));
  await hub.answer(open(hub)[0]!.id, "later");
  expect(hub.accessLoginCard({ app: APP }, day("2026-11-04", 14)).asked).toBe(false);
  expect(open(hub)).toHaveLength(0);

  const hub2 = new Hub(new Store(":memory:"));
  hub2.accessLoginCard({ app: APP }, day("2026-11-04"));
  const r = hub2.accessLoginCard({ app: APP }, day("2026-11-05"));
  expect(r).toMatchObject({ asked: true, closed: 1 });
  expect(open(hub2).map((q) => q.key)).toEqual(["access-login:analytics.example.com:2026-11-05"]);
});

test("after a login (failed, or lapsed again) or a resolve, the same day asks again", async () => {
  const hub = new Hub(new Store(":memory:"));
  hub.accessLoginCard({ app: APP }, day("2026-11-04", 8));
  await hub.answer(open(hub)[0]!.id, "login");
  expect(hub.accessLoginCard({ app: APP }, day("2026-11-04", 10)).asked).toBe(true);
  hub.accessLoginCard({ app: APP, resolved: true }, day("2026-11-04", 11));
  expect(open(hub)).toHaveLength(0);
  expect(hub.accessLoginCard({ app: APP }, day("2026-11-04", 14)).asked).toBe(true);
  expect(open(hub)).toHaveLength(1);
});

test("resolved closes the app's open card and asks nothing; other apps' cards stay", () => {
  const hub = new Hub(new Store(":memory:"));
  hub.accessLoginCard({ app: APP }, day("2026-11-04"));
  hub.accessLoginCard({ app: "https://other.example.com/" }, day("2026-11-04"));
  expect(hub.accessLoginCard({ app: `${APP}/`, resolved: true }, day("2026-11-04", 10))).toMatchObject({ asked: false, closed: 1 });
  expect(open(hub).map((q) => q.key)).toEqual(["access-login:other.example.com:2026-11-04"]);
});

test("Log in now hands the app to the dispatcher; a bad app is refused", async () => {
  const hub = new Hub(new Store(":memory:"));
  const calls: string[] = [];
  hub.dispatcher = { dispatch: async () => undefined, scheduleFromWords: async () => {}, accessLogin: async (app) => void calls.push(app) };
  hub.accessLoginCard({ app: APP }, day("2026-11-04"));
  await hub.answer(open(hub)[0]!.id, "login");
  expect(calls).toEqual([APP]);
  for (const app of ["http://x.example.com", "https://x.example.com/path", "https://x.example.com; rm -rf ~", ""]) {
    expect(() => hub.accessLoginCard({ app })).toThrow();
  }
  // A non-string reason (JSON from any caller) is ignored, not a TypeError.
  expect(hub.accessLoginCard({ app: "https://y.example.com", reason: 42 }).asked).toBe(true);
  // Only `resolved: true` closes: a stringly "false" is a lapse, so the open card stays (neither closed nor re-asked).
  expect(hub.accessLoginCard({ app: "https://y.example.com", resolved: "false" })).toMatchObject({ asked: false, closed: 0 });
  expect(open(hub).filter((q) => q.key.includes("y.example.com"))).toHaveLength(1);
});

test("Agents.accessLogin: a login that works closes the app's cards; one that fails leaves them and says so", async () => {
  const prev = process.env.WORK_HQ_CLOUDFLARED_BIN;
  try {
    for (const [bin, left] of [["/usr/bin/false", 1], ["/usr/bin/true", 0]] as const) {
      process.env.WORK_HQ_CLOUDFLARED_BIN = bin;
      const hub = new Hub(new Store(":memory:"));
      const toasts: string[] = [];
      hub.subscribe((e) => { if (e.type === "toast") toasts.push((e.data as { text: string }).text); });
      const agents = new Agents(hub, { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) });
      hub.accessLoginCard({ app: APP });
      await agents.accessLogin(APP);
      expect(open(hub)).toHaveLength(left);
      expect(toasts.at(-1)).toContain(left ? "Login didn't finish" : "Logged in to analytics.example.com");
    }
  } finally {
    if (prev === undefined) delete process.env.WORK_HQ_CLOUDFLARED_BIN;
    else process.env.WORK_HQ_CLOUDFLARED_BIN = prev;
  }
});
