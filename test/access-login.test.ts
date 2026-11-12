// `whq access-login <app>`: a local job's Cloudflare Access login lapsed. One keyed "Log in now" card per app per day,
// not a free-text 🍍 that sends a triage job every run (10-22..10-29: six for one ClickHouse app, two failed triages).
import { expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessLoginTodo, Hub } from "../src/server/hub.ts";
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
      expect(toasts.at(-1)).toContain(left ? "Login didn't finish" : "analytics.example.com was already logged in");
    }
  } finally {
    if (prev === undefined) delete process.env.WORK_HQ_CLOUDFLARED_BIN;
    else process.env.WORK_HQ_CLOUDFLARED_BIN = prev;
  }
});

// 11-06 12:15: a failed "Log in now" left no record; the ready-analytics memory todo sat beside the keyed card
// through four lapses (11-04..11-08).
const withBin = async (bin: string, fn: () => Promise<void>, timeoutMs?: string) => {
  const prev = process.env.WORK_HQ_CLOUDFLARED_BIN;
  const prevT = process.env.WORK_HQ_CLOUDFLARED_TIMEOUT_MS;
  process.env.WORK_HQ_CLOUDFLARED_BIN = bin;
  if (timeoutMs) process.env.WORK_HQ_CLOUDFLARED_TIMEOUT_MS = timeoutMs;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.WORK_HQ_CLOUDFLARED_BIN;
    else process.env.WORK_HQ_CLOUDFLARED_BIN = prev;
    if (prevT === undefined) delete process.env.WORK_HQ_CLOUDFLARED_TIMEOUT_MS;
    else process.env.WORK_HQ_CLOUDFLARED_TIMEOUT_MS = prevT;
  }
};
const setup = () => {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) });
  const todo = hub.createItem({ title: "Re-login CF Access for analytics. Not done", kind: "task", status: "waiting" });
  return { hub, agents, todo };
};
const journal = (hub: Hub) => hub.store.journal().map((j) => j.text);

test("a failed login is journalled with its exit code and leaves the todo open", async () => {
  await withBin("/usr/bin/false", async () => {
    const { hub, agents, todo } = setup();
    await agents.accessLogin(APP);
    expect(journal(hub)).toContain("Cloudflare Access login for analytics.example.com didn't finish (exit 1)");
    expect(hub.store.item(todo.id)?.status).toBe("waiting");
  });
  await withBin("/nonexistent/cloudflared", async () => {
    const { hub, agents } = setup();
    await agents.accessLogin(APP);
    expect(journal(hub).some((t) => t.startsWith("Cloudflare Access login for analytics.example.com didn't finish (couldn't start"))).toBe(true);
  });
});

test("a login that hangs past the timeout is journalled as a timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfd-"));
  const bin = join(dir, "cloudflared");
  writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(bin, 0o755);
  try {
    await withBin(bin, async () => {
      const { hub, agents } = setup();
      await agents.accessLogin(APP);
      expect(journal(hub).some((t) => t.includes("didn't finish (timed out after"))).toBe(true);
    }, "200");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a login that works settles the app's todo, confirmed, and only that one", async () => {
  await withBin("/usr/bin/true", async () => {
    const { hub, agents, todo } = setup();
    const both = hub.createItem({ title: "Re-login Jira and analytics", kind: "task", status: "waiting" });
    const other = hub.createItem({ title: "Re-login CF Access for other-app", kind: "task", status: "waiting" });
    const idea = hub.createItem({ title: "Make the analytics login last longer", kind: "idea", status: "proposed" });
    const unrelated = hub.createItem({ title: "Review the analytics dashboard", kind: "task", status: "doing" });
    await agents.accessLogin(APP);
    expect(hub.store.item(todo.id)?.status).toBe("done");
    expect(hub.store.item(todo.id)?.confirmedAt).toBeTruthy();
    for (const it of [both, other, idea, unrelated]) expect(hub.store.item(it.id)?.status).toBe(it.status);
    expect(journal(hub).some((t) => t.startsWith("Done: Re-login CF Access for analytics") && t.includes("Access login renewed"))).toBe(true);
  });
});

test("whq access-ok (resolved) settles the todo too; a lapse doesn't", () => {
  const { hub, todo } = setup();
  hub.accessLoginCard({ app: APP }, day("2026-11-04"));
  expect(hub.store.item(todo.id)?.status).toBe("waiting");
  hub.accessLoginCard({ app: APP, resolved: true }, day("2026-11-04", 10));
  expect(hub.store.item(todo.id)?.status).toBe("done");
});

