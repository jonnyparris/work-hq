// `bin/work-hq demo` — a throwaway Work HQ full of made-up work, safe to screen-share.
// No config file, no memory, no sweeps, no real calendar. Dispatched agents and sweeps are
// scripted (src/server/demo.ts): they look real in cmux and in the dashboard, and touch nothing.
// The live dashboard's "Demo" button starts this same process on :7718.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const db = resolve(tmpdir(), "work-hq-demo.db");
for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
const workspace = resolve(tmpdir(), "work-hq-demo-workspace");
mkdirSync(workspace, { recursive: true });

Object.assign(process.env, {
  WORK_HQ_DEMO: "on",
  WORK_HQ_CONFIG: process.env.WORK_HQ_DEMO_CONFIG ?? "none",
  WORK_HQ_DB: db,
  WORK_HQ_PORT: process.env.WORK_HQ_DEMO_PORT ?? "7718",
  WORK_HQ_SWEEPS: "off",
  WORK_HQ_MEMORY_WRITE: "off",
  WORK_HQ_OWNER: process.env.WORK_HQ_DEMO_OWNER ?? "Alex",
  WORK_HQ_STATE: resolve(tmpdir(), "work-hq-demo-state"),
  WORK_HQ_WORKSPACE: workspace,
});
for (const k of ["WORK_HQ_MEMORY_TOKEN", "WORK_HQ_MEMORY_TOKEN_FILE", "WORK_HQ_MEMORY_URL", "WORK_HQ_PROMPTS", "WORK_HQ_TZ"]) delete process.env[k];

const { Store } = await import("../server/db.ts");
const { Hub } = await import("../server/hub.ts");
const { seedDemo } = await import("../server/demo.ts");

seedDemo(new Hub(new Store(db)));

console.log(`\n  demo db: ${db}`);
await import("../server/index.ts");
