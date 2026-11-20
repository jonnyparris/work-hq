import { describe, expect, test } from "bun:test";
import { checkDue, staleCheckItems } from "../src/server/checks.ts";
import { Store } from "../src/server/db.ts";
import { Hub, quietStatus } from "../src/server/hub.ts";

describe("morning checks", () => {
  test("due once per day, retried after an hour", () => {
    const now = new Date(2026, 9, 6, 9, 0);
    expect(checkDue({}, now)).toBe(true);
    expect(checkDue({ lastOkAt: new Date(2026, 9, 6, 8, 30).toISOString() }, now)).toBe(false);
    expect(checkDue({ lastOkAt: new Date(2026, 9, 5, 8, 30).toISOString() }, now)).toBe(true);
    expect(checkDue({ lastRunAt: new Date(2026, 9, 6, 8, 30).toISOString() }, now)).toBe(false);
    expect(checkDue({ lastRunAt: new Date(2026, 9, 6, 7, 30).toISOString() }, now)).toBe(true);
  });

  test("after: held until that time, and an earlier run today doesn't count", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 6, h, m);
    expect(checkDue({}, at(16, 59), "17:00")).toBe(false);
    expect(checkDue({}, at(17, 0), "17:00")).toBe(true);
    expect(checkDue({ lastOkAt: at(9).toISOString(), lastRunAt: at(9).toISOString() }, at(17, 5), "17:00")).toBe(true);
    expect(checkDue({ lastOkAt: at(17, 1).toISOString() }, at(18), "17:00")).toBe(false);
  });

  test("everyMin: due on the interval, not once a day, and still held by after", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 6, h, m);
    expect(checkDue({}, at(9), undefined, 10)).toBe(true);
    expect(checkDue({ lastOkAt: at(8, 55).toISOString(), lastRunAt: at(8, 55).toISOString() }, at(9), undefined, 10)).toBe(false);
    expect(checkDue({ lastOkAt: at(8, 50).toISOString(), lastRunAt: at(8, 50).toISOString() }, at(9), undefined, 10)).toBe(true);
    expect(checkDue({}, at(16), "17:00", 10)).toBe(false);
  });

  test("closes only this check's open items that dropped out of the report", () => {
    const hub = new Hub(new Store(":memory:"));
    const src = (key: string, label = "unlanded") => ({ type: "check" as const, label, key });
    const still = hub.createItem({ title: "still", source: src("a") });
    const gone = hub.createItem({ title: "gone", source: src("b") });
    hub.createItem({ title: "other check", source: src("c", "other") });
    hub.createItem({ title: "already done", status: "done", source: src("d") });
    hub.createItem({ title: "manual", source: { type: "manual" } });
    const stale = staleCheckItems(hub.store.items(), "unlanded", { items: [{ title: "still", source: src("a") }] });
    expect(stale.map((i) => i.id)).toEqual([gone.id]);
    expect(still.id).toBeTruthy();
  });

  test("a re-report keeps the status the owner set", () => {
    const hub = new Hub(new Store(":memory:"));
    const it = hub.createItem({ title: "x", source: { type: "check", label: "unlanded", key: "k" } });
    hub.setStatus(it.id, "waiting");
    hub.ingestReport({ items: [{ title: "x", source: { type: "check", label: "unlanded", key: "k" } }] });
    expect(hub.store.item(it.id)!.status).toBe("waiting");
  });

  // 11-05: two items an agent set Waiting and three weekly reviews an agent set Done were re-asked after
  // the next check run: an agent's whq report update doesn't stamp confirmedAt, and the re-report came in as inbox.
  test("a re-report keeps the status an agent set, and asks no inbox card", async () => {
    const { Prompter } = await import("../src/server/prompter.ts");
    const hub = new Hub(new Store(":memory:"));
    const src = (key: string) => ({ type: "check" as const, label: "closeable", key });
    const waiting = hub.createItem({ title: "Close TICKET-1?", kind: "ticket", source: src("closeable:TICKET-1") });
    const done = hub.createItem({ title: "cf-readiness: 18 changes", kind: "review", source: src("cf-readiness:2026-10-26") });
    hub.ingestReport({ updates: [{ id: waiting.id, status: "waiting", note: "acceptance criteria not met" }, { id: done.id, status: "done" }] });
    expect(hub.store.item(waiting.id)!.confirmedAt).toBeUndefined();
    hub.ingestReport({
      items: [
        { title: "Close TICKET-1?", kind: "ticket", source: src("closeable:TICKET-1") },
        { title: "cf-readiness: 18 changes", kind: "review", status: "inbox", source: src("cf-readiness:2026-10-26") },
      ],
    });
    expect(hub.store.item(waiting.id)!.status).toBe("waiting");
    expect(hub.store.item(done.id)!.status).toBe("done");
    new Prompter(hub).tick(new Date(2026, 10, 5, 10, 0));
    expect(hub.store.questions("open").filter((q) => q.key.startsWith("inbox:"))).toEqual([]);
  });

  test("quietStatus", () => {
    const t = "2026-11-05T00:00:00Z";
    expect(quietStatus({ status: "waiting" }, "inbox", false)).toBe("inbox");
    expect(quietStatus({ status: "waiting" }, undefined, true)).toBe("waiting");
    expect(quietStatus({ status: "waiting" }, "inbox", true)).toBe("waiting");
    expect(quietStatus({ status: "done" }, "inbox", true)).toBe("done");
    expect(quietStatus({ status: "inbox" }, "inbox", true)).toBe("inbox");
    expect(quietStatus({ status: "waiting" }, "today", true)).toBe("today");
    expect(quietStatus({ status: "waiting", confirmedAt: t }, "today", true)).toBe("waiting");
    expect(quietStatus({ status: "done", checkClosed: t }, "inbox", true)).toBe("inbox");
    expect(quietStatus({ status: "done", checkClosed: t, confirmedAt: t }, "inbox", true)).toBe("inbox");
    expect(quietStatus({ status: "done", checkClosed: t }, "today", true)).toBe("today");
    expect(quietStatus({ status: "done", checkClosed: t, confirmedAt: t }, "today", true)).toBe("done");
  });

  test("a re-import that names a real status still applies it", () => {
    const hub = new Hub(new Store(":memory:"));
    const it = hub.createItem({ title: "x", source: { type: "agent", key: "k" } });
    hub.ingestReport({ updates: [{ id: it.id, status: "waiting" }] });
    hub.ingestReport({ items: [{ title: "x", status: "today", source: { type: "agent", key: "k" } }] });
    expect(hub.store.item(it.id)!.status).toBe("today");
  });
});

