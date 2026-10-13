import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";

test("usage digest flags a note that did nothing and a repeated question", async () => {
  const path = `${tmpdir()}/whq-usage-${Date.now()}.db`;
  const hub = new Hub(new Store(path));
  const it = hub.createItem({ title: "Send the spec for review", status: "inbox" });
  for (const k of ["a", "b"]) hub.ask({ kind: "confirm", itemId: it.id, key: `k:${k}`, priority: 1, prompt: it.title, options: [] });
  hub.journal(`Note on ${it.title}: make it shorter first`, { itemId: it.id });
  hub.store.db.close();
  const p = Bun.spawn(["bun", "src/cli/usage.ts", "--db", path, "--since", new Date(Date.now() - 3600_000).toISOString()], { stdout: "pipe", env: { ...process.env, WORK_HQ_CONFIG: "none" } });
  const out = await new Response(p.stdout).text();
  rmSync(path, { force: true });
  expect(out).toContain("## Asked more than once");
  expect(out).toContain("Send the spec for review** (2×)");
  expect(out).toContain("**nothing happened**");
});
