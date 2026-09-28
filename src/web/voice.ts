// Browser speech, via Chrome's Web Speech API (works on localhost, no keys).
//
// Two modes share one recogniser (Chrome only allows one at a time):
//   listen   — always-on 🍍 watcher. Keeps a rolling transcript; when the owner says
//              "pineapple", waits a beat for the rest of the sentence, then hands
//              the preceding couple of minutes to triage.
//   dictate  — push-to-talk into the command bar.
//
// Caveat worth knowing: the laptop mic hears everyone in the room/call, so the
// "only when the owner says it" rule is enforced by triage reading context, not here.

import { profile } from "./ui.tsx";

type Rec = any;

const SR: any = (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;
export const speechSupported = Boolean(SR);

const KEYWORD = /\bpine\s?apple\b/i;
const WINDOW_MS = 150_000; // how much conversation to hand over
const AFTER_MS = 7_000; // keep listening this long after the keyword

interface Line { at: number; text: string }

export interface VoiceHandlers {
  onInterim?: (text: string) => void;
  onPineapple?: (transcript: string) => void;
  onDictation?: (text: string, final: boolean) => void;
  onState?: (s: { listening: boolean; dictating: boolean; error?: string }) => void;
}

export class Voice {
  private rec: Rec | undefined;
  private mode: "off" | "listen" | "dictate" = "off";
  private wantListen = false;
  private lines: Line[] = [];
  private pendingFire: ReturnType<typeof setTimeout> | undefined;
  private dictated = "";

  constructor(private h: VoiceHandlers) {}

  get listening() { return this.wantListen; }

  startListening() {
    this.wantListen = true;
    if (this.mode === "off") this.start("listen");
  }

  stopListening() {
    this.wantListen = false;
    if (this.mode === "listen") this.stop();
  }

  startDictation() {
    this.dictated = "";
    this.stop();
    setTimeout(() => this.start("dictate"), 120);
  }

  stopDictation() {
    if (this.mode === "dictate") this.stop();
  }

  private state(error?: string) {
    this.h.onState?.({ listening: this.mode === "listen", dictating: this.mode === "dictate", error });
  }

  private start(mode: "listen" | "dictate") {
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
      if (interim) {
        if (this.mode === "dictate") this.h.onDictation?.(`${this.dictated} ${interim}`.trim(), false);
        else this.h.onInterim?.(interim);
      }
    };
    rec.onerror = (e: any) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      this.state(e.error === "not-allowed" ? "Microphone blocked" : e.error);
      if (e.error === "not-allowed") this.wantListen = false;
    };
    rec.onend = () => {
      const was = this.mode;
      this.rec = undefined;
      this.mode = "off";
      if (was === "dictate") this.h.onDictation?.(this.dictated.trim(), true);
      // Chrome ends sessions on silence; the watcher just comes back.
      if (this.wantListen) setTimeout(() => this.mode === "off" && this.start("listen"), was === "dictate" ? 300 : 250);
      this.state();
    };
    try {
      rec.start();
      this.rec = rec;
      this.mode = mode;
      this.state();
    } catch (err) {
      this.state(String(err));
    }
  }

  private stop() {
    try { this.rec?.stop(); } catch {}
  }

  private final(text: string) {
    if (!text) return;
    if (this.mode === "dictate") {
      this.dictated = `${this.dictated} ${text}`.trim();
      this.h.onDictation?.(this.dictated, false);
      return;
    }
    const now = Date.now();
    this.lines.push({ at: now, text });
    this.lines = this.lines.filter((l) => now - l.at < WINDOW_MS + AFTER_MS);
    this.h.onInterim?.(text);
    if (KEYWORD.test(text) && !this.pendingFire) {
      this.pendingFire = setTimeout(() => {
        this.pendingFire = undefined;
        const transcript = this.lines.map((l) => l.text).join("\n");
        this.lines = [];
        this.h.onPineapple?.(transcript);
      }, AFTER_MS);
    }
  }

  /** Manual trigger (button / hotkey) — same as saying the word. */
  fireNow() {
    const transcript = this.lines.map((l) => l.text).join("\n");
    this.lines = [];
    this.h.onPineapple?.(transcript);
  }
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