test("accessLoginTodo matches the full host or its first label, word-bounded", () => {
  const h = "ready-analytics-us.ch.example.com";
  expect(accessLoginTodo("Re-login CF Access for ready-analytics-us. Not done", h)).toBe(true);
  expect(accessLoginTodo("cloudflared access login https://ready-analytics-us.ch.example.com", h)).toBe(true);
  expect(accessLoginTodo("Re-auth CF Access for ready-analytics-us so the daily runs", h)).toBe(true);
  expect(accessLoginTodo("Re-login ready-analytics-eu", h)).toBe(false);
  expect(accessLoginTodo("Re-login ready-analytics", h)).toBe(false);
  expect(accessLoginTodo("Log in to jira and ready-analytics-us", h)).toBe(false);
  expect(accessLoginTodo("Ship ready-analytics-us report", h)).toBe(false);
  expect(accessLoginTodo("Login fails on ready-analytics-us dashboard", h)).toBe(false);
  for (const t of ["Re-login Jira+ready-analytics-us", "Re-login Jira/ready-analytics-us", "Re-login Jira, ready-analytics-us", "Re-login Jira & ready-analytics-us", "Re-login Jira / ready-analytics-us", "Re-login Jira or ready-analytics-us",
    "Re-login Jira (and ready-analytics-us)", "Re-login Jira then ready-analytics-us", "Re-login Jira; ready-analytics-us",
    "Re-login https://ready-analytics-us.ch.example.com, then Jira", "Re-login https://ready-analytics-us.ch.example.com+Jira",
    "Re-login https://ready-analytics-us.ch.example.com,Jira", "Re-login Jira | ready-analytics-us", "Re-login Jira — ready-analytics-us",
    "Re-login Jira - ready-analytics-us", "Re-login Jira with ready-analytics-us", "Re-login https://jira.example.com https://ready-analytics-us.ch.example.com",
    "Re-login https://ready-analytics-us.ch.example.com/app,Jira", "Re-login https://ready-analytics-us.ch.example.com/app|Jira",
    "Re-login https://jira.example.com/a,https://ready-analytics-us.ch.example.com", "Re-login Jira (ready-analytics-us)"]) {
    expect(accessLoginTodo(t, h)).toBe(false);
  }
  expect(accessLoginTodo("Re-auth the login provider", "login.example.com")).toBe(false);
  expect(accessLoginTodo("Re-login https://ready-analytics-us.ch.example.com/app/x", h)).toBe(true);
  expect(accessLoginTodo("cloudflared access login https://ready-analytics-us.ch.example.com/app?x=1&y=2", h)).toBe(true);
  expect(accessLoginTodo("Re-login CF Access for ready-analytics-us (prod)", h)).toBe(false); // fails closed
  expect(accessLoginTodo("Re-login Jira (and) ready-analytics-us", h)).toBe(false);
  expect(accessLoginTodo("Re-login Jira (ready)", "ready.example.com")).toBe(false);
  expect(accessLoginTodo("Re-login https://jira.example.com/a?next=ready-analytics-us.ch.example.com", h)).toBe(false);
  expect(accessLoginTodo("Re-login https://ready-analytics-us.ch.example.com?x=1&y=2", h)).toBe(true);
  expect(accessLoginTodo("Re-login plus-analytics", "plus-analytics.example.com")).toBe(true);
  expect(accessLoginTodo("Re-login https://login.example.com", "login.example.com")).toBe(true);
});

test("the gateway login settles its todo; a memory re-import doesn't reopen a settled one", async () => {
  await withBin("/usr/bin/true", async () => {
    const { hub, agents } = setup();
    const gw = hub.createItem({ title: "Re-login CF Access for aigw", kind: "task", status: "waiting", source: { type: "memory", label: "active-todos", key: "memory:active-todos:re-login-aigw" } });
    Object.assign(agents, { sweep: async () => {} }); // gatewayLogin kicks a sweep; nothing to sweep here
    await agents.gatewayLogin("https://aigw.example.com");
    expect(hub.store.item(gw.id)?.status).toBe("done");
    expect(journal(hub)).toContain("Model gateway login renewed (aigw.example.com)");
    hub.createItem({ title: "Re-login CF Access for aigw", kind: "task", status: "waiting", source: { type: "memory", label: "active-todos", key: "memory:active-todos:re-login-aigw" } });
    expect(hub.store.item(gw.id)?.status).toBe("done");
  });
});

