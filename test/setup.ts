// Tests run on defaults only: never your real config, memory or database.
process.env.WORK_HQ_CONFIG = "none";
process.env.WORK_HQ_SWEEPS = "off";
delete process.env.WORK_HQ_MEMORY_TOKEN;
// Memory calls in tests go to fakes. A shell's WORK_HQ_DB (or WORK_HQ_MEMORY_WRITE=off) turns memory writes off,
// which silently no-ops the journal flush tests.
delete process.env.WORK_HQ_DB;
delete process.env.WORK_HQ_MEMORY_WRITE;
delete process.env.WORK_HQ_CLAIRIC_TOKEN;
delete process.env.WORK_HQ_CLAIRIC_ACCOUNT;
// Never shell out to the real cmux: a busy cmux app made `cmux tree` outlast the 5 s test timeout (10-21,
// cmux-error-recover failing on and off). `false` exits non-zero at once, which reads as "no workspaces".
process.env.CMUX_BIN = "/usr/bin/false";
// Never run the real `open`: answering an "open" card in a test popped example.com in Chrome on every run (10-23).
process.env.WORK_HQ_OPEN_BIN = "/usr/bin/true";
// Never kickstart a real launchd job from an Access-login test (`Agents.kickstart`).
process.env.WORK_HQ_LAUNCHCTL_BIN = "/usr/bin/true";
// Job dirs (prompts, beacons) go to a throwaway state dir, not ~/.local/state/work-hq.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.WORK_HQ_STATE = mkdtempSync(join(tmpdir(), "work-hq-test-"));