describe("Checks.run", () => {
  test("ingests items from a command, then closes them when they stop being reported", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const hub = new Hub(new Store(":memory:"));
    const checks = new Checks(hub);
    const report = JSON.stringify({ items: [{ title: "Merged but not landed: x!1", kind: "task", source: { key: "unlanded:x!1" } }] });
    await checks.run({ name: "unlanded", command: `echo '${report}'; exit 1` });
    const [it] = hub.store.items();
    expect(it).toMatchObject({ title: "Merged but not landed: x!1", status: "inbox", source: { type: "check", label: "unlanded" } });
    expect(hub.store.syncState("check:unlanded").lastOkAt).toBeTruthy();
    await checks.run({ name: "unlanded", command: `echo '{"items":[]}'` });
    expect(hub.store.item(it!.id)!.status).toBe("done");
  });

  test("an item the check closed comes back when the check reports it again; an agent's close doesn't", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const hub = new Hub(new Store(":memory:"));
    const checks = new Checks(hub);
    const report = (...keys: string[]) => `echo '${JSON.stringify({ items: keys.map((key) => ({ title: `Agent failing ${key}`, kind: "task", source: { key } })) })}'`;
    await checks.run({ name: "mr-failing", command: report("a", "b") });
    const byKey = (k: string) => hub.store.items().find((i) => i.source.key === k)!;
    hub.ingestReport({ updates: [{ id: byKey("b").id, status: "done" }] });
    await checks.run({ name: "mr-failing", command: report("b") });
    expect(byKey("a").status).toBe("done");
    await checks.run({ name: "mr-failing", command: report("a", "b") });
    expect(byKey("a").status).toBe("inbox");
    expect(byKey("a").checkClosed).toBeUndefined();
    expect(byKey("b").status).toBe("done");
    // Closed by the check, then dropped by the owner: the owner's call wins (confirmedAt).
    await checks.run({ name: "mr-failing", command: report("b") });
    hub.setStatus(byKey("a").id, "dropped");
    await checks.run({ name: "mr-failing", command: report("a", "b") });
    expect(byKey("a").status).toBe("dropped");
  });

  test("check-closed: one write; an owner-touched item still comes back; a same-status settle ends it", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const hub = new Hub(new Store(":memory:"));
    const checks = new Checks(hub);
    const report = (...keys: string[]) => `echo '${JSON.stringify({ items: keys.map((key) => ({ title: `Failing ${key}`, kind: "task", source: { key } })) })}'`;
    await checks.run({ name: "f", command: report("a", "b", "c") });
    const byKey = (k: string) => hub.store.items().find((i) => i.source.key === k)!;
    hub.setStatus(byKey("a").id, "today"); // owner touched: confirmedAt
    const events: string[] = [];
    hub.subscribe((e) => e.type === "item" && events.push((e.data as { source: { key: string } }).source.key));
    await checks.run({ name: "f", command: report() });
    expect(events.filter((k) => k === "a")).toEqual(["a"]);
    expect(byKey("a")).toMatchObject({ status: "done", checkClosed: expect.any(String) });
    // An agent confirms b done (same status); the owner confirms c done.
    hub.ingestReport({ updates: [{ id: byKey("b").id, status: "done", checkClosed: "forged" } as never] });
    hub.setStatus(byKey("c").id, "done");
    expect(byKey("b").checkClosed).toBeUndefined();
    await checks.run({ name: "f", command: report("a", "b", "c") });
    expect([byKey("a").status, byKey("b").status, byKey("c").status]).toEqual(["inbox", "done", "done"]);
  });

  test("everyMin: toasts only items it had not reported before", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const hub = new Hub(new Store(":memory:"));
    const toasts: string[] = [];
    hub.toast = ((text: string) => void toasts.push(text)) as Hub["toast"];
    const checks = new Checks(hub);
    const item = (key: string) => ({ title: `Agent failing ${key}`, kind: "task", source: { key } });
    const run = (...keys: string[]) => checks.run({ name: "mr-failing", command: `echo '${JSON.stringify({ items: keys.map(item) })}'`, everyMin: 10 });
    await run("a");
    await run("a");
    await run("a", "b");
    await run("b");
    expect(toasts).toEqual(["mr-failing: 1 new to look at", "mr-failing: 1 new to look at"]);
    expect(hub.store.items().find((i) => i.source.key === "a")!.status).toBe("done");
  });

  test("no JSON is an error, not an empty board", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const hub = new Hub(new Store(":memory:"));
    hub.createItem({ title: "keep", source: { type: "check", label: "unlanded", key: "k" } });
    await new Checks(hub).run({ name: "unlanded", command: "echo 'fatal: timed out' >&2; exit 2" });
    expect(hub.store.syncState("check:unlanded").error).toContain("fatal: timed out");
    expect(hub.store.items()[0]!.status).toBe("inbox");
  });

  // 11-16..11-20: jira-mentions failed every morning; only the latest error was kept and a success wiped it.
  test("failures are counted per day and error class, and a success keeps the counts", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const hub = new Hub(new Store(":memory:"));
    const checks = new Checks(hub);
    for (let i = 0; i < 3; i++) await checks.run({ name: "flaky", command: `echo 'boom ${i}' >&2; exit 1` });
    await checks.run({ name: "flaky", command: "echo 'fatal: no JIRA Access token; run: cloudflared access login' >&2; exit 2" });
    await checks.run({ name: "flaky", command: "exec sleep 5", timeoutSec: 0.2 });
    await checks.run({ name: "flaky", command: `echo '{"items":[]}'` });
    const s = hub.store.syncState("check:flaky");
    expect(s.error).toBeUndefined();
    expect(Object.keys(s.failures!)).toHaveLength(1);
    const today = Object.values(s.failures!)[0]!;
    expect(today["exit 1"]).toEqual({ n: 3, last: "exit 1, no JSON report: boom 2" });
    expect(today.auth!.n).toBe(1);
    expect(today["timed out"]!.n).toBe(1);
    expect(today["timed out"]!.last).toStartWith("timed out, no JSON report");
  });

  test("a failing check's output is masked in error and failures, even across the 200-char cut", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const hub = new Hub(new Store(":memory:"));
    const secret = "glpat-abcdefghij1234567890";
    await new Checks(hub).run({ name: "leaky", command: `echo 'GITLAB_TOKEN=${secret}' >&2; printf '%0190d' 0 >&2; exit 1` });
    const s = hub.store.syncState("check:leaky");
    // The 200-char tail starts inside the token: its last 9 chars would leak if redaction ran after the cut.
    expect(s.error).not.toContain("234567890");
    expect(JSON.stringify(s.failures)).not.toContain("234567890");
    await new Checks(hub).run({ name: "killed", command: "kill -9 $$" });
    expect(hub.store.syncState("check:killed").error).toStartWith("no exit code, no JSON report");
  });

  test("a report that fails to ingest counts as 'threw' and still throws", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const hub = new Hub(new Store(":memory:"));
    hub.ingestReport = () => {
      throw new Error("bad report");
    };
    const leaky = new Hub(new Store(":memory:"));
    leaky.ingestReport = () => {
      throw new Error("push failed GITLAB_TOKEN=glpat-abcdefghij1234567890");
    };
    await expect(new Checks(leaky).run({ name: "t", command: `echo '{"items":[]}'` })).rejects.toThrow();
    const ls = leaky.store.syncState("check:t");
    expect(ls.error).toBe("threw: push failed GITLAB_TOKEN=[redacted]");
    expect(JSON.stringify(ls.failures)).not.toContain("glpat");
    await expect(new Checks(hub).run({ name: "t", command: `echo '{"items":[]}'` })).rejects.toThrow("bad report");
    const s = hub.store.syncState("check:t");
    expect(Object.values(s.failures!)[0]!.threw).toEqual({ n: 1, last: "threw: bad report" });
    expect(s.error).toBe("threw: bad report");
  });

  test("recordFailure drops days past FAILURE_DAYS; failureClass sorts errors", async () => {
    const { recordFailure, failureClass, FAILURE_DAYS } = await import("../src/server/checks.ts");
    let f = {};
    for (let d = 1; d <= 35; d++) f = recordFailure(f, "exit 1", "x", new Date(2026, 9, d, 9));
    expect(Object.keys(f)).toHaveLength(FAILURE_DAYS);
    expect(Object.keys(f).sort()[0]).toBe("2026-10-06");
    // Sparse days: an old one drops by date, not by how many days are kept.
    f = recordFailure({ "2026-01-01": { "exit 1": { n: 1, last: "x" } } }, "auth", "y", new Date(2026, 10, 20, 9));
    expect(Object.keys(f)).toEqual(["2026-11-20"]);
    expect(failureClass(null, true, "token")).toBe("timed out");
    expect(failureClass(2, false, "portal token missing or expired")).toBe("auth");
    expect(failureClass(1, false, "HTTP 401 Unauthorized")).toBe("auth");
    expect(failureClass(1, false, "no tool call in pi output (timeout, model or plugin load?)")).toBe("exit 1");
    expect(failureClass(1, false, "git log --author=x: 2 items expired")).toBe("exit 1");
    expect(failureClass(null, false, "spawn ENOENT")).toBe("no exit code");
    for (const t of ["failed to authenticate", "AUTH_TOKEN is not set", "GITLAB_TOKEN missing", "Not authorized", "invalid api key", "your credentials have expired"])
      expect([t, failureClass(1, false, t)]).toEqual([t, "auth"]);
    for (const t of ["git shortlog --authors x", "authored by sam", "authority", "author_name", "exit 1, no JSON report: 14031 items", "took 4030ms", "PAY-4031 open", "PAY-401 open", "PAY-403", "v1.401.2"])
      expect([t, failureClass(1, false, t)]).toEqual([t, "exit 1"]);
    expect(failureClass(1, false, "HTTP 403")).toBe("auth");
    expect(failureClass(1, false, "HTTP 403.")).toBe("auth");
    expect(failureClass(1, false, "status 401: nope")).toBe("auth");
    expect(failureClass(1, false, "Basic auth required")).toBe("auth");
  });

  test("redact masks token-like strings in stored failure messages", async () => {
    const { recordFailure } = await import("../src/server/checks.ts");
    const { redact } = await import("../src/shared/redact.ts");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc_DEF-123";
    expect(redact(`Authorization: Bearer abc123 and ${jwt}`)).toBe("Authorization: Bearer [redacted] and [redacted]");
    expect(redact("key 0123456789abcdef0123456789abcdef01 end")).toBe("key [redacted] end");
    expect(redact("exit 1, no JSON report: boom")).toBe("exit 1, no JSON report: boom");
    const keep = "sh: /Users/someone/tools/scripts/nightly-checks/morning-sweep-runner.sh: not found; check-morning-sweep-and-approvals-longname";
    expect(redact(keep)).toBe(keep);
    const f = recordFailure({}, "auth", `token=${"a".repeat(10)} failed`, new Date(2026, 10, 20));
    expect(f["2026-11-20"]!.auth!.last).toBe("token=[redacted] failed");
    expect(redact("GITLAB_TOKEN=glpat-abcdefghij1234567890 push")).toBe("GITLAB_TOKEN=[redacted] push");
    expect(redact('{"access_token": "s3cr3t", "x": 1}')).toBe('{"access_token": "[redacted]", "x": 1}');
    expect(redact("use ghp_abcdefghijklmnop1234 now")).toBe("use [redacted] now");
    expect(redact("api_key=sk_live_abc123")).toBe("api_key=[redacted]");
    expect(redact('{"password": "correct horse battery staple"}')).toBe('{"password": "[redacted]"}');
    expect(redact("AWS_SECRET_ACCESS_KEY=wJalr/XUtnFEMI/K7MDENG x")).toBe("AWS_SECRET_ACCESS_KEY=[redacted] x");
    expect(redact("PRIVATE_KEY=abc api key: zzz")).toBe("PRIVATE_KEY=[redacted] api key: [redacted]");
    expect(redact("mytool --token abc123secret --password hunter2 done")).toBe("mytool --token [redacted] --password [redacted] done");
    expect(redact("curl -u bob:hunter2 x")).toBe("curl -u bob:[redacted] x");
    expect(redact("Authorization: Basic Ym9iOmh1bnRlcjI=")).toBe("Authorization: Basic [redacted]");
    expect(redact('password="hunter2 leaked')).toBe('password="[redacted]"');
    expect(redact('{"access_token": "abc\n"}')).not.toContain("abc");
    expect(redact('mytool --token "abc def" done')).toBe('mytool --token "[redacted]" done');
    expect(redact("x --password 'correct horse battery' y")).toBe("x --password '[redacted]' y");
    expect(redact('curl -u "bob:correct horse battery" https://x')).toBe('curl -u "[redacted]" https://x');
    expect(redact("authorization: bearer abcdef1")).toBe("authorization: bearer [redacted]");
    expect(redact("authorization: basic Ym9iOmh1bnRlcjI=")).toBe("authorization: basic [redacted]");
    for (const t of ["git push -u origin:main", "Basic setup failed", "Basic auth required", "token expired", "no JIRA Access token; run: cloudflared access login"]) expect(redact(t)).toBe(t);
  });

  test("questions about its own items: asked once, carry the dispatch note, suppress inbox triage", async () => {
    const { Checks } = await import("../src/server/checks.ts");
    const { Prompter } = await import("../src/server/prompter.ts");
    const hub = new Hub(new Store(":memory:"));
    const checks = new Checks(hub);
    const report = JSON.stringify({
      items: [{ title: "ESC-1 unassigned", kind: "decision", source: { key: "esc:ESC-1" } }],
      questions: [
        { itemKey: "esc:ESC-1", key: "ESC-1", prompt: "ESC-1?", options: [{ label: "Assign to on-call", action: "work", note: "assign it" }, { label: "Take it", status: "today" }] },
        { itemKey: "esc:nope", prompt: "orphan" },
      ],
    });
    const cmd = `cat <<'J'\n${report}\nJ`;
    await checks.run({ name: "esc", command: cmd });
    const [it] = hub.store.items();
    const qs = hub.store.questions("open");
    expect(qs.map((q) => q.prompt)).toEqual(["ESC-1?"]);
    expect(qs[0]).toMatchObject({ itemId: it!.id, key: "check:esc:ESC-1" });
    expect(qs[0]!.options[0]!.effect).toEqual({ type: "dispatch", action: "work", note: "assign it" });
    new Prompter(hub).tick(new Date(2026, 9, 6, 10, 0));
    expect(hub.store.questions("open").filter((q) => q.itemId === it!.id).length).toBe(1);
    await hub.answer(qs[0]!.id, "o1");
    await checks.run({ name: "esc", command: cmd });
    expect(hub.store.questions("open").filter((q) => q.itemId === it!.id).length).toBe(0);
  });

  test("a url option opens the deep link and keeps the question; only http(s)", async () => {
    const hub = new Hub(new Store(":memory:"));
    hub.ingestReport({
      items: [{ title: "Approve X", source: { type: "check", label: "approvals", key: "approval:opal:1" } }],
      questions: [
        {
          itemKey: "approval:opal:1",
          prompt: "Approve X?",
          options: [{ label: "Open in Opal", url: "https://iga.example/requests/1" }, { label: "Bad", url: "file:///etc/passwd" }, { label: "Done it", status: "done" }],
        },
      ],
    });
    const [q] = hub.store.questions("open");
    expect(q!.options[0]!.effect).toEqual({ type: "open", url: "https://iga.example/requests/1", keep: true });
    expect(q!.options[1]!.effect).toEqual({ type: "noop" });
    expect(q!.options[2]!.effect).toEqual({ type: "status", status: "done" });
  });
});
