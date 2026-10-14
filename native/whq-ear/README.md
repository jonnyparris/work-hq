# whq-ear (phase 0 spike)

A Swift CLI that listens to the mic (`me`) and the Mac's sound output (`them`) and turns both into
text on the laptop with Apple SpeechAnalyzer / SpeechTranscriber (macOS 26). It prints one JSONL line
per final segment. This is phase 0 of [the meeting listener proposal](../../docs/proposals/local-meeting-listener.md).
It doesn't talk to the Work HQ server yet.

```bash
cd native/whq-ear && swift build -c release
.build/release/whq-ear probe                                  # model, locale, analyzer format
.build/release/whq-ear live --locale en-GB                    # mic + system audio until Ctrl-C
.build/release/whq-ear live --src system --apps us.zoom.xos   # only Zoom's audio
.build/release/whq-ear live --save-audio /tmp/ear --out /tmp/ear/call.jsonl   # keep 16 kHz WAVs for the bench
.build/release/whq-ear file some.wav --realtime               # replay a file at real speed (delay numbers)
bun bench.ts                                                  # Apple vs HEX/Parakeet on a built-in corpus
bun bench.ts --dir /tmp/ear                                   # ... on audio you captured
```

Flags: `--src mic,system` · `--session NAME` · `--out FILE` · `--duration SECS` · `--drafts` (print
draft text too) · `--fast` (Apple's `fastResults`) · `--vocab "Quillby,QRX"` · `--aec` (see below: don't).

Line format (keys sorted):

```json
{"at":"2026-10-14T07:19:59.437Z","final":true,"lag":1.86,"session":"ear_…","src":"them","t0":5.94,"t1":9.84,"text":"The canary went out to 5% yesterday and error rates look flat."}
```

`t0`/`t1` are seconds since that source started. `lag` is how long after the end of the speech (`t1`) the
line came out. On exit a JSON summary (lag p50/p90, CPU) goes to stderr. Every 10 s a `tick:` line shows
the audio fed and the CPU.

**Permissions.** Run from a terminal, macOS asks on behalf of the terminal app (cmux): Microphone, and
*Screen & System Audio Recording → System Audio Recording Only*. Until that's allowed,
`AudioDeviceCreateIOProcIDWithBlock` blocks with no error. If `live` hangs before `listening:`, look
for the prompt.

## Results (2026-10-14, MacBook Pro, macOS 26.5.1, en-GB)

Accuracy and speed come from `bun bench.ts`: 5 runs. Apple gave the same text every time.
"Live" rows come from `whq-ear live` while `afplay` played the same audio through the built-in speakers.

| | Apple SpeechTranscriber | HEX / Parakeet (`parakeet_unified_en`) |
|---|---|---|
| WER, LibriSpeech (20 human clips, 200 s) | **3.8%** | **3.3%** (3.1% in 15 s chunks) |
| WER, synthetic standup (2 `say` voices, made-up jargon, 44 s) | 3.6% | 2.7% |
| Jargon | "Quillby" → "Quilby", "QRX" → "QR X". Real product names and ticket prefixes were misheard too. `--vocab` (AnalysisContext) made no difference | "Quillby" right, "QRX" glued to "Ticket". Missed the same real product names |
| "pineapple" | Heard every time (sometimes as its own segment: "Pineapple.") | Heard every time |
| Speed | 55–68× real time | Varies a lot: 73–103× in 3 of 10 runs, **4–5× in the other 7** |
| CPU | **0.12 CPU-s per audio minute** in file mode (it runs on the Neural Engine). Live, two streams: **~5% of one core** (mostly 48 kHz → 16 kHz conversion and IO) | 0.5 CPU-s per audio minute when fast, **23–28 CPU-s per audio minute (~40% of a core)** when slow |
| Delay to final text | Replayed at real speed: p50 **1.0–2.1 s**, p90 **3.5–3.8 s**. Live system tap: p50 1.9 s, p90 2.9 s. Live mic + system: p50 2.4–2.8 s, p90 ~3.9 s | Batch only. 0.13 s per 15 s chunk when fast, ~3 s when slow, **plus** the wait for the chunk to fill (VAD pause or 15 s) |
| Drafts | Draft text keeps up with the audio (covers up to the last 100 ms buffer), then is replaced by the final | None |
| Setup | Built in. Model already on disk for 9 English locales | Needs HEX running |

**Battery.** Not measured: the laptop was on AC at 100%. `top` POWER for `whq-ear` matched its CPU (~5).
CPU is the proxy until a real run unplugged.

### What the live tests found

- **System audio tap works** (Core Audio process tap + private aggregate device, 48 kHz float stereo).
  No virtual driver.
- **The mic hears the speakers.** On built-in speakers, every `them` line also turned up on `me` a few
  words worse ("Leighton's work is really Greek" → "Lake work is pretty Greek"). Without a fix, a colleague
  saying "pineapple" on speaker would trigger 🍍 as if you said it. With headphones, no problem.
- **Voice processing (`--aec`) is not the fix.** Turning on `setVoiceProcessingEnabled` cancels the echo,
  but it also stops the system tap after 0.6 s, and it costs ~13% CPU. Phase 1 should instead drop a `me`
  segment when a `them` segment within ±2 s has mostly the same words. That works because we have both texts.
- Segments are short (one sentence, 1–12 s). For 🍍, match the keyword across segment boundaries, not
  inside one.

### Not done yet (needs the owner)

The real Zoom call, Meet call and in-person 1-1 from the plan. They need real people, their consent,
and an answer to the policy question in the proposal. To run them:

```bash
.build/release/whq-ear live --locale en-GB --save-audio ~/ear-bench/zoom --out ~/ear-bench/zoom/apple.jsonl
# … call … Ctrl-C
bun bench.ts --dir ~/ear-bench/zoom      # Apple vs HEX on the same audio (no reference, so "disagreement")
rm -rf ~/ear-bench                       # don't keep other people's voices
```

For the in-person 1-1 use `--src mic`. Unplug for the battery number (`pmset -g batt` before and after).
