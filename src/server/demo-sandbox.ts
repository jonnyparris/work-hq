// The live dashboard's "Demo" toggle. Starts `src/cli/demo.ts` as a child process: its own port,
// its own throwaway database, no config, no memory. Nothing is shared with the live process, so
// there is no code path for real data to reach the demo screen.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as cmux from "./cmux.ts";
import { config, ROOT } from "./config.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DemoSandbox {
  private child?: ChildProcess;

  get url() {
    return `http://localhost:${config.demoPort}`;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** Is something answering on the demo port, and is it really a demo? */
  private async probe(): Promise<"demo" | "other" | "none"> {
    try {
      const r = await fetch(`http://127.0.0.1:${config.demoPort}/api/snapshot`, { signal: AbortSignal.timeout(1500) });
      const s: any = await r.json();
      return s?.config?.demo ? "demo" : "other";
    } catch {
      return "none";
    }
  }

  async start(reset = false): Promise<string> {
    const found = await this.probe();
    if (found === "other") throw new Error(`port ${config.demoPort} is taken by something that isn't a Work HQ demo`);
    if (found === "demo") {
      if (reset) await fetch(`http://127.0.0.1:${config.demoPort}/api/demo/reset`, { method: "POST" }).catch(() => {});
      cmux.setQuiet(true);
      return this.url;
    }
    const logDir = resolve(homedir(), "Library/Logs");
    mkdirSync(logDir, { recursive: true });
    const log = openSync(resolve(logDir, "work-hq-demo.log"), "a");
    this.child = spawn(process.execPath, [resolve(ROOT, "src/cli/demo.ts")], {
      cwd: ROOT,
      env: { ...process.env, WORK_HQ_DEMO_PORT: String(config.demoPort), WORK_HQ_LIVE_URL: `http://localhost:${config.port}` },
      stdio: ["ignore", log, log],
    });
    this.child.on("exit", () => {
      this.child = undefined;
      cmux.setQuiet(false);
    });
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if ((await this.probe()) === "demo") {
        cmux.setQuiet(true);
        return this.url;
      }
      if (!this.running) break;
    }
    this.stop();
    throw new Error("demo didn't start — see ~/Library/Logs/work-hq-demo.log");
  }

  stop() {
    cmux.setQuiet(false);
    if (!this.running) return false;
    this.child!.kill("SIGTERM");
    this.child = undefined;
    return true;
  }
}
