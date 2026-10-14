// One audio source ("me" / "them" / "room") → its own SpeechAnalyzer + SpeechTranscriber.
// Takes buffers in any format, converts to what the analyzer wants, stamps them with a
// sample-count clock, and turns results into JSONL segments with lag measurements.

import AVFoundation
import CoreMedia
import Foundation
import Speech

struct Segment: Encodable {
  let session: String
  let src: String
  let t0: Double // seconds since this source started
  let t1: Double
  let at: String // wall clock of t0, ISO-8601
  let text: String
  let final: Bool
  let lag: Double // seconds between the end of the audio (t1) and this line being emitted
}

final class Lags {
  private var xs: [Double] = []
  func add(_ x: Double) { xs.append(x) }
  var count: Int { xs.count }
  func pct(_ p: Double) -> Double? {
    guard !xs.isEmpty else { return nil }
    let s = xs.sorted()
    return s[min(s.count - 1, Int((Double(s.count - 1) * p).rounded()))]
  }
  var mean: Double? { xs.isEmpty ? nil : xs.reduce(0, +) / Double(xs.count) }
  var summary: [String: Any] {
    ["n": count, "mean": r(mean), "p50": r(pct(0.5)), "p90": r(pct(0.9)), "max": r(pct(1))]
  }
}

func r(_ x: Double?) -> Any { x.map { NSDecimalNumber(string: String(format: "%.2f", $0)) } ?? NSNull() }

let iso: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()

final class Ear {
  let src: String
  let session: String
  let transcriber: SpeechTranscriber
  let analyzer: SpeechAnalyzer
  let format: AVAudioFormat
  private let input: AsyncStream<AnalyzerInput>.Continuation
  private let inputStream: AsyncStream<AnalyzerInput>
  private var converter: AVAudioConverter?
  private var converterFrom: AVAudioFormat?
  private let lock = NSLock()
  private(set) var frames: Int64 = 0
  private(set) var startWall: Double? // epoch seconds of the first sample
  var saveFile: AVAudioFile?
  let draftLags = Lags()
  let finalLags = Lags()
  var finals: [String] = []
  var emit: (Segment) -> Void = { _ in }
  var drafts = false

  init(src: String, session: String, locale: Locale, fast: Bool) async throws {
    self.src = src
    self.session = session
    var reporting: Set<SpeechTranscriber.ReportingOption> = [.volatileResults]
    if fast { reporting.insert(.fastResults) }
    transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: reporting,
                                    attributeOptions: [.audioTimeRange])
    guard let f = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw EarError("no audio format for SpeechTranscriber")
    }
    format = f
    (inputStream, input) = AsyncStream<AnalyzerInput>.makeStream()
    analyzer = SpeechAnalyzer(modules: [transcriber])
  }

  /// vocab: names and jargon (attendees, project names, ticket prefixes) that bias recognition.
  func start(vocab: [String] = []) async throws {
    if !vocab.isEmpty {
      let ctx = AnalysisContext()
      ctx.contextualStrings[.general] = vocab
      try await analyzer.setContext(ctx)
    }
    try await analyzer.prepareToAnalyze(in: format)
    try await analyzer.start(inputSequence: inputStream)
  }

  /// Consume results until the analyzer finishes.
  func run() async {
    do {
      for try await res in transcriber.results {
        let text = String(res.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        let t0 = res.range.start.seconds
        let t1 = (res.range.start + res.range.duration).seconds
        let base = startWall ?? Date().timeIntervalSince1970
        let now = Date().timeIntervalSince1970
        let lag = now - (base + t1)
        if res.isFinal { finalLags.add(lag); finals.append(text) } else { draftLags.add(lag) }
        if res.isFinal || drafts {
          emit(Segment(session: session, src: src, t0: (t0 * 100).rounded() / 100, t1: (t1 * 100).rounded() / 100,
                       at: iso.string(from: Date(timeIntervalSince1970: base + t0)), text: text,
                       final: res.isFinal, lag: (lag * 100).rounded() / 100))
        }
      }
    } catch {
      FileHandle.standardError.write("[\(src)] results error: \(error)\n".data(using: .utf8)!)
    }
  }

  /// Any format in; converted, clock-stamped, and handed to the analyzer. Copies synchronously,
  /// so it's safe to call from a Core Audio IO block with a transient buffer.
  func feed(_ buf: AVAudioPCMBuffer) {
    lock.lock(); defer { lock.unlock() }
    if startWall == nil { startWall = Date().timeIntervalSince1970 }
    if converterFrom == nil || converterFrom! != buf.format {
      converter = AVAudioConverter(from: buf.format, to: format)
      converter?.primeMethod = .none
      converterFrom = buf.format
    }
    guard let conv = converter else { return }
    let cap = AVAudioFrameCount((Double(buf.frameLength) * format.sampleRate / buf.format.sampleRate).rounded(.up)) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return }
    var given = false
    var err: NSError?
    conv.convert(to: out, error: &err) { _, status in
      if given { status.pointee = .noDataNow; return nil }
      given = true
      status.pointee = .haveData
      return buf
    }
    if let err { FileHandle.standardError.write("[\(src)] convert: \(err)\n".data(using: .utf8)!); return }
    if out.frameLength == 0 { return }
    let t = CMTime(value: frames, timescale: CMTimeScale(format.sampleRate))
    frames += Int64(out.frameLength)
    try? saveFile?.write(from: out)
    input.yield(AnalyzerInput(buffer: out, bufferStartTime: t))
  }

  var seconds: Double { Double(frames) / format.sampleRate }

  func finish() async {
    input.finish()
    do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch {
      FileHandle.standardError.write("[\(src)] finish: \(error)\n".data(using: .utf8)!)
    }
  }

  var stats: [String: Any] {
    ["src": src, "audioSeconds": r(seconds), "finals": finals.count,
     "draftLag": draftLags.summary, "finalLag": finalLags.summary]
  }
}

struct EarError: Error, CustomStringConvertible {
  let description: String
  init(_ s: String) { description = s }
}

/// Make sure the on-device model for this locale is installed. Apple downloads it once.
func ensureModel(locale: Locale) async throws -> Locale {
  guard SpeechTranscriber.isAvailable else { throw EarError("SpeechTranscriber isn't available on this Mac") }
  guard let loc = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
    throw EarError("locale \(locale.identifier) not supported")
  }
  let probe = SpeechTranscriber(locale: loc, preset: .progressiveTranscription)
  if let req = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
    FileHandle.standardError.write("checking speech model for \(loc.identifier)…\n".data(using: .utf8)!)
    try await req.downloadAndInstall()
  }
  return loc
}
