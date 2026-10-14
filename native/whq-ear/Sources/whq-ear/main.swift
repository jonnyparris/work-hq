// whq-ear — phase 0 spike of docs/proposals/local-meeting-listener.md.
//
//   whq-ear probe
//   whq-ear live [--src mic,system] [--session NAME] [--out FILE] [--save-audio DIR]
//                [--duration SECS] [--drafts] [--aec] [--apps us.zoom.xos,com.google.Chrome] [--fast]
//   whq-ear file WAV [--src room] [--realtime] [--drafts] [--fast]
//   common: [--locale en-GB] [--vocab "Quillby,QRX,Browser Run"]
//
// Final segments go to stdout as JSONL (and --out). Drafts too with --drafts. On exit a JSON summary
// (lags, CPU) goes to stderr. Ctrl-C ends a live session cleanly.

import AVFoundation
import Darwin
import Foundation
import Speech

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

struct Args {
  var mode = "live"
  var file: String?
  var srcs: [String] = ["mic", "system"]
  var session = "ear_" + ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
  var out: String?
  var saveAudio: String?
  var duration: Double?
  var drafts = false
  var aec = false
  var apps: [String] = []
  var fast = false
  var realtime = false
  var locale = Locale.current.identifier
  var fileSrc = "room"
  var vocab: [String] = []

  init(_ argv: [String]) {
    var it = argv.dropFirst().makeIterator()
    if let m = it.next() { mode = m }
    while let a = it.next() {
      switch a {
      case "--src": if mode == "file" { fileSrc = it.next() ?? "room" } else { srcs = (it.next() ?? "").split(separator: ",").map(String.init) }
      case "--session": session = it.next() ?? session
      case "--out": out = it.next()
      case "--save-audio": saveAudio = it.next()
      case "--duration": duration = Double(it.next() ?? "")
      case "--drafts": drafts = true
      case "--aec": aec = true
      case "--apps": apps = (it.next() ?? "").split(separator: ",").map(String.init)
      case "--vocab": vocab = (it.next() ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
      case "--fast": fast = true
      case "--realtime": realtime = true
      case "--locale": locale = it.next() ?? locale
      default: if file == nil && !a.hasPrefix("--") { file = a } else { log("unknown arg \(a)"); exit(2) }
      }
    }
  }
}

final class Out {
  private let lock = NSLock()
  private let fh: FileHandle?
  private let enc = JSONEncoder()
  init(path: String?) {
    if let p = path {
      FileManager.default.createFile(atPath: p, contents: nil)
      fh = FileHandle(forWritingAtPath: p)
      fh?.seekToEndOfFile()
    } else { fh = nil }
    enc.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
  }
  func write(_ s: Segment) {
    guard let d = try? enc.encode(s) else { return }
    lock.lock(); defer { lock.unlock() }
    FileHandle.standardOutput.write(d + [0x0A])
    if s.final { fh?.write(d + [0x0A]) }
  }
}

func cpuSeconds() -> Double {
  var u = rusage()
  getrusage(RUSAGE_SELF, &u)
  return Double(u.ru_utime.tv_sec) + Double(u.ru_utime.tv_usec) / 1e6 + Double(u.ru_stime.tv_sec) + Double(u.ru_stime.tv_usec) / 1e6
}

func printSummary(_ ears: [Ear], wall: Double, cpu: Double, extra: [String: Any] = [:]) {
  var o: [String: Any] = ["summary": true, "wallSeconds": r(wall), "cpuSeconds": r(cpu),
                          "cpuPercent": r(wall > 0 ? cpu / wall * 100 : nil), "streams": ears.map(\.stats)]
  for (k, v) in extra { o[k] = v }
  if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) {
    FileHandle.standardError.write(d + [0x0A])
  }
}

func waitForStop(duration: Double?) async {
  await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
    let once = NSLock()
    var done = false
    let fire = { once.lock(); defer { once.unlock() }; if !done { done = true; c.resume() } }
    for sig in [SIGINT, SIGTERM] {
      signal(sig, SIG_IGN)
      let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      s.setEventHandler { fire() }
      s.resume()
      sources.append(s)
    }
    if let d = duration { DispatchQueue.main.asyncAfter(deadline: .now() + d) { fire() } }
  }
}
nonisolated(unsafe) var sources: [DispatchSourceSignal] = []

func saveFile(dir: String, session: String, src: String, format: AVAudioFormat) -> AVAudioFile? {
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  let url = URL(fileURLWithPath: dir).appendingPathComponent("\(session)-\(src).wav")
  // 16 kHz mono 16-bit: what HEX takes, and what the analyzer was fed.
  let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate,
                                 AVNumberOfChannelsKey: format.channelCount, AVLinearPCMBitDepthKey: 16,
                                 AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
  return try? AVAudioFile(forWriting: url, settings: settings, commonFormat: format.commonFormat,
                          interleaved: format.isInterleaved)
}

