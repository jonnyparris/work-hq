// Tests run on defaults only: never your real config, memory or database.
process.env.WORK_HQ_CONFIG = "none";
process.env.WORK_HQ_SWEEPS = "off";
delete process.env.WORK_HQ_MEMORY_TOKEN;
// Job dirs (prompts, beacons) go to a throwaway state dir, not ~/.local/state/work-hq.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.WORK_HQ_STATE = mkdtempSync(join(tmpdir(), "work-hq-test-"));
