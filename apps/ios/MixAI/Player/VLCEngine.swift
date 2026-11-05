import Foundation
import UIKit

#if canImport(VLCKit)
import AVFoundation
import VLCKit

/// libVLC engine (D36) for files AVFoundation refuses (MKV with exotic codecs, DTS, VobSub-era AVI, …).
/// Plays the ORIGINAL file (`/video/direct/{id}?t=`): VLC cannot send custom headers, so it is only used for
/// `.file` sources where the device token rides in the query. Times are absolute (no server `?start=` offset).
@MainActor
final class VLCEngine: NSObject, PlaybackEngine {
    private let player = VLCMediaPlayer()
    private var desiredRate: Float = 1
    private var desiredVolume: Float = 1
    private var hasDrawable = false
    private var wantsPlay = false
    private var started = false
    /// Seek requested before the first `play()` → applied as `:start-time=` on the media (VLC ignores early seeks).
    private var pendingStartSec: Double?

    override init() {
        super.init()
    }

    var engineName: String { "VLC" }
    var avPlayer: AVPlayer? { nil }

    var currentTime: Double {
        let ms = Double(player.time.intValue)
        return ms.isFinite && ms > 0 ? ms / 1000 : 0
    }

    var durationSec: Double? {
        guard let media = player.media as VLCMedia? else { return nil }
        let ms = Double(media.length.intValue)
        return ms > 0 ? ms / 1000 : nil
    }

    var isPlaying: Bool { player.isPlaying }

    var isBuffering: Bool { player.state == .opening }

    /// libVLC reports failures through its state machine; the coordinator only needs "playback is impossible".
    var lastError: Error? {
        player.state == .error ? NSError(domain: "VLCKitErrorDomain", code: -1) : nil
    }

    var rate: Float {
        get { desiredRate }
        set {
            desiredRate = newValue
            player.rate = newValue
        }
    }

    /// 0...1 mapped to libVLC's 0...100 (100 = unity gain; 200 = +6 dB boost, never used here).
    var volume: Float {
        get { desiredVolume }
        set {
            desiredVolume = max(0, min(1, newValue))
            applyVolume()
        }
    }

    func attach(to view: UIView) {
        player.drawable = view
        hasDrawable = true
        if wantsPlay { startPlayback() }
    }

    func load(url: URL, headers: [String: String]) {
        // `headers` cannot be honoured by libVLC; callers pass token-in-query URLs only.
        player.media = VLCMedia(url: url)
        started = false
        pendingStartSec = nil
    }

    func play() {
        wantsPlay = true
        // libVLC needs a drawable before the vout starts, otherwise it opens its own window (or renders nowhere).
        guard hasDrawable else { return }
        startPlayback()
    }

    private func startPlayback() {
        wantsPlay = false
        if !started, let s = pendingStartSec, s > 0, let media = player.media as VLCMedia? {
            media.addOption(":start-time=\(String(format: "%.3f", s))")
        }
        pendingStartSec = nil
        started = true
        player.play()
        player.rate = desiredRate
        applyVolume()
    }

    func pause() {
        wantsPlay = false
        player.pause()
    }

    func seek(to streamSeconds: Double) {
        let s = max(0, streamSeconds)
        guard started else {
            pendingStartSec = s
            return
        }
        player.time = VLCTime(int: Int32(clamping: Int((s * 1000).rounded())))
    }

    func stop() {
        wantsPlay = false
        started = false
        player.stop()
        player.media = nil
        player.drawable = nil
        hasDrawable = false
    }

    private func applyVolume() {
        guard let audio = player.audio as VLCAudio? else { return }
        audio.volume = Int32(Int((desiredVolume * 100).rounded()))
    }
}

enum VLCAvailability {
    static let available = true
    @MainActor static func makeEngine() -> (any PlaybackEngine)? { VLCEngine() }
}

#else

enum VLCAvailability {
    static let available = false
    @MainActor static func makeEngine() -> (any PlaybackEngine)? { nil }
}

#endif
