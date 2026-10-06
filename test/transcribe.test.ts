import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/server/config.ts";
import { dictationEngine, transcribe } from "../src/server/transcribe.ts";
import { downsample, wav } from "../src/web/voice.ts";

const dir = mkdtempSync(join(tmpdir(), "whq-voice-"));
const seen: { auth?: string | null; model?: string | null; type?: string | null; bytes?: number } = {};
const hex = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    const u = new URL(req.url);
    if (req.headers.get("authorization") !== "Bearer t0k") return new Response(null, { status: 401 });
    if (u.pathname === "/health") return Response.json({ version: "test", apiVersion: "2" });
    if (u.pathname === "/transcriptions" && req.method === "POST") {
      Object.assign(seen, { auth: req.headers.get("authorization"), model: u.searchParams.get("model"), type: req.headers.get("content-type"), bytes: (await req.arrayBuffer()).byteLength });
      return Response.json({ transcript: " Put it in Friday morning. ", durationMs: 10 });
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  },
});
afterAll(() => hex.stop(true));

const audio = wav(new Float32Array(16_000), 16_000); // 1 s of silence

beforeEach(() => {
  config.voice.dictation = "auto";
  config.voice.command = undefined;
  config.voice.hex.model = "parakeet_unified_en";
  config.voice.hex.discoveryFile = join(dir, "nope.json");
});

let n = 0;
function hexRunning(up = true) {
  const f = join(dir, `local-api-${n++}.json`);
  writeFileSync(f, JSON.stringify({ port: up ? hex.port : 1, token: "t0k", apiVersion: "2", pid: process.pid }));
  config.voice.hex.discoveryFile = f;
}

describe("dictation engine", () => {
  test("wav encoder writes a 16-bit mono header", () => {
    const v = new DataView(audio.buffer);
    expect(new TextDecoder().decode(audio.slice(0, 4))).toBe("RIFF");
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(audio.byteLength).toBe(44 + 32_000);
    expect(downsample([new Float32Array(48_000)], 48_000, 16_000).length).toBe(16_000);
  });

  test("browser when forced, or when nothing local is set up", async () => {
    config.voice.dictation = "browser";
    expect(await dictationEngine()).toBe("browser");
  });

  test("auto prefers HEX and posts the WAV with its token and model", async () => {
    hexRunning();
    const { text, engine } = await transcribeFresh();
    expect(engine).toBe("hex");
    expect(text).toBe("Put it in Friday morning.");
    expect(seen).toMatchObject({ auth: "Bearer t0k", model: "parakeet_unified_en", type: "audio/wav", bytes: audio.byteLength });
  });

  test("a local command gets the WAV path and its stdout is the text", async () => {
    config.voice.dictation = "command";
    config.voice.command = `wc -c < {file} | tr -d ' '; echo '  words  '`;
    const { text, engine } = await transcribe(audio);
    expect(engine).toBe("command");
    expect(text).toBe(`${audio.byteLength} words`);
  });
});

/** The HEX health check is cached; clear it by re-importing the module fresh. */
async function transcribeFresh() {
  const mod = await import(`../src/server/transcribe.ts?fresh=${n}`);
  return mod.transcribe(audio) as Promise<{ text: string; engine: string }>;
}