func run() async throws {
  let args = Args(CommandLine.arguments)
  let t0 = Date().timeIntervalSince1970
  let c0 = cpuSeconds()

  switch args.mode {
  case "probe":
    log("SpeechTranscriber.isAvailable: \(SpeechTranscriber.isAvailable)")
    let loc = try await ensureModel(locale: Locale(identifier: args.locale))
    log("locale: \(loc.identifier)")
    log("installed: \(await SpeechTranscriber.installedLocales.map(\.identifier))")
    let ear = try await Ear(src: "probe", session: "probe", locale: loc, fast: false)
    log("analyzer format: \(ear.format)")
    log("mic in use by another app: \(micInUseSomewhere())")

  case "file":
    guard let path = args.file else { log("usage: whq-ear file WAV"); exit(2) }
    let loc = try await ensureModel(locale: Locale(identifier: args.locale))
    let out = Out(path: args.out)
    let ear = try await Ear(src: args.fileSrc, session: args.session, locale: loc, fast: args.fast)
    ear.drafts = args.drafts
    ear.emit = out.write
    try await ear.start(vocab: args.vocab)
    let reader = Task { await ear.run() }
    let f = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    let chunk = AVAudioFrameCount(f.processingFormat.sampleRate / 10) // 100 ms, like a live tap
    let started = Date().timeIntervalSince1970
    var fed = 0.0
    while f.framePosition < f.length {
      guard let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: chunk) else { break }
      try f.read(into: b, frameCount: chunk)
      if b.frameLength == 0 { break }
      ear.feed(b)
      fed += Double(b.frameLength) / f.processingFormat.sampleRate
      if args.realtime {
        let ahead = fed - (Date().timeIntervalSince1970 - started)
        if ahead > 0 { try await Task.sleep(nanoseconds: UInt64(ahead * 1e9)) }
      }
    }
    await ear.finish()
    await reader.value
    let wall = Date().timeIntervalSince1970 - t0
    printSummary([ear], wall: wall, cpu: cpuSeconds() - c0,
                 extra: ["audioSeconds": r(fed), "realtimeFactor": r(fed > 0 ? wall / fed : nil),
                         "text": ear.finals.joined(separator: " ")])

  case "live":
    let loc = try await ensureModel(locale: Locale(identifier: args.locale))
    let out = Out(path: args.out)
    var ears: [Ear] = []
    var readers: [Task<Void, Never>] = []
    var mic: Mic?
    var tap: SystemTap?
    for s in args.srcs {
      let name = s == "mic" ? "me" : s == "system" ? "them" : s
      let ear = try await Ear(src: name, session: args.session, locale: loc, fast: args.fast)
      ear.drafts = args.drafts
      ear.emit = out.write
      if let dir = args.saveAudio { ear.saveFile = saveFile(dir: dir, session: args.session, src: name, format: ear.format) }
      try await ear.start(vocab: args.vocab)
      readers.append(Task { await ear.run() })
      ears.append(ear)
      if s == "mic" {
        let m = Mic()
        try await m.start(aec: args.aec) { ear.feed($0) }
        mic = m
      } else if s == "system" {
        let t = SystemTap()
        try t.start(bundleIDs: args.apps) { ear.feed($0) }
        tap = t
      } else {
        throw EarError("unknown source \(s) (mic | system)")
      }
    }
    log("listening: \(ears.map(\.src).joined(separator: ", ")) · session \(args.session) · Ctrl-C to stop")
    let ticker = Task.detached {
      var lastCpu = cpuSeconds(), lastT = Date().timeIntervalSince1970
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 10_000_000_000)
        let c = cpuSeconds(), t = Date().timeIntervalSince1970
        log("tick: " + ears.map { "\($0.src) \(String(format: "%.1f", $0.seconds)) s audio, \($0.finals.count) finals" }.joined(separator: " · ")
          + String(format: " · cpu %.1f%%", (c - lastCpu) / (t - lastT) * 100))
        lastCpu = c; lastT = t
      }
    }
    await waitForStop(duration: args.duration)
    ticker.cancel()
    log("stopping…")
    mic?.stop()
    tap?.stop()
    for e in ears { await e.finish() }
    for t in readers { await t.value }
    printSummary(ears, wall: Date().timeIntervalSince1970 - t0, cpu: cpuSeconds() - c0)

  default:
    log("usage: whq-ear probe | live [...] | file WAV [...]")
    exit(2)
  }
}

do { try await run() } catch {
  log("whq-ear: \(error)")
  exit(1)
}
exit(0)
