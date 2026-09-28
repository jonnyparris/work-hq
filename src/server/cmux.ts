// cmux surface: one sidebar workspace per dispatched job, in a "Work HQ" group,
// running interactive pi. Completion comes from the status beacon extension
// (pi/status-beacon.ts), never from scraping the terminal.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, ROOT } from "./config.ts";

export const BEACON_EXTENSION = resolve(ROOT, "pi/status-beacon.ts");

export interface Beacon {
  state: "idle" | "working" | "blocked" | "exited" | "starting";
  seq: number;
  outcome?: "completed" | "error" | "aborted";
  detail?: string;
  code?: number;
  at?: string;
}

export function readBeacon(path: string): Beacon | undefined {
  try {
    const b = JSON.parse(readFileSync(path, "utf8"));
    return typeof b?.state === "string" ? (b as Beacon) : undefined;
  } catch {
    return undefined;
  }
}

export const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

function cli(args: string[]) {
  if (!config.cmux.bin) return { code: -1, stdout: "", stderr: "cmux not installed" };
  const r = spawnSync(config.cmux.bin, args, { encoding: "utf8", timeout: 20_000, env: { ...process.env, CMUX_QUIET: "1" } });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
}

export function cmuxAvailable() {
  return cli(["ping"]).code === 0;
}

/** Corporate root CA for child processes, if configured. */
export function tlsEnv(): Record<string, string> {
  const ca = config.caFile;
  if (!ca) return {};
  return {
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? ca,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? ca,
    REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE ?? ca,
  };
}

export interface Launched {
  workspace: string;
  statusPath: string;
}

export function jobDir(jobId: string) {
  const dir = resolve(config.stateDir, "jobs", jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Start interactive pi in a new cmux workspace. */
export function launchInCmux(opts: {
  jobId: string;
  title: string;
  prompt: string;
  cwd: string;
  piArgs: string[];
  env?: Record<string, string>;
}): Launched | undefined {
  const dir = jobDir(opts.jobId);
  const promptPath = resolve(dir, "prompt.md");
  const statusPath = resolve(dir, "status.json");
  const launchPath = resolve(dir, "launch.sh");
  writeFileSync(promptPath, opts.prompt);
  const env = { ...tlsEnv(), ...(opts.env ?? {}), WORK_HQ_PI_STATUS: statusPath, WORK_HQ_JOB: opts.jobId, WORK_HQ_URL: `http://127.0.0.1:${config.port}` };
  const pi = [config.pi.bin, ...opts.piArgs, "-e", BEACON_EXTENSION, `Read ${promptPath} and follow the instructions in it exactly.`]
    .map(shq)
    .join(" ");
  writeFileSync(
    launchPath,
    [
      "#!/bin/zsh",
      `# Work HQ job ${opts.jobId} — ${opts.title}`,
      `cd ${shq(opts.cwd)} || exit 1`,
      `export PATH=${shq(`${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`)}`,
      ...Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`),
      `printf '\\033]0;%s\\007' ${shq(`🛰 ${opts.title}`)}`,
      pi,
      `code=$?; printf '{"state":"exited","seq":-1,"code":%s}\\n' "$code" > ${shq(statusPath)}`,
      "exec /bin/zsh -l",
      "",
    ].join("\n"),
  );

  const group = ensureGroup();
  const created = cli([
    "workspace", "create",
    "--name", opts.title.slice(0, 60),
    "--description", `work-hq · ${opts.jobId}`,
    "--cwd", opts.cwd,
    "--command", `/bin/zsh -l ${shq(launchPath)}`,
    "--focus", "false",
    ...(group ? ["--group", group] : []),
  ]);
  const ref = /workspace:\d+/.exec(created.stdout)?.[0];
  if (created.code !== 0 || !ref) return undefined;
  return { workspace: idForRef(ref) ?? ref, statusPath };
}

function ensureGroup(): string | undefined {
  const r = cli(["--json", "workspace-group", "create", "--name", config.cmux.group, "--idempotency-key", "work-hq"]);
  if (r.code !== 0) return undefined;
  try {
    return JSON.parse(r.stdout)?.group?.ref;
  } catch {
    return undefined;
  }
}

function tree(): Array<{ id: string; ref: string }> | undefined {
  const r = cli(["--json", "--id-format", "both", "tree", "--all"]);
  if (r.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(r.stdout);
    return (parsed.windows ?? []).flatMap((w: any) =>
      (w.workspaces ?? []).filter((ws: any) => ws.id && ws.ref).map((ws: any) => ({ id: ws.id, ref: ws.ref })),
    );
  } catch {
    return undefined;
  }
}

function idForRef(ref: string) {
  return tree()?.find((w) => w.ref === ref)?.id;
}

export function liveWorkspaces(): Set<string> | undefined {
  const t = tree();
  return t ? new Set(t.flatMap((w) => [w.id, w.ref])) : undefined;
}

export function focusWorkspace(id: string) {
  const r = cli(["workspace", "select", id]);
  spawnSync("open", ["-a", "cmux"]);
  return r.code === 0;
}

export function closeWorkspace(id: string) {
  return cli(["workspace", "close", id]).code === 0;
}

export function notify(workspace: string | undefined, title: string, body: string) {
  cli(["notify", ...(workspace ? ["--workspace", workspace] : []), "--title", title, "--body", body]);
}
