import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { explainPrompt } from "../src/server/prompts.ts";
import { explainKey } from "../src/shared/detail.ts";

// "Explain simply" in the drawer: a tool-less run that writes item.explain.
const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };

function setup(run: () => Promise<{ ok: boolean; text: string; error?: string }>) {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  let calls = 0;
  (agents as any).runHeadless = async (_id: string, _prompt: string, o: { tools: boolean }) => {
    calls++;
    expect(o.tools).toBe(false);
    return run();
  };
  const item = hub.createItem({ title: "cmux token file variant", detail: "pi-plugin's tokenCommand is env-first. So 8c4d590 only passes it with 24 h left.", kind: "idea", status: "proposed", source: { type: "agent", quote: "Env-first." } });
  return { hub, agents, item, calls: () => calls };
}

test("writes a trimmed explanation keyed to the item's text", async () => {
  const { hub, agents, item } = setup(async () => ({
    ok: true,
    text: JSON.stringify({ what: " A fix so long-running agent windows keep working. ", why: "Logins expire.", done: "", terms: [{ term: "JWT", meaning: "a login token" }, { term: "", meaning: "x" }] }),
  }));
  const out = await agents.explainItem(item.id);
  expect(out.explain).toMatchObject({ what: "A fix so long-running agent windows keep working.", why: "Logins expire.", for: explainKey(item), terms: [{ term: "JWT", meaning: "a login token" }] });
  expect(out.explain!.done).toBeUndefined();
  expect(hub.store.item(item.id)!.explain!.what).toBe("A fix so long-running agent windows keep working.");
  expect(hub.store.jobs().find((j) => j.name === "explain")!.status).toBe("done");
});

test("a failed or unparseable run throws and leaves the item alone", async () => {
  const { hub, agents, item } = setup(async () => ({ ok: true, text: "not json" }));
  await expect(agents.explainItem(item.id)).rejects.toThrow("couldn't parse");
  expect(hub.store.item(item.id)!.explain).toBeUndefined();
  expect(hub.store.jobs().find((j) => j.name === "explain")!.status).toBe("failed");
});

test("two clicks share one run", async () => {
  const { agents, item, calls } = setup(async () => ({ ok: true, text: JSON.stringify({ what: "x" }) }));
  await Promise.all([agents.explainItem(item.id), agents.explainItem(item.id)]);
  expect(calls()).toBe(1);
});

test("the prompt carries the detail, quote and source, and asks for JSON only", () => {
  const hub = new Hub(new Store(":memory:"));
  const it = hub.createItem({ title: "T", detail: "the detail", kind: "task", status: "today", source: { type: "transcript", label: "BUPK weekly", quote: "the quote" } });
  const p = explainPrompt(it, { now: new Date() });
  for (const s of ["the detail", "the quote", "BUPK weekly", "ONLY JSON", "Do not invent"]) expect(p).toContain(s);
});
