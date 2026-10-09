// Demo mode only: plays a scripted agent run in a cmux terminal so it looks (and reports back)
// like a real pi session, without touching any real tool, account or file.
//   bun src/cli/demo-agent.ts <script.json>
// Env (set by cmux.launchInCmux): WORK_HQ_PI_STATUS, WORK_HQ_JOB, WORK_HQ_URL.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { DemoScript } from "../server/demo.ts";

const script = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as DemoScript & { title: string };
const beacon = process.env.WORK_HQ_PI_STATUS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", mag: "\x1b[35m", yellow: "\x1b[33m", reset: "\x1b[0m" };

function beat(state: string, seq: number, outcome?: string) {
  if (!beacon) return;
  const tmp = `${beacon}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ state, seq, outcome, at: new Date().toISOString() })}\n`);
  renameSync(tmp, beacon);
}

async function type(text: string, cps = 140) {
  for (const ch of text) {
    process.stdout.write(ch);
    await sleep(1000 / cps);
  }
  process.stdout.write("\n");
}

beat("idle", 0);
process.stdout.write(`\n${c.mag}${c.bold}  π  pi${c.reset}${c.dim}  · work-hq · demo session (scripted — no real tools)${c.reset}\n\n`);
process.stdout.write(`${c.dim}  ${script.title}${c.reset}\n\n`);
await sleep(600);
beat("working", 1);

for (const s of script.steps) {
  await sleep(s.ms);
  if (s.t === "tool") process.stdout.write(`${c.cyan}  ● ${c.reset}${c.bold}${s.text}${c.reset}\n`);
  else if (s.t === "out") process.stdout.write(`${c.dim}    ${s.text}${c.reset}\n`);
  else {
    process.stdout.write("\n");
    for (const line of s.text.split("\n")) await type(`  ${line}`);
    process.stdout.write("\n");
  }
}

await sleep(500);
process.stdout.write(`${c.cyan}  ● ${c.reset}${c.bold}$ whq report ${process.env.WORK_HQ_JOB ?? ""}${c.reset}\n`);
try {
  const r = await fetch(`${process.env.WORK_HQ_URL}/api/agent/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...script.report, jobId: process.env.WORK_HQ_JOB }),
  });
  process.stdout.write(`${c.dim}    ${r.ok ? "reported to Work HQ ✓" : `report failed: HTTP ${r.status}`}${c.reset}\n`);
} catch (e) {
  process.stdout.write(`${c.yellow}    report failed: ${(e as Error).message}${c.reset}\n`);
}
process.stdout.write(`\n${c.green}  ✓ ${script.report.summary ?? "Finished"}${c.reset}\n\n`);
beat("idle", 1, "completed");
