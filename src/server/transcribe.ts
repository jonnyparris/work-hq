// Dictation engines. The browser always does the recording when the engine isn't "browser":
// it posts a mono 16-bit WAV to /api/transcribe and this turns it into text.
//
//   browser — Chrome's Web Speech API. Live interim text, no install. The fallback.
//   hex     — HEX (hex.kitlangton.dev) local API: on-device Parakeet/Whisper. Found via the
//             discovery file HEX writes; no config needed.
//   command — any local transcriber: a shell command that reads {file} (a WAV) and prints the text.
//             e.g. "whisper-cli -m ~/models/ggml-base.en.bin -nt -np -f {file}"
//   auto    — hex if it's running, else command if set, else browser.
//
// The 🍍 listener stays on Web Speech either way: it needs a continuous stream and keyword spotting.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.ts";

export type Engine = "browser" | "hex" | "command";

const HEX_DIR = join(homedir(), "Library/Application Support/voice-control");

interface HexApi { port: number; token: string; model?: string }

function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** HEX's discovery file + its selected model. Undefined when it isn't installed or running. */
function hexApi(): HexApi | undefined {
  const d = readJson(config.voice.hex.discoveryFile ?? join(HEX_DIR, "local-api.json"));
  if (!d?.port || !d?.token) return undefined;
  if (d.pid) { try { process.kill(d.pid, 0); } catch { return undefined; } } // stale file from a quit HEX
  const model = config.voice.hex.model || readJson(join(HEX_DIR, "settings.json"))?.transcription?.model;
  return { port: d.port, token: d.token, model };
}

let hexSeen: { at: number; ok: boolean } | undefined;
async function hexUp(): Promise<boolean> {
  if (hexSeen && Date.now() - hexSeen.at < 30_000) return hexSeen.ok;
  const api = hexApi();
  let ok = false;
  if (api) {
    try {
      const r = await fetch(`http://127.0.0.1:${api.port}/health`, { headers: { authorization: `Bearer ${api.token}` }, signal: AbortSignal.timeout(1500) });
      ok = r.ok;
    } catch {}
  }
  hexSeen = { at: Date.now(), ok };
  return ok;
}

/** What dictation will actually use right now. */
export async function dictationEngine(): Promise<Engine> {
  const want = config.voice.dictation;
  if (want === "browser") return "browser";
  if (want === "command") return config.voice.command ? "command" : "browser";
  if (want === "hex") return (await hexUp()) ? "hex" : "browser";
  if (await hexUp()) return "hex";
  return config.voice.command ? "command" : "browser";
}

export async function transcribe(wav: Uint8Array): Promise<{ text: string; engine: Engine }> {
  if (wav.byteLength < 1000) return { text: "", engine: "browser" };
  const engine = await dictationEngine();
  if (engine === "hex") return { text: await viaHex(wav), engine };
  if (engine === "command") return { text: await viaCommand(wav), engine };
  throw new Error("no local transcriber — dictation is on Web Speech");
}

async function viaHex(wav: Uint8Array) {
  const api = hexApi();
  if (!api) throw new Error("HEX isn't running");
  const url = `http://127.0.0.1:${api.port}/transcriptions${api.model ? `?model=${encodeURIComponent(api.model)}` : ""}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${api.token}`, "content-type": "audio/wav" },
    body: wav as unknown as BodyInit,
    signal: AbortSignal.timeout(60_000),
  });
  const out: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    hexSeen = undefined;
    throw new Error(`HEX: ${out.code ?? r.status}`);
  }
  return String(out.transcript ?? "").trim();
}

async function viaCommand(wav: Uint8Array) {
  const file = join(tmpdir(), `work-hq-dictation-${process.pid}-${Date.now()}.wav`);
  writeFileSync(file, wav);
  try {
    const cmd = config.voice.command!.includes("{file}") ? config.voice.command!.replaceAll("{file}", `'${file}'`) : `${config.voice.command} '${file}'`;
    const p = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 60_000);
    const [text, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(`transcribe command failed (${code}): ${err.trim().slice(0, 200)}`);
    return text.replace(/\s+/g, " ").trim();
  } finally {
    if (existsSync(file)) rmSync(file);
  }
}
