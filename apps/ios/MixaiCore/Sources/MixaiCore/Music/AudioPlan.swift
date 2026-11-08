import Foundation

/// Playback audio preferences (port of Android `AudioPrefs`, WP17-41e). Defaults = off.
public struct AudioPrefs: Sendable, Equatable, Codable {
    /// Crossfade length between tracks in ms (0 = plain gapless transitions).
    public var crossfadeMs: Int
    /// Loudness normalisation from the server's EBU R128 measurement (`TrackCard.loudnessLufs` / `truePeakDbfs`).
    public var normalize: Bool
    /// Automix (WP17-44): beat-aligned crossfades with tempo match up to ±6 % when both tracks have BPM data.
    public var automix: Bool

    public init(crossfadeMs: Int = 0, normalize: Bool = false, automix: Bool = false) {
        self.crossfadeMs = crossfadeMs
        self.normalize = normalize
        self.automix = automix
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        crossfadeMs = try c.decodeIfPresent(Int.self, forKey: .crossfadeMs) ?? 0
        normalize = try c.decodeIfPresent(Bool.self, forKey: .normalize) ?? false
        // Absent in blobs saved before WP17-44: automix is on by default (D56), it only acts while crossfade > 0.
        automix = try c.decodeIfPresent(Bool.self, forKey: .automix) ?? true
    }

    /// Settings choices for the crossfade picker (seconds).
    public static let crossfadeChoices = [0, 3, 6, 9, 12]
}

/// How one crossfade runs (automix): incoming start offset, incoming tempo during the overlap, fade length.
public struct MixPlan: Sendable, Equatable {
    /// Start the incoming track here (its first downbeat), ms.
    public var incomingStartMs: Int
    /// Playback rate of the incoming track during the overlap (glides back to 1 after the handoff).
    public var incomingRate: Float
    /// Fade length snapped to whole bars of the outgoing track, ms.
    public var fadeMs: Int
    public var beatMatched: Bool
}

/// Pure decisions behind normalisation and crossfade (same numbers as Android `AudioPlan`, so both apps sound alike).
public enum AudioPlan {
    public static let targetLufs = -14.0
    /// Gain never pushes the measured true peak above this (dBTP), so a boost cannot clip.
    public static let ceilingDbtp = -1.0
    public static let maxBoostDb = 12.0
    public static let maxCutDb = -24.0
    static let minFadeMs = 1000

    /// Playback gain in dB towards `target`: boosts capped by the true-peak ceiling; unknown peak → attenuate only;
    /// not analysed → 0.
    public static func gainDb(lufs: Double?, truePeak: Double?, target: Double = targetLufs) -> Double {
        guard let lufs, lufs.isFinite else { return 0 }
        let wanted = target - lufs
        let capped: Double
        if let truePeak, truePeak.isFinite { capped = min(wanted, ceilingDbtp - truePeak) } else { capped = min(wanted, 0) }
        return min(maxBoostDb, max(maxCutDb, capped))
    }

    public static func linear(_ db: Double) -> Float { Float(pow(10, db / 20)) }

    /// Gain in dB for a card, 0 when normalisation is off or the track is not analysed.
    public static func gainDb(for card: TrackCard?, normalize: Bool) -> Double {
        guard normalize, let card else { return 0 }
        return gainDb(lufs: card.loudnessLufs, truePeak: card.truePeakDbfs)
    }

    /// Next track continues the same album in order (incl. disc change): keep it gapless, never crossfade.
    public static func isAlbumContinuation(_ cur: TrackCard?, _ next: TrackCard?) -> Bool {
        guard let cur, let next, !cur.albumId.isEmpty, cur.albumId == next.albumId,
              let a = cur.track, let b = next.track else { return false }
        let curDisc = cur.disc ?? 1, nextDisc = next.disc ?? 1
        return (curDisc == nextDisc && b == a + 1) || (nextDisc == curDisc + 1 && b == 1)
    }

