/**
 * Pi extension: publish the interactive session's state to a JSON file.
 *
 * Work HQ runs action agents as interactive Pi in cmux so the owner can watch, nudge, or
 * steer them in place. Without `--print` there is no exit code to wait on,
 * so the monitor reads this file instead. It is loaded with `-e` only for
 * Work HQ sessions and does nothing unless WORK_HQ_PI_STATUS is set.
 *
 * Shape (see src/server/cmux.ts for the reader):
 *   { state: "starting" | "working" | "blocked" | "idle" | "exited",
 *     seq: number,            // bumps on every agent_start
 *     outcome?: "completed" | "error" | "aborted",
 *     detail?: string,
 *     at: string }
 *
 * Deliberately self-contained: the tiny slice of Pi's ExtensionAPI it uses is
 * declared below, so it loads (and type-checks) without Pi's packages.
 */

import { renameSync, writeFileSync } from "node:fs";

interface AgentEndEvent {
  messages: ReadonlyArray<{ role: string; stopReason?: string; errorMessage?: string }>;
}

interface ExtensionAPI {
  on(event: "agent_end", handler: (event: AgentEndEvent) => void): unknown;
  on(event: string, handler: () => void): unknown;
}

type Outcome = "completed" | "error" | "aborted";

export default function statusBeacon(pi: ExtensionAPI) {
  const path = process.env.WORK_HQ_PI_STATUS;
  if (!path) return;

  let seq = 0;
  let outcome: Outcome | undefined;
  let detail: string | undefined;

  const write = (state: string) => {
    const body = JSON.stringify({ state, seq, outcome, detail, at: new Date().toISOString() });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${body}\n`);
      renameSync(temporary, path);
    } catch {
      // Best effort: a missing beacon degrades to a timeout, never a crash.
    }
  };

  pi.on("session_start", () => write("idle"));
  pi.on("agent_start", () => {
    seq += 1;
    outcome = undefined;
    detail = undefined;
    write("working");
  });
  pi.on("agent_end", (event) => {
    const last = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (last?.stopReason === "error") {
      outcome = "error";
      detail = last.errorMessage;
    } else if (last?.stopReason === "aborted") {
      outcome = "aborted";
    } else {
      outcome = "completed";
    }
  });
  // agent_settled is the point Pi will not continue on its own (no retry,
  // compaction or queued follow-up), so only then is the turn really over.
  pi.on("agent_settled", () => write("idle"));
  pi.on("ui_prompt_start", () => write("blocked"));
  pi.on("ui_prompt_end", () => write("working"));
  pi.on("session_shutdown", () => write("exited"));
}
