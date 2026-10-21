// Tests run on defaults only: never your real config, memory or database.
process.env.WORK_HQ_CONFIG = "none";
process.env.WORK_HQ_SWEEPS = "off";
delete process.env.WORK_HQ_MEMORY_TOKEN;
delete process.env.WORK_HQ_CLAIRIC_TOKEN;
delete process.env.WORK_HQ_CLAIRIC_ACCOUNT;
// Never shell out to the real cmux: a busy cmux app made `cmux tree` outlast the 5 s test timeout (10-21,
// cmux-error-recover failing on and off). `false` exits non-zero at once, which reads as "no workspaces".
process.env.CMUX_BIN = "/usr/bin/false";
// Job dirs (prompts, beacons) go to a throwaway state dir, not ~/.local/state/work-hq.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.WORK_HQ_STATE = mkdtempSync(join(tmpdir(), "work-hq-test-"));