// 11-11: "Log in now" said "renewed" at 13:02 and 20:48 in under 0.5 s with no browser, after a 10:44 login. The
// session was live; daily.sh's own check had failed for another reason (`cloudflared access token` needs the network).
test("a login back in under 2 s journals 'already live', a slower one 'renewed'", async () => {
  await withBin("/usr/bin/true", async () => {
    const { hub, agents } = setup();
    await agents.accessLogin(APP); // /usr/bin/true is far under 2 s
    expect(journal(hub).some((t) => t.startsWith("Cloudflare Access login for analytics.example.com was already live"))).toBe(true);
    expect(journal(hub)).not.toContain("Cloudflare Access login renewed (analytics.example.com)");
  });
  const prev = process.env.WORK_HQ_ACCESS_FAST_MS;
  process.env.WORK_HQ_ACCESS_FAST_MS = "0"; // every login counts as slow, as one that opened the browser
  try {
    await withBin("/usr/bin/true", async () => {
      const { hub, agents } = setup();
      await agents.accessLogin(APP);
      expect(journal(hub)).toContain("Cloudflare Access login renewed (analytics.example.com)");
    });
  } finally {
    if (prev === undefined) delete process.env.WORK_HQ_ACCESS_FAST_MS;
    else process.env.WORK_HQ_ACCESS_FAST_MS = prev;
  }
});

test("--rerun puts the launchd label on the card's login and hands it to the dispatcher; a bad label is refused", async () => {
  const hub = new Hub(new Store(":memory:"));
  const calls: [string, string | undefined][] = [];
  hub.dispatcher = { dispatch: async () => undefined, scheduleFromWords: async () => {}, accessLogin: async (app, rerun) => void calls.push([app, rerun]) };
  hub.accessLoginCard({ app: APP, rerun: "com.example.nightly" }, day("2026-11-04"));
  const card = open(hub)[0]!;
  expect(card.options.find((o) => o.id === "login")?.effect).toEqual({ type: "accessLogin", app: APP, rerun: "com.example.nightly" });
  expect(card.context).toContain("Log in and the job reruns.");
  await hub.answer(card.id, "login");
  expect(calls).toEqual([[APP, "com.example.nightly"]]);
  for (const rerun of ["a b", "x;rm -rf ~", "../x", "-k", 42, "com.example.work-hq", "work-hq", "work-hq.dashboard", "WORK-HQ.Dashboard"]) expect(() => hub.accessLoginCard({ app: APP, rerun })).toThrow();
  // The CLI sends "" when --rerun isn't given: no label, the old card.
  hub.accessLoginCard({ app: "https://z.example.com", rerun: "" }, day("2026-11-04"));
  expect(open(hub).find((q) => q.key.includes("z.example.com"))?.options.find((o) => o.id === "login")?.effect).toEqual({ type: "accessLogin", app: "https://z.example.com" });
});

test("Agents.accessLogin with a label kickstarts that launchd job and journals it; a failed kickstart says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lctl-"));
  const bin = join(dir, "launchctl");
  const log = join(dir, "args");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\n`);
  chmodSync(bin, 0o755);
  const prev = process.env.WORK_HQ_LAUNCHCTL_BIN;
  try {
    await withBin("/usr/bin/true", async () => {
      process.env.WORK_HQ_LAUNCHCTL_BIN = bin;
      const { hub, agents } = setup();
      const toasts: string[] = [];
      hub.subscribe((e) => { if (e.type === "toast") toasts.push((e.data as { text: string }).text); });
      await agents.accessLogin(APP, "com.example.nightly");
      expect(readFileSync(log, "utf8").trim()).toBe(`kickstart gui/${process.getuid!()}/com.example.nightly`);
      expect(journal(hub)).toContain("Reran com.example.nightly after the Access login");
      expect(toasts.at(-1)).toContain("Reran com.example.nightly.");

      process.env.WORK_HQ_LAUNCHCTL_BIN = "/usr/bin/false";
      const b = setup();
      await b.agents.accessLogin(APP, "com.example.nightly");
      expect(journal(b.hub)).toContain("Couldn't rerun com.example.nightly after the Access login (exit 1)");

      // A bad label from a stale card never reaches launchctl.
      process.env.WORK_HQ_LAUNCHCTL_BIN = bin;
      const c = setup();
      await c.agents.accessLogin(APP, "x; rm -rf ~");
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
      expect(journal(c.hub).some((t) => t.includes("rerun") || t.startsWith("Reran"))).toBe(false);
      // Nor does Work HQ's own label: its restarts go through POST /api/restart.
      for (const own of ["com.example.work-hq", "work-hq.dashboard"]) await c.agents.accessLogin(APP, own);
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
      expect(journal(c.hub).some((t) => t.includes("rerun") || t.startsWith("Reran"))).toBe(false);
    });
  } finally {
    if (prev === undefined) delete process.env.WORK_HQ_LAUNCHCTL_BIN;
    else process.env.WORK_HQ_LAUNCHCTL_BIN = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
