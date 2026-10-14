# Proposal: a local meeting listener that feeds Work HQ

Status: draft for discussion · Owner: Work HQ · Related: [ARCHITECTURE.md → Voice](../ARCHITECTURE.md#voice)

## TL;DR

- Build a small **native macOS helper** (`whq-ear`). It listens to two streams at once: your mic and
  the laptop's sound output. It turns both into text **on the laptop**, live, and streams that text
  to the Work HQ server.
- Work HQ does the rest with what it already has. 🍍 fires from *your* stream only. When a meeting
  ends, the existing transcript prompt reads the local transcript, just like it reads Meet notes now.
- It works for any meeting: Zoom, Meet, Slack huddles, a phone on speaker, a room with people in it.
  It never joins the call as a bot.
- **RealtimeKit is the wrong core.** It is a platform for hosting WebRTC meetings. Its transcription
  only covers people inside a RealtimeKit meeting, and it runs in the cloud. You can force it to work
  with a one-person "meeting" that publishes your laptop's audio, but then you pay per minute and
  colleagues' voices leave the laptop. You also still have to solve local audio capture, which is
  the hard part. Keep it, or Workers AI Nova-3 directly, as an optional cloud engine behind the
  same interface.
- Recommended speech-to-text engine: **Apple SpeechAnalyzer** (macOS 26, on-device, streaming,
  no model to download). Fallback: **Parakeet** through HEX, which is already installed and used
  for dictation.

## Why

What we have today ([`voice.ts`](../../src/web/voice.ts), [`transcripts.md`](../../prompts/sweeps/transcripts.md)):

| Gap | Today |
|---|---|
| Meetings outside Meet | The transcript sweep only finds notes that a meetings tool wrote (for example Gemini in Meet). Zoom, huddles, in-person meetings, 1-1s on a walk and vendor calls leave nothing behind. |
| Who said "pineapple" | The 🍍 listener uses Chrome Web Speech on the laptop mic. It hears everyone. The "only when the owner says it" rule is a guess the triage model makes from context. |
| Fragile | Web Speech only runs while the dashboard tab is open, stops on silence, and shares one recogniser with dictation. Chrome usually sends that audio to Google's servers, so it's not local. |
| No context without 🍍 | If you don't say the word, nothing from the meeting reaches Work HQ until (or unless) notes show up. |

## Goals and non-goals

**Goals**

1. A live rolling transcript whenever you turn it on, for any app or none.
2. Tells **me** from **them**: two separate streams, not a guess.
3. 🍍 capture with better context: who said what, and the meeting it came from.
4. After each meeting: owner actions, decisions and context become items. This uses the same rules
   as the existing transcript sweep, so there is one way to extract and one way to remove duplicates.
5. Local by default. Audio never leaves the laptop. Only text goes to pi or the model, the same as today.

**Non-goals**

- A meeting bot, video, or recording for other people. This is a personal memory aid.
- Keeping audio. The default is to keep text only.
- Replacing a meeting tool's own notes when they exist. Those stay as a check.

## Options

### A. RealtimeKit (Cloudflare)

What it is: SDKs and a managed WebRTC network for building your own meeting app. Its
[transcription](https://developers.cloudflare.com/realtime/realtimekit/ai/transcription/) has two modes:
live (Deepgram Nova-3 on Workers AI, sent to clients through `meeting.ai.on("transcript")`) and after
the meeting (Whisper Large v3 Turbo). It also offers
[summaries](https://developers.cloudflare.com/realtime/realtimekit/ai/summary/) and webhooks. It
transcribes each participant's audio separately, so it labels speakers.

How it could fit: the helper (or a headless page) joins a private RealtimeKit meeting as two
participants: "me" (mic) and "room" (the laptop's sound output). Live transcript events then come
back per participant.

| For | Against |
|---|---|
| Per-participant labels come free | **Not local.** Colleagues' voices go to a cloud account. A work account would need sign-off. A personal account is out of the question. |
| Nova-3 is good and fast. Summaries and webhooks come built in | Doesn't capture anything. You still need the same native audio capture (mic + sound output) as option B. That's the hard part. |
| Matches the planned move to the cloud (Durable Object) | Cost: about **$0.0092 per audio minute** for Nova-3 over WebSocket ([pricing](https://developers.cloudflare.com/workers-ai/models/nova-3/)). Two streams × 4 h a day comes to about $4.40 a day in transcription. That's before RealtimeKit's own participant-minute pricing, which isn't checked here. |
| | Needs network, an app ID, presets, tokens. Breaks on a plane or bad Wi-Fi. |
| | A meeting platform used as a transcription pipe. If you want cloud STT, calling Nova-3 on Workers AI directly over WebSocket does the same job with fewer parts. |

**Verdict:** not the core. It can be an optional engine (`engine: "cloud"`), and Workers AI Nova-3
directly is the simpler version of it.

### B. Local native helper (recommended)

**Capture**: a Swift CLI, about 300 lines to start.

- Mic: `AVAudioEngine` input tap → stream `me`.
- Sound output: **Core Audio process taps** (macOS 14.2+, `CATapDescription`) for system-wide or
  per-app audio (Zoom, Chrome, Slack) → stream `them`. ScreenCaptureKit audio is the fallback.
  No virtual audio driver (BlackHole) needed.
- Detect a live call: Core Audio `kAudioDevicePropertyDeviceIsRunningSomewhere` on the input device
  (another app is using the mic) plus the current calendar event. This allows an optional
  "start when a meeting starts".
- Permissions: Microphone plus "System Audio Recording". Both are one-time prompts.

**Speech-to-text engines** (behind one interface; `auto` picks the first that works):

| Engine | Streaming | Notes |
|---|---|---|
| **Apple SpeechAnalyzer / SpeechTranscriber** (macOS 26) | yes. Draft text first, final text after | On-device, Apple manages the model, no download, low CPU, made for long-form audio. **First choice** (the laptop runs 26.5). |
| **Parakeet via HEX** (already installed: `parakeet-unified-en-0.6b`) | no. Send a file, get text back | Reuses [`transcribe.ts`](../../src/server/transcribe.ts). Split audio at pauses (VAD) into 5–20 s chunks. A few seconds' delay, very accurate. Good fallback, and good for the final pass. |
| FluidAudio (Swift, CoreML/ANE: Parakeet + VAD + diarization) | near real time | The best route to **speaker separation in the room** (phase 3). |
| whisper.cpp `stream` / WhisperKit | yes | Well-tested, heavier on CPU and battery. |
| Cloud: Workers AI Nova-3 WebSocket, or RealtimeKit | yes | Option A. Only if you choose it. |

**In-person meetings**: the mic hears everyone, so `them` is empty. To pick out your voice, enrol
30 s of it once, then match speaker embeddings (FluidAudio diarization). Phase 3. Until then,
in-person transcripts are labelled `room` and 🍍 keeps today's rule where the model guesses from context.

### C. Do nothing extra: improve the Chrome listener

Capture tab audio with `getDisplayMedia` and keep Web Speech. That only covers browser meetings,
still sends audio to Google, still dies when the tab closes, and does nothing in a room. Rejected.

### D. Buy one (Granola, Otter, Krisp notes, etc.)

They're polished, but they keep transcripts in their cloud, and getting data into Work HQ means
scraping or an API we don't control. Company data policy probably rules them out for internal
meetings anyway. Worth a look only as a reference for the UX.

## Design (option B)

```
 mic ─┐                          ┌─ /api/ear (WebSocket) ─► Hub: rolling buffer (last ~5 min)
      ├─ whq-ear (Swift) ─ STT ──┤                            ├─ 🍍 spotted on `me` → triage("pineapple")
 sound┘   VAD, two streams       └─ ~/.local/state/work-hq/ear/YYYY-MM-DD/<session>.jsonl
                                                               └─ session end → extract (transcripts prompt, local source)
```

**Segment format** (one JSONL line per final segment; drafts are only sent over the socket):

```json
{ "session": "ear_2026-10-14T09-30_standup", "t0": 1234.5, "t1": 1239.1, "src": "me", "text": "I'll chase the rollout today, pineapple", "final": true }
```

`src` is `me` | `them` | `room`, plus an optional `speaker` once diarization exists.

**Work HQ server changes**

1. `POST/WS /api/ear`: takes segments into a rolling buffer **on the server**. The 🍍 listener moves
   from the browser to here. Whenever the helper is connected, it replaces Web Speech. When it's
   not, the browser listener stays as the fallback.
2. **Keyword spotting is code, not a guess:** `/\bpine\s?apple\b/` on `src: "me"` segments only.
   After it fires, wait 7 s (as now), then send the last 150 s **with speaker labels** to
   `agents.triage(…, "pineapple")`. The item quote is your words, and the context is both sides.
3. **Sessions.** A session starts when you press ⌘. / use the menu bar, or automatically when a call
   is detected. It ends after N minutes of silence, when the mic is released, or by hand. It is
   matched to a calendar event by time (the calendar sweep already has events). If nothing matches,
   it's an "unscheduled conversation" and the title comes from the first minute.
4. **Extraction after the meeting.** When a session ends, run the existing
   [`transcripts.md`](../../prompts/sweeps/transcripts.md) rules on the local file. Source key
   `transcript:local:<session>:<slug>`, so the existing duplicate check stops it clashing with
   Meet notes for the same meeting. It closes the **Meeting ended** card ("transcript scanned"), as
   the Meet sweep does today. It also writes one journal line: *"Standup (14 min): 2 items, 1 decision"*.
5. **Context for items.** Captured items carry a quote and a link `ear://<session>#t=1234`, which the
   dashboard opens as a transcript view scrolled to that moment. Prep briefs for the next meeting
   with the same people can read the last session.

**Storage and privacy**

- Text only. No audio on disk, unless `ear.keepAudio` is on for debugging (deleted after 24 h).
- Transcripts stay in `~/.local/state/work-hq/ear/`, kept 14 days by default and then deleted.
  **They are never synced to the memory MCP.** Only extracted items and the journal line go there.
- A clear on-screen sign while listening (a menu bar dot plus the dashboard pill). Off by default
  each morning; you choose to turn it on.
- **Consent:** tell people. In a 1-1 or a room: "I've a local transcriber running for my notes, OK?"
  Some places require everyone's consent (EU/GDPR, two-party US states). Company policy on
  recording internal meetings still needs checking (see open questions).

**Config sketch**

```json
"voice": {
  "ear": {
    "enabled": true,
    "engine": "auto",            // apple | hex | fluid | whisper | cloud
    "sources": ["mic", "system"], // system can be narrowed: { "apps": ["zoom.us", "Google Chrome", "Slack"] }
    "autoStart": "calendar",     // off | calendar | call-detected
    "retainDays": 14,
    "keepAudio": false
  }
}
```

## Plan

| Phase | Scope | Size |
|---|---|---|
| **0. Spike** | Swift CLI: mic + system tap → SpeechTranscriber → JSONL to stdout. Measure delay, CPU and battery, and accuracy on one Zoom call, one Meet call and one in-person 1-1 (with consent). Compare with HEX/Parakeet on the same audio. | ½–1 day |
| **1. Live 🍍** | `/api/ear` WebSocket, server-side buffer, keyword spotting on `me` only, browser fallback, dashboard pill. `bin/work-hq` starts and stops the helper. | 1–2 days |
| **2. After-meeting extraction** | Sessions, calendar matching, local transcript source in the transcripts sweep, closing the Meeting ended card, transcript view, retention job. | 2 days |
| **3. Rooms** | Diarization plus enrolment of your voice (FluidAudio), attendee names from the calendar. | 2–3 days |
| **4. Optional cloud engine** | Workers AI Nova-3 WebSocket (or RealtimeKit) behind `engine: "cloud"`, for poor mics or when the laptop is busy. | 1 day |

Success after two weeks on phase 2: at least 80% of non-Meet meetings produce a scanned card. Fewer
"Meeting ended → anything come out of it?" questions that you answer by hand. Fewer than one false 🍍 a week.

## Open questions

1. **Policy.** Is transcribing (not recording) internal meetings on your own laptop allowed by
   company policy, and does it need a disclosure line in invites? This is the one that blocks everything else.
2. Default to **off every morning** or **auto-start on calendar meetings**? (Proposed: off, with a one-key prompt when a call starts.)
3. Is 14 days the right retention? Should 1-1 transcripts be kept for less time, or not kept at all
   (extract, then delete)?
4. Is cloud STT ever acceptable for internal meetings, or should option A be dropped completely?
