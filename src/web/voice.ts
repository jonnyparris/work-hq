// Browser speech, via Chrome's Web Speech API (works on localhost, no keys).
//
// Push-to-talk dictation into the command bar / "Scheduled for…". Uses the server's dictation
// engine (HEX, a local command) when there is one: records a WAV here, stops on silence, posts it
// to /api/transcribe. Otherwise Web Speech.

import { profile } from "./ui.tsx";

type Rec = any;

const SR: any = (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;
/** Web Speech: live dictation. */
export const speechSupported = Boolean(SR);
/** Recorded dictation (HEX / local command) only needs a mic. */
export const micSupported = Boolean(globalThis.navigator?.mediaDevices?.getUserMedia);

export interface VoiceHandlers {
  onDictation?: (text: string, final: boolean) => void;
  onState?: (s: { dictating: boolean; transcribing?: boolean; error?: string }) => void;
}

export class Voice {
  private rec: Rec | undefined;
  private mode: "off" | "dictate" = "off";
  private dictated = "";

  constructor(private h: VoiceHandlers) {}

  private recorder: WavRecorder | undefined;
  /** Bumped on every start/stop so a slow async start can tell it's been cancelled. */
  private gen = 0;
  private transcribing = false;

  /** Picks the engine each time: HEX can be launched or quit while the page is open. */
  startDictation() {
    const gen = ++this.gen;
    this.dictated = "";
    this.cancelRecorder();
    this.stop();
    void engine().then((e) => {
      if (gen !== this.gen) return;
      if (e.engine === "browser") return void setTimeout(() => gen === this.gen && this.start(), 120);
      void this.startRecorder(gen, e.silenceMs);
    });
  }

  /** Cancel: release the mic, drop whatever was said. */
  stopDictation() {
    this.gen++;
    if (this.recorder) { this.cancelRecorder(); this.afterRecorder(); return; }
    if (this.mode === "dictate") { try { this.rec?.abort(); } catch { this.stop(); } }
  }

  /** Done talking: release the mic and deliver the text now (⌘↵, the mic button). */
  finishDictation() {
    if (this.recorder) return void this.finishRecorder(this.gen);
    if (this.mode === "dictate") this.stop(); // Web Speech flushes its final result on stop
  }

  private async startRecorder(gen: number, silenceMs: number) {
    const r = new WavRecorder();
    this.recorder = r;
    this.rec = undefined; // a Web Speech recogniser stopped in startDictation; its late onend is ignored
    this.mode = "dictate";
    this.state();
    try {
      await r.start(silenceMs, () => void this.finishRecorder(gen));
    } catch (err) {
      r.cancel();
      if (this.recorder === r) this.recorder = undefined;
      this.state((err as Error).name === "NotAllowedError" ? "Microphone blocked" : String((err as Error).message ?? err));
      this.afterRecorder();
      return;
    }
    if (gen !== this.gen) { r.cancel(); if (this.recorder === r) this.recorder = undefined; }
  }

  private async finishRecorder(gen: number) {
    const r = this.recorder;
    if (!r || gen !== this.gen) return;
    this.recorder = undefined;
    const wav = r.stop(); // mic released here, before the network round trip
    this.transcribing = true;
    this.state();
    let text = "";
    let error: string | undefined;
    try {
      if (wav) {
        const res = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav as BodyInit });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error ?? res.statusText);
        text = out.text ?? "";
      }
    } catch (e) {
      error = `Dictation: ${(e as Error).message}`;
    }
    this.transcribing = false;
    if (gen !== this.gen) return this.state();
    this.dictated = text;
    this.afterRecorder(error);
    this.h.onDictation?.(text, true);
  }

  private cancelRecorder() {
    this.recorder?.cancel();
    this.recorder = undefined;
    this.transcribing = false;
  }

  private afterRecorder(error?: string) {
    this.mode = "off";
    this.state(error);
  }

  private state(error?: string) {
    this.h.onState?.({ dictating: this.mode === "dictate", transcribing: this.transcribing, error });
  }

  private start() {
    if (!SR) return this.state("Speech recognition needs Chrome");
    const rec: Rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = profile.speechLang || "en-GB";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text: string = r[0].transcript;
        if (r.isFinal) this.final(text.trim());
        else interim += text;
      }
      if (interim && this.mode === "dictate") this.h.onDictation?.(`${this.dictated} ${interim}`.trim(), false);
    };
    rec.onerror = (e: any) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      this.state(e.error === "not-allowed" ? "Microphone blocked" : e.error);
    };
    rec.onend = () => {
      // A late end from a recogniser we already replaced (e.g. by a recorded dictation) changes nothing.
      if (this.rec !== rec) return;
      const was = this.mode;
      this.rec = undefined;
      this.mode = "off";
      if (was === "dictate") this.h.onDictation?.(this.dictated.trim(), true);
      this.state();
    };
    try {
      rec.start();
      this.rec = rec;
      this.mode = "dictate";
      this.state();
    } catch (err) {
      this.state(String(err));
    }
  }

  private stop() {
    try { this.rec?.stop(); } catch {}
  }

  private final(text: string) {
    if (!text || this.mode !== "dictate") return;
    this.dictated = `${this.dictated} ${text}`.trim();
    this.h.onDictation?.(this.dictated, false);
  }
}

