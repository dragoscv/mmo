import Foundation

/// Fading sleep timer: full volume until `fadeSec` before the end, then linear to 0 (D38 "fading sleep timer").
public func sleepFadeVolume(remainingSec: Double, fadeSec: Double = 30) -> Float {
    guard remainingSec > 0 else { return 0 }
    guard fadeSec > 0, remainingSec < fadeSec else { return 1 }
    return Float(max(0, min(1, remainingSec / fadeSec)))
}

/// Night mode: simple feed-forward compressor gain for one block (RMS in dBFS → linear gain).
/// threshold -24 dB, ratio 4:1, make-up +6 dB, output never above 0 dBFS. Pure; used by the audio tap.
public struct NightCompressor: Sendable, Equatable {
    public var thresholdDb: Float = -24
    public var ratio: Float = 4
    public var makeupDb: Float = 6
    /// One-pole smoothing of the gain between blocks (0 = none, 1 = frozen).
    public var smoothing: Float = 0.8
    public private(set) var gain: Float = 1

    public init() {}

    public static func db(_ linear: Float) -> Float { linear > 1e-9 ? 20 * log10(linear) : -180 }
    public static func linear(_ db: Float) -> Float { pow(10, db / 20) }

    /// Target gain for a block whose RMS is `rms` (linear 0...1).
    public func targetGain(rms: Float) -> Float {
        let level = Self.db(rms)
        let over = level - thresholdDb
        let reduction: Float = over > 0 ? over - over / ratio : 0
        var g = Self.linear(makeupDb - reduction)
        // Never push the block above full scale.
        if rms > 0, rms * g > 1 { g = 1 / rms }
        return g
    }

    public mutating func process(rms: Float) -> Float {
        gain = smoothing * gain + (1 - smoothing) * targetGain(rms: rms)
        return gain
    }
}

/// Picks the second subtitle line for dual subtitles: cue text at `t` from the secondary track, nil when it would
/// duplicate the primary line.
public func dualSubtitleLine(primary: String?, secondaryCues: [SubtitleCue], at t: Double) -> String? {
    guard let s = WebVTT.active(secondaryCues, at: t) else { return nil }
    return s == primary ? nil : s
}

/// Search inside the loaded cues (case/diacritic-insensitive, all words) — offline fallback of `/media/subtitles/search`.
public func searchCues(_ cues: [SubtitleCue], query: String, limit: Int = 50) -> [SubtitleCue] {
    let words = query.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).split(whereSeparator: \.isWhitespace).map(String.init)
    guard !words.isEmpty else { return [] }
    var out: [SubtitleCue] = []
    for c in cues {
        let hay = c.text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        if words.allSatisfy({ hay.contains($0) }) {
            out.append(c)
            if out.count >= limit { break }
        }
    }
    return out
}

/// Data saver: original quality only on Wi-Fi when the user enabled the saver and the path is expensive.
public enum DataSaverDecision: Sendable, Equatable { case play, ask, blockDownload }

public func dataSaverDecision(expensive: Bool, saverOn: Bool, acknowledged: Bool, isDownload: Bool) -> DataSaverDecision {
    guard expensive, saverOn else { return .play }
    if isDownload { return .blockDownload }
    return acknowledged ? .play : .ask
}

/// Engine choice: AVPlayer first; VLC when AVFoundation refuses the container/codec (D36).
public func shouldFallBackToVLC(errorDomain: String, errorCode: Int, underlyingCodes: [Int]) -> Bool {
    // AVFoundationErrorDomain: -11828 cannot open, -11829 not a media file, -11833 cannot decode, -11821 decode
    // failed, -11800 unknown (with an underlying CoreMedia format error -12847 / -12848 / -16170).
    let fatalFormat: Set<Int> = [-11828, -11829, -11833, -11821, -11832]
    if errorDomain == "AVFoundationErrorDomain" {
        if fatalFormat.contains(errorCode) { return true }
        if errorCode == -11800, underlyingCodes.contains(where: { [-12847, -12848, -16170, -12927].contains($0) }) { return true }
    }
    if errorDomain == "CoreMediaErrorDomain", [-12847, -12848, -16170, -12927].contains(errorCode) { return true }
    return false
}
