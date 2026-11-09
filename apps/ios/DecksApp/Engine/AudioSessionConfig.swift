import Foundation
#if os(iOS)
import AVFoundation
#endif

/// iOS / iPadOS audio session for DJ playback: `.playback` (keeps playing with the silent switch, in the
/// background and on AirPlay/USB), 5 ms IO buffer request, 48 kHz preferred. macOS has no session; the Rust
/// engine (cpal / CoreAudio) opens the default output directly.
enum AudioSessionConfig {
    static func activate() throws {
        #if os(iOS)
        let s = AVAudioSession.sharedInstance()
        // .playback already routes to A2DP / AirPlay / USB; the allow* options belong to .playAndRecord.
        try s.setCategory(.playback, mode: .default)
        try? s.setPreferredSampleRate(48_000)
        try? s.setPreferredIOBufferDuration(0.005)
        try s.setActive(true)
        #endif
    }

    /// Human-readable route summary for Settings (e.g. "USB Audio · 48 kHz · 5.3 ms").
    static func routeSummary() -> String? {
        #if os(iOS)
        let s = AVAudioSession.sharedInstance()
        let out = s.currentRoute.outputs.map(\.portName).joined(separator: ", ")
        return String(format: "%@ · %.0f kHz · %.1f ms", out, s.sampleRate / 1000, (s.ioBufferDuration + s.outputLatency) * 1000)
        #else
        return nil
        #endif
    }
}
