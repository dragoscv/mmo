import Foundation

/// Playback audio preferences (port of Android `AudioPrefs`, WP17-41e). Defaults = off.
public struct AudioPrefs: Sendable, Equatable, Codable {
    /// Crossfade length between tracks in ms (0 = plain gapless transitions).
    public var crossfadeMs: Int
    /// Loudness normalisation from the server's EBU R128 measurement (`TrackCard.loudnessLufs` / `truePeakDbfs`).
    public var normalize: Bool

    public init(crossfadeMs: Int = 0, normalize: Bool = false) {
        self.crossfadeMs = crossfadeMs
        self.normalize = normalize
    }

    /// Settings choices for the crossfade picker (seconds).
    public static let crossfadeChoices = [0, 3, 6, 9, 12]
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
}