    /// Fade length for cur → next in ms; 0 = plain gapless. Never more than a third of either track.
    public static func fadeMs(pref: Int, curDurMs: Int, nextDurMs: Int?, cur: TrackCard?, next: TrackCard?) -> Int {
        guard pref > 0, curDurMs > 0, !isAlbumContinuation(cur, next) else { return 0 }
        var f = min(pref, curDurMs / 3)
        if let n = nextDurMs, n > 0 { f = min(f, n / 3) }
        return f < minFadeMs ? 0 : f
    }

    /// Equal-power curves (constant perceived loudness through the overlap).
    public static func fadeOut(_ t: Double) -> Float { Float(cos(min(1, max(0, t)) * .pi / 2)) }
    public static func fadeIn(_ t: Double) -> Float { Float(sin(min(1, max(0, t)) * .pi / 2)) }

    // ─── Automix (WP17-44, port of Android AudioPlan) ───────────────────────

    public static let maxRatePct = 6.0
    public static let minBpmConfidence = 0.5
    public static let maxLeadInMs = 8_000

    static func usableBpm(_ t: TrackCard?) -> Double? {
        guard let b = t?.bpm, b.isFinite, b >= 40, b <= 260 else { return nil }
        if let c = t?.bpmConfidence, c < minBpmConfidence { return nil }
        return b
    }

    /// Rate for the incoming track to match the outgoing tempo (half/double folded); nil beyond ±6 % or unknown BPM.
    public static func rateFor(_ cur: TrackCard?, _ next: TrackCard?) -> Float? {
        guard let a = usableBpm(cur), var b = usableBpm(next) else { return nil }
        while b < a / 1.5 { b *= 2 }
        while b > a * 1.5 { b /= 2 }
        let rate = a / b
        return abs(rate - 1) * 100 <= maxRatePct ? Float(rate) : nil
    }

    /// Automix plan on top of `fadeMs` (0 = no crossfade); degrades to a plain crossfade without BPM data.
    public static func mixPlan(_ prefs: AudioPrefs, fadeMs: Int, cur: TrackCard?, next: TrackCard?) -> MixPlan {
        guard prefs.automix, fadeMs > 0, let rate = rateFor(cur, next), let bpm = usableBpm(cur) else {
            return MixPlan(incomingStartMs: 0, incomingRate: 1, fadeMs: fadeMs, beatMatched: false)
        }
        var lead = 0
        if let f = next?.firstBeatSec, f.isFinite, f >= 0 {
            let ms = Int(f * 1000)
            if ms <= maxLeadInMs { lead = ms }
        }
        let barMs = 4 * 60_000.0 / bpm
        let bars = (Double(fadeMs) / barMs).rounded(.down)
        return MixPlan(incomingStartMs: lead, incomingRate: rate, fadeMs: bars >= 1 ? Int(bars * barMs) : fadeMs, beatMatched: true)
    }

    /// Where the fade starts in the outgoing track: `dur - fade`, moved back to its previous downbeat when known.
    public static func fadeStartMs(curDurMs: Int, cur: TrackCard?, fadeMs: Int) -> Int {
        let plain = curDurMs - fadeMs
        guard let bpm = usableBpm(cur), let f = cur?.firstBeatSec, f.isFinite, f >= 0 else { return plain }
        let first = f * 1000
        guard Double(plain) > first else { return plain }
        let bar = 4 * 60_000.0 / bpm
        return Int(first + ((Double(plain) - first) / bar).rounded(.down) * bar)
    }

    /// Linear glide of the rate from `from` back to 1 over `glideMs`.
    public static func glideRate(from: Float, elapsedMs: Int, glideMs: Int) -> Float {
        guard glideMs > 0, elapsedMs < glideMs else { return 1 }
        let t = Float(max(0, elapsedMs)) / Float(glideMs)
        return from + (1 - from) * t
    }
}
