#!/usr/bin/env bun
// Phase 0 bench: Apple SpeechTranscriber (whq-ear) vs HEX/Parakeet on the same audio.
//
//   bun native/whq-ear/bench.ts                 # built-in corpus: synthetic standup + 20 LibriSpeech clips
//   bun native/whq-ear/bench.ts --dir DIR       # your own: DIR/*.wav (+ optional DIR/<name>.txt reference)
//
// For each WAV: Apple (as fast as possible → speed; paced in real time → delay) and HEX (whole file,
// then in 15 s chunks like the live fallback would). WER is reported when a reference exists, otherwise
// the two engines are compared with each other ("disagreement"). Use --dir with the WAVs that
// `whq-ear live --save-audio DIR` writes to bench a real call.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const ROOT = import.meta.dir;
const EAR = join(ROOT, ".build/release/whq-ear");
const CORPUS = join(homedir(), ".cache/whq-ear-bench");
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const LOCALE = opt("--locale") ?? "en-GB";
const VOCAB = opt("--vocab");
const SKIP_REALTIME = args.includes("--no-realtime");

function sh(cmd: string[], input?: Uint8Array) {
  const p = Bun.spawnSync(cmd, { stdin: input, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

// ---------- corpus ----------

const STANDUP: [string, string][] = [
  ["Daniel", "Morning everyone. Quick update on the rollout. The canary went out to 5 percent yesterday and error rates look flat."],
  ["Samantha", "Nice. Did the latency regression on the Browser Run pool come back at all?"],
  ["Daniel", "Not since the fix. I'll chase the Quillby team about the consent banner bug today, pineapple."],
  ["Samantha", "Can someone own the follow up on ticket QRX 1234? It has been sitting there since Tuesday."],
  ["Daniel", "I can take it, but I need the staging credentials from Priya first."],
  ["Samantha", "OK. Decision then: we hold the full release until Thursday and review the dashboards on Wednesday afternoon."],
  ["Daniel", "Agreed. One more thing, the Puppeteer fork needs a version bump before the next deploy."],
];

/** PCM samples of a 16 kHz mono 16-bit WAV. Walks the RIFF chunks (AVAudioFile adds JUNK/FLLR). */
function pcmOf(buf: Buffer): Buffer {
  let o = 12;
  let fmtOk = false;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4), size = buf.readUInt32LE(o + 4);
    if (id === "fmt ") fmtOk = [1, 0xfffe].includes(buf.readUInt16LE(o + 8)) && buf.readUInt16LE(o + 10) === 1 && buf.readUInt32LE(o + 12) === 16000 && buf.readUInt16LE(o + 22) === 16;
    if (id === "data") {
      if (!fmtOk) throw new Error("want 16 kHz mono 16-bit PCM WAV (afconvert -f WAVE -d LEI16@16000 -c 1)");
      return buf.subarray(o + 8, o + 8 + size);
    }
    o += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}
function wavOf(pcm: Uint8Array): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
/** WAVs concatenated with `gapS` of silence between them. */
function concatWav(files: string[], out: string, gapS = 0.6) {
  const gap = Buffer.alloc(Math.round(16000 * gapS) * 2);
  writeFileSync(out, wavOf(Buffer.concat(files.flatMap((f) => [pcmOf(readFileSync(f)), gap]))));
}

async function buildCorpus(): Promise<string> {
  const dir = join(CORPUS, "corpus");
  mkdirSync(join(CORPUS, "parts"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "standup-say.wav"))) {
    const parts = STANDUP.map(([voice, text], i) => {
      const f = join(CORPUS, "parts", `standup-${i}.wav`);
      sh(["say", "-v", voice, "-o", f, "--data-format=LEI16@16000", text]);
      return f;
    });
    concatWav(parts, join(dir, "standup-say.wav"));
    writeFileSync(join(dir, "standup-say.txt"), STANDUP.map((x) => x[1]).join(" "));
  }
  if (!existsSync(join(dir, "librispeech-20.wav"))) {
    const refs = join(CORPUS, "parts", "ls-refs.json");
    if (!existsSync(refs)) {
      const url = "https://datasets-server.huggingface.co/rows?dataset=hf-internal-testing/librispeech_asr_dummy&config=clean&split=validation&offset=0&length=20";
      const r = await fetch(url);
      if (!r.ok) throw new Error(`LibriSpeech rows: HTTP ${r.status} (Hugging Face rate limit? retry later)`);
      const rows: any[] = (await r.json()).rows;
      for (const [i, row] of rows.entries()) {
        const flac = join(CORPUS, "parts", `ls-${i}.flac`);
        writeFileSync(flac, new Uint8Array(await (await fetch(row.row.audio[0].src)).arrayBuffer()));
        sh(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", flac, flac.replace(".flac", ".wav")]);
      }
      writeFileSync(refs, JSON.stringify(rows.map((x) => x.row.text)));
    }
    const texts: string[] = JSON.parse(readFileSync(refs, "utf8"));
    concatWav(texts.map((_, i) => join(CORPUS, "parts", `ls-${i}.wav`)), join(dir, "librispeech-20.wav"));
    writeFileSync(join(dir, "librispeech-20.txt"), texts.join(" "));
  }
  return dir;
}

// ---------- scoring ----------

const NUM: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
function words(s: string) {
  return s.toLowerCase().replace(/%/g, " percent").replace(/[’']/g, "").replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/).filter(Boolean).map((w) => NUM[w] ?? w);
}
/** Word error rate of hyp against ref (substitutions + deletions + insertions over ref words). */
function wer(ref: string, hyp: string) {
  const a = words(ref), b = words(hyp);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return a.length ? prev[b.length] / a.length : 0;
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// ---------- engines ----------

function cpuOf(pid: number) {
  const t = sh(["ps", "-o", "time=", "-p", String(pid)]).out.trim(); // [[dd-]hh:]mm:ss.ss
  return t.replace("-", ":").split(":").reduce((a, x) => a * 60 + Number(x), 0);
}

function apple(wav: string, realtime: boolean) {
  const cmd = [EAR, "file", wav, "--locale", LOCALE, ...(realtime ? ["--realtime"] : []), ...(VOCAB ? ["--vocab", VOCAB] : [])];
  const r = sh(cmd);
  const line = r.err.split("\n").find((l) => l.includes('"summary"'));
  if (!line) throw new Error(`whq-ear failed: ${r.err.slice(0, 300)}`);
  return JSON.parse(line);
}

function hexApi() {
  const d = JSON.parse(readFileSync(join(homedir(), "Library/Application Support/voice-control/local-api.json"), "utf8"));
  const s = JSON.parse(readFileSync(join(homedir(), "Library/Application Support/voice-control/settings.json"), "utf8"));
  return { ...d, model: s?.transcription?.model as string | undefined };
}
async function hexOnce(wav: Uint8Array) {
  const api = hexApi();
  const t = performance.now();
  const r = await fetch(`http://127.0.0.1:${api.port}/transcriptions${api.model ? `?model=${api.model}` : ""}`, {
    method: "POST", headers: { authorization: `Bearer ${api.token}`, "content-type": "audio/wav" }, body: wav,
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`HEX ${r.status} ${JSON.stringify(j)}`);
  return { text: String(j.transcript ?? ""), ms: performance.now() - t };
}
function wavChunks(pcm: Buffer, seconds: number) {
  const step = 16000 * 2 * seconds;
  const out: Buffer[] = [];
  for (let o = 0; o < pcm.length; o += step) out.push(wavOf(pcm.subarray(o, o + step)));
  return out;
}
async function hex(wav: string) {
  const api = hexApi();
  const pcm = pcmOf(readFileSync(wav));
  const buf = wavOf(pcm);
  await hexOnce(new Uint8Array(wavChunks(pcm, 2)[0])); // warm the model
  const c0 = cpuOf(api.pid);
  const whole = await hexOnce(new Uint8Array(buf));
  const c1 = cpuOf(api.pid);
  const chunks = wavChunks(pcm, 15);
  const times: number[] = [], texts: string[] = [];
  for (const c of chunks) { const r = await hexOnce(new Uint8Array(c)); times.push(r.ms); texts.push(r.text); }
  return { whole, wholeCpu: c1 - c0, chunked: texts.join(" "), chunkMs: times };
}

// ---------- run ----------

if (!existsSync(EAR)) { console.error(`build first: (cd ${ROOT} && swift build -c release)`); process.exit(1); }
const dir = opt("--dir") ?? (await buildCorpus());
const files = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();
const rows: string[] = [];
const results: any[] = [];
for (const f of files) {
  const wav = join(dir, f);
  const refFile = wav.replace(/\.wav$/, ".txt");
  const ref = existsSync(refFile) ? readFileSync(refFile, "utf8") : undefined;
  console.error(`· ${f}`);
  const fast = apple(wav, false);
  const rt = SKIP_REALTIME ? undefined : apple(wav, true);
  let hx: Awaited<ReturnType<typeof hex>> | undefined;
  try { hx = await hex(wav); } catch (e) { console.error(`  HEX failed: ${e}`); }
  const audio = Number(fast.audioSeconds);
  const s = rt?.streams?.[0];
  const res = {
    file: f, audioSeconds: audio,
    apple: {
      wer: ref ? wer(ref, fast.text) : undefined, speedX: audio / Number(fast.wallSeconds),
      cpuPerAudioMin: (Number(fast.cpuSeconds) / audio) * 60,
      realtime: rt && { cpuPercent: rt.cpuPercent, draftLagP50: s.draftLag.p50, finalLagP50: s.finalLag.p50, finalLagP90: s.finalLag.p90 },
      text: fast.text,
    },
    hex: hx && {
      wer: ref ? wer(ref, hx.whole.text) : undefined, werChunked15s: ref ? wer(ref, hx.chunked) : undefined,
      speedX: audio / (hx.whole.ms / 1000), cpuPerAudioMin: (hx.wholeCpu / audio) * 60,
      chunkMsP50: hx.chunkMs.slice().sort((a, b) => a - b)[Math.floor(hx.chunkMs.length / 2)],
      text: hx.whole.text,
    },
    disagreement: hx ? wer(hx.whole.text, fast.text) : undefined,
  };
  results.push(res);
  const w = (x?: number) => (x === undefined ? "—" : pct(x));
  rows.push(`| ${f} | ${audio.toFixed(0)} s | ${w(res.apple.wer)} | ${w(res.hex?.wer)} | ${w(res.hex?.werChunked15s)} | ${w(res.disagreement)} | ${res.apple.speedX.toFixed(0)}× | ${res.hex ? res.hex.speedX.toFixed(0) + "×" : "—"} | ${rt ? `${s.draftLag.p50} s / ${s.finalLag.p50} s / ${s.finalLag.p90} s` : "—"} | ${res.hex ? (res.hex.chunkMsP50 / 1000).toFixed(2) + " s" : "—"} | ${res.apple.cpuPerAudioMin.toFixed(2)} s | ${res.hex ? res.hex.cpuPerAudioMin.toFixed(2) + " s" : "—"} |`);
}
const out = join(CORPUS, `results-${new Date().toISOString().slice(0, 16).replace(/:/g, "-")}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`| Audio | Length | WER Apple | WER HEX | WER HEX 15 s chunks | Apple vs HEX | Speed Apple | Speed HEX | Apple delay: draft p50 / final p50 / final p90 | HEX per 15 s chunk | CPU s per audio min, Apple | CPU s per audio min, HEX |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const r of rows) console.log(r);
console.error(`\nfull results (with transcripts): ${out}`);