let engineSeen: { at: number; v: { engine: string; silenceMs: number } } | undefined;
async function engine(): Promise<{ engine: string; silenceMs: number }> {
  if (engineSeen && Date.now() - engineSeen.at < 10_000) return engineSeen.v;
  try {
    const v = await (await fetch("/api/voice")).json();
    engineSeen = { at: Date.now(), v };
    return v;
  } catch {
    return { engine: "browser", silenceMs: 1400 };
  }
}

/** Mic → 16 kHz mono 16-bit WAV. Calls onSilence once speech has stopped for silenceMs. */
class WavRecorder {
  private stream: MediaStream | undefined;
  private ctx: AudioContext | undefined;
  private chunks: Float32Array[] = [];
  private rate = 48_000;
  private dead = false;

  async start(silenceMs: number, onSilence: () => void) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    if (this.dead) return void stream.getTracks().forEach((t) => t.stop()); // cancelled while the prompt was up
    this.stream = stream;
    const ctx = (this.ctx = new AudioContext());
    this.rate = ctx.sampleRate;
    const src = `registerProcessor("whq-tap", class extends AudioWorkletProcessor {
      process(i) { const c = i[0] && i[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
    });`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    if (this.dead) return;
    const tap = new AudioWorkletNode(ctx, "whq-tap");
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(tap).connect(mute).connect(ctx.destination);
    const began = Date.now();
    let spoke = 0;
    let fired = false;
    const fire = () => { if (!fired) { fired = true; onSilence(); } };
    tap.port.onmessage = (e) => {
      const c = e.data as Float32Array;
      this.chunks.push(c);
      let sum = 0;
      for (let i = 0; i < c.length; i++) sum += c[i]! * c[i]!;
      const now = Date.now();
      if (Math.sqrt(sum / c.length) > 0.02) spoke = now;
      // Silence after speech, nothing said at all, or a runaway recording.
      if (spoke ? now - spoke > silenceMs : now - began > 8_000) fire();
      if (now - began > 60_000) fire();
    };
  }

  /** Release the mic; the recording as WAV (undefined if nothing was captured). */
  stop(): Uint8Array | undefined {
    const pcm = this.release();
    return pcm.length > 1600 ? wav(pcm, 16_000) : undefined;
  }

  cancel() { this.release(); }

  private release() {
    this.dead = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    void this.ctx?.close().catch(() => {});
    this.ctx = undefined;
    const pcm = downsample(this.chunks, this.rate, 16_000);
    this.chunks = [];
    return pcm;
  }
}

export function downsample(chunks: Float32Array[], from: number, to: number) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  if (from === to) return all;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j]!;
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

export function wav(pcm: Float32Array, rate: number) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff, true);
  return new Uint8Array(buf);
}

/** Soft two-note chime for things that need attention. */
export function chime() {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    for (const [i, f] of [659.25, 987.77].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.12);
      g.gain.linearRampToValueAtTime(0.08, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.7);
    }
    setTimeout(() => ctx.close(), 1200);
  } catch {}
}
