#!/usr/bin/env bun
// Speaks just enough of pi's RPC protocol to test PiRpc / PiPool. The prompt text picks the behaviour.
let session = 1;
let buf = "";
let running: { abort: () => void } | undefined;
let waitingUi: ((r: any) => void) | undefined;
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const reply = (id: string, command: string, data?: unknown) => out({ id, type: "response", command, success: true, data });
const say = (text: string, stopReason = "stop", errorMessage?: string) =>
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage } });
const settle = (aborted = false) => {
  running = undefined;
  out({ type: "agent_settled", aborted });
};
if (process.argv.includes("--mode") === false) process.exit(9);

process.stdin.on("data", (c) => {
  buf += c.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const cmd = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    handle(cmd);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(cmd: any) {
  if (cmd.type === "extension_ui_response") return waitingUi?.(cmd);
  if (cmd.type === "new_session") {
    session++;
    return reply(cmd.id, "new_session", { cancelled: false });
  }
  if (cmd.type === "get_state") return reply(cmd.id, "get_state", { sessionFile: `/tmp/fake-session-${process.pid}-${session}.jsonl` });
  if (cmd.type === "abort") {
    reply(cmd.id, "abort");
    return running?.abort();
  }
  if (cmd.type !== "prompt") return out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unknown" });
  const m: string = cmd.message;
  reply(cmd.id, "prompt", { disposition: "started" });
  out({ type: "agent_start" });
  if (m === "CRASH") {
    process.stderr.write("boom\n");
    process.exit(3);
  }
  if (m === "ERROR") return say("", "error", "429 rate limit"), settle();
  if (m === "TOOL") return out({ type: "tool_execution_start", toolName: "read", args: { path: "/x" } }), say("tooled"), settle();
  if (m === "PID") return say(String(process.pid)), settle();
  if (m === "SLOW") return void (running = { abort: () => (say("", "aborted"), settle(true)) });
  if (m === "HANG") return void (running = { abort: () => {} }); // ignores abort
  if (m === "DIALOG") {
    out({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Allow bash?" });
    waitingUi = (r) => (say(`dialog:${r.cancelled === true}`), settle());
    return;
  }
  say(`echo:${m.length}:s${session}`);
  settle();
}
