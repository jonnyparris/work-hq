import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { REJECTED_CAP, rejectedTranscriptTitles } from "../src/server/prompts.ts";
import type { Item } from "../src/shared/types.ts";

// it_mw8gt7havkaom: 19 of 24 answered transcript cards by 11-10 were dismissals ("Not mine", "already done").
// The sweep now gets the owner's recent drops as "Rejected, don't re-extract".
const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const item = (id: string, title: string, extra: Partial<Item> = {}): Item => ({
  id, kind: "task", status: "inbox", title, source: { type: "transcript", key: `transcript:doc:${id}` },
  createdAt: ago(1), updatedAt: ago(1), ...extra,
} as Item);

const section = (prompt: string, head: string) => {
  const from = prompt.indexOf(head);
  expect(from).toBeGreaterThan(-1);
  return prompt.slice(from, prompt.indexOf("\n\n", from + head.length + 1));
};

test("a dropped transcript item appears under Rejected in the sweep prompt, not under Known", async () => {
  const store = new Store(":memory:");
  const dropped = ago(2);
  store.putItem(item("it_nm", "Approve Niklas's IAM ticket for FedRAMP", { status: "dropped", confirmedAt: dropped, updatedAt: dropped }));
  store.putItem(item("it_open", "Present Agent Relay at the Friday demo"));
  // Merged duplicate: dropped by dedupe, never confirmed by the owner. Not a rejection.
  store.putItem(item("it_dup", "Merged twin of something", { status: "dropped" }));
  // Dropped long ago: out of the window.
  store.putItem(item("it_old", "Ancient drop", { status: "dropped", confirmedAt: ago(45), updatedAt: ago(45) }));
  // Dropped long ago, updatedAt bumped today, confirmedAt unchanged (a re-import): still out of the window.
  store.putItem(item("it_touched", "Old drop touched today", { status: "dropped", confirmedAt: ago(45), updatedAt: ago(0) }));
  // Dropped, but not from a transcript.
  store.putItem(item("it_mem", "Memory proposal dropped", { status: "dropped", confirmedAt: dropped, updatedAt: dropped, source: { type: "memory" } }));

  const hub = new Hub(store);
  const agents = new Agents(hub, noCmux);
  const prompts: string[] = [];
  (agents as any).runHeadless = async (_id: string, prompt: string) => {
    prompts.push(prompt);
    return { ok: true, text: JSON.stringify({ summary: "0 meetings", items: [], cursor: new Date().toISOString(), meetings: [] }) };
  };
  await agents.sweep("transcripts");

  const rejected = section(prompts[0], "Rejected, don't re-extract");
  expect(rejected).toContain("- Approve Niklas's IAM ticket for FedRAMP");
  for (const t of ["Present Agent Relay", "Merged twin", "Ancient drop", "Old drop touched today", "Memory proposal dropped"]) expect(rejected).not.toContain(t);

  const known = section(prompts[0], "Known items (don't duplicate):");
  expect(known).toContain("- Present Agent Relay at the Friday demo");
  expect(known).not.toContain("Approve Niklas's IAM ticket");
});

test("no drops: the Rejected section says (none)", async () => {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  const prompts: string[] = [];
  (agents as any).runHeadless = async (_id: string, prompt: string) => {
    prompts.push(prompt);
    return { ok: true, text: JSON.stringify({ summary: "0 meetings", items: [], cursor: new Date().toISOString(), meetings: [] }) };
  };
  await agents.sweep("transcripts");
  expect(section(prompts[0], "Rejected, don't re-extract")).toContain("- (none)");
});

test("ordered by confirmedAt, not last write", () => {
  const a = item("it_a", "dropped first, edited last", { status: "dropped", confirmedAt: ago(5), updatedAt: ago(0) });
  const b = item("it_b", "dropped last", { status: "dropped", confirmedAt: ago(1), updatedAt: ago(1) });
  expect(rejectedTranscriptTitles([a, b])).toEqual(["dropped last", "dropped first, edited last"]);
});

test("newest first, capped", () => {
  const items = Array.from({ length: REJECTED_CAP + 5 }, (_, n) => {
    const at = new Date(Date.now() - n * 3_600_000).toISOString();
    return item(`it_${n}`, `drop ${n}`, { status: "dropped", confirmedAt: at, updatedAt: at });
  }).reverse();
  const titles = rejectedTranscriptTitles(items);
  expect(titles).toHaveLength(REJECTED_CAP);
  expect(titles[0]).toBe("drop 0");
  expect(titles.at(-1)).toBe(`drop ${REJECTED_CAP - 1}`);
});
