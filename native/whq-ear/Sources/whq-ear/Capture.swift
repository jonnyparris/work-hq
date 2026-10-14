// Audio sources: the mic (AVAudioEngine) and the Mac's sound output (Core Audio process tap,
// macOS 14.2+). No virtual audio driver.

import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

final class Mic {
  let engine = AVAudioEngine()

  func start(aec: Bool, onBuffer: @escaping (AVAudioPCMBuffer) -> Void) async throws {
    let ok = await AVCaptureDevice.requestAccess(for: .audio)
    guard ok else { throw EarError("microphone permission denied (System Settings → Privacy → Microphone)") }
    let node = engine.inputNode
    if aec {
      // Voice processing = echo cancellation + noise suppression. Stops "me" hearing the speakers.
      try node.setVoiceProcessingEnabled(true)
      node.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
    }
    let fmt = node.outputFormat(forBus: 0)
    node.installTap(onBus: 0, bufferSize: 4096, format: fmt) { buf, _ in onBuffer(buf) }
    engine.prepare()
    try engine.start()
  }

  func stop() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
  }
}

func check(_ status: OSStatus, _ what: String) throws {
  if status != noErr { throw EarError("\(what) failed: OSStatus \(status)") }
}

func getProp<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ initial: T) throws -> T {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal,
                                        mElement: kAudioObjectPropertyElementMain)
  var v = initial
  var size = UInt32(MemoryLayout<T>.size)
  try check(AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v), "get property \(sel)")
  return v
}

final class SystemTap {
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggID = AudioObjectID(kAudioObjectUnknown)
  private var procID: AudioDeviceIOProcID?
  private let queue = DispatchQueue(label: "whq-ear.tap", qos: .userInitiated)

  /// bundleIDs empty = everything the Mac plays.
  func start(bundleIDs: [String], onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
    let desc: CATapDescription
    if bundleIDs.isEmpty {
      desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    } else {
      desc = CATapDescription(stereoMixdownOfProcesses: [])
      desc.bundleIDs = bundleIDs
    }
    desc.uuid = UUID()
    desc.name = "whq-ear"
    desc.isPrivate = true
    desc.muteBehavior = .unmuted
    try check(AudioHardwareCreateProcessTap(desc, &tapID), "AudioHardwareCreateProcessTap (System Audio Recording permission?)")

    let outDev: AudioObjectID = try getProp(AudioObjectID(kAudioObjectSystemObject),
                                            kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(0))
    let outUID: CFString = try getProp(outDev, kAudioDevicePropertyDeviceUID, "" as CFString)
    let agg: [String: Any] = [
      kAudioAggregateDeviceNameKey: "whq-ear-tap",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outUID as String,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID as String]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true,
                                         kAudioSubTapUIDKey: desc.uuid.uuidString]],
    ]
    try check(AudioHardwareCreateAggregateDevice(agg as CFDictionary, &aggID), "AudioHardwareCreateAggregateDevice")

    var asbd: AudioStreamBasicDescription = try getProp(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
    guard let fmt = AVAudioFormat(streamDescription: &asbd) else { throw EarError("tap format unreadable") }
    FileHandle.standardError.write("system tap: \(fmt)\n".data(using: .utf8)!)

    try check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, queue) { _, inData, _, _, _ in
      guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, bufferListNoCopy: inData, deallocator: nil) else { return }
      onBuffer(buf)
    }, "AudioDeviceCreateIOProcIDWithBlock")
    try check(AudioDeviceStart(aggID, procID), "AudioDeviceStart")
  }

  func stop() {
    if aggID != kAudioObjectUnknown {
      AudioDeviceStop(aggID, procID)
      if let p = procID { AudioDeviceDestroyIOProcID(aggID, p) }
      AudioHardwareDestroyAggregateDevice(aggID)
    }
    if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
  }
}

/// Another app holds the mic: the "call is live" signal for auto-start (phase 1).
func micInUseSomewhere() -> Bool {
  guard let dev: AudioObjectID = try? getProp(AudioObjectID(kAudioObjectSystemObject),
                                              kAudioHardwarePropertyDefaultInputDevice, AudioObjectID(0)),
        let running: UInt32 = try? getProp(dev, kAudioDevicePropertyDeviceIsRunningSomewhere, UInt32(0))
  else { return false }
  return running != 0
}
