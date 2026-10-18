import { expect, test } from "bun:test";
import { Agents, type CmuxDeps } from "../src/server/agents.ts";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";

// 10-16 20:55Z: a "when" job's summary and green toast said "Booked a 30-min 1-1 with Kevin for Mon 09:30".
// The calendar write failed 16s later (read-only scope). Even on success it only makes a private block.
// Don't say booked before the write; calendarBlock reports the real outcome.

const noCmux: CmuxDeps = { available: () => false, launch: () => ({ workspace: "", statusPath: "/dev/null" }) };
const AT = "2026-10-19T08:30:00.000Z";

function setup(model: object) {
  const hub = new Hub(new Store(":memory:"));
  const agents = new Agents(hub, noCmux);
  const a = agents as any;
  const toasts: string[] = [];
  const blocks: unknown[][] = [];
  a.runHeadless = async () => ({ ok: true, text: JSON.stringify(model) });
  a.calendarBlock = async (...args: unknown[]) => void blocks.push(args);
  const toast = hub.toast.bind(hub);
  hub.toast = (text, tone) => (toasts.push(text), toast(text, tone));
  const item = hub.createItem({ title: "1-1 with Kevin", kind: "task", status: "inbox" });
  return { hub, agents, toasts, blocks, item };
}

const whenJob = (hub: Hub) => hub.store.jobs().find((j) => j.name === "when")!;

test("calendar create: summary and toast ignore the model's 'Booked' reply", async () => {
  const { hub, agents, toasts, blocks, item } = setup({ at: AT, label: "Mon 09:30", calendar: "create", durationMin: 30, reply: "Booked a 30-min 1-1 with Kevin for Mon 09:30." });
  await agents.scheduleFromWords(item.id, "book a 1-1 with Kevin Monday morning");
  const job = whenJob(hub);
  expect(job.status).toBe("done");
  expect(job.summary).toBe("Scheduled Mon 09:30 — adding a private block to your calendar");
  expect(job.summary).not.toMatch(/book/i);
  expect(toasts).toEqual(["Scheduled Mon 09:30 — adding a private block to your calendar"]);
  expect(blocks).toEqual([[item.id, AT, 30]]);
});

test("no calendar: the model's reply is still used", async () => {
  const { hub, agents, toasts, blocks, item } = setup({ at: AT, label: "Mon 09:30", calendar: "none", reply: "I'll remind you Monday at 09:30." });
  await agents.scheduleFromWords(item.id, "monday morning");
  expect(whenJob(hub).summary).toBe("I'll remind you Monday at 09:30.");
  expect(toasts).toEqual(["I'll remind you Monday at 09:30."]);
  expect(blocks).toHaveLength(0);
});
