import AVFoundation
import AVKit
import Foundation
import MediaPlayer
import UIKit

/// Seam between the player UI and the decoder. v1 = AVPlayer on the server's HLS remux (`-c copy`);
/// `VLCEngine` (D36) takes over for containers/codecs AVFoundation refuses. PiP / AirPlay stay AVPlayer-only
/// (`avPlayer == nil` for every other engine).
@MainActor
protocol PlaybackEngine: AnyObject {
    /// Short engine label for the OSD badge ("AVPlayer", "VLC").
    var engineName: String { get }
    /// Non-nil only for the AVPlayer engine (PiP, AirPlay, night-mode audio tap).
    var avPlayer: AVPlayer? { get }
    /// Seconds into the loaded stream (add the coordinator `offset` for absolute media time; VLC/offline = absolute).
    var currentTime: Double { get }
    /// Stream duration in seconds when known.
    var durationSec: Double? { get }
    var isPlaying: Bool { get }
    var isBuffering: Bool { get }
    var rate: Float { get set }
    /// 0...1 linear output volume (sleep-timer fade).
    var volume: Float { get set }
    var lastError: Error? { get }
    /// Engines that render into a plain UIView (VLC) bind here; AVPlayer renders through `VideoSurface`'s layer.
    func attach(to view: UIView)
    func load(url: URL, headers: [String: String])
    func play()
    func pause()
    func seek(to streamSeconds: Double)
    func stop()
}

@MainActor
final class AVPlayerEngine: PlaybackEngine {
    private(set) var avPlayer: AVPlayer?
    private var desiredRate: Float = 1
    private var desiredVolume: Float = 1

    var engineName: String { "AVPlayer" }

    var currentTime: Double {
        let t = avPlayer?.currentTime().seconds ?? 0
        return t.isFinite ? t : 0
    }

    var durationSec: Double? {
        guard let d = avPlayer?.currentItem?.duration.seconds, d.isFinite, d > 0 else { return nil }
        return d
    }

    var isPlaying: Bool { (avPlayer?.timeControlStatus ?? .paused) != .paused }

    var isBuffering: Bool { avPlayer?.timeControlStatus == .waitingToPlayAtSpecifiedRate }

    var lastError: Error? { avPlayer?.currentItem?.error }

    var rate: Float {
        get { desiredRate }
        set {
            desiredRate = newValue
            avPlayer?.defaultRate = newValue
            if isPlaying { avPlayer?.rate = newValue }
        }
    }

    var volume: Float {
        get { desiredVolume }
        set {
            desiredVolume = max(0, min(1, newValue))
            avPlayer?.volume = desiredVolume
        }
    }

    func attach(to view: UIView) {}

    func load(url: URL, headers: [String: String]) {
        let asset = headers.isEmpty ? AVURLAsset(url: url) : AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
        let item = AVPlayerItem(asset: asset)
        item.preferredForwardBufferDuration = 20
        if let p = avPlayer { p.replaceCurrentItem(with: item) } else {
            let p = AVPlayer(playerItem: item)
            p.allowsExternalPlayback = true
            p.usesExternalPlaybackWhileExternalScreenIsActive = true
            avPlayer = p
        }
        avPlayer?.defaultRate = desiredRate
        avPlayer?.volume = desiredVolume
    }

    func play() { avPlayer?.playImmediately(atRate: desiredRate) }
    func pause() { avPlayer?.pause() }

    func seek(to streamSeconds: Double) {
        avPlayer?.seek(to: CMTime(seconds: max(0, streamSeconds), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: CMTime(seconds: 0.5, preferredTimescale: 600))
    }

    func stop() {
        avPlayer?.pause()
        avPlayer?.replaceCurrentItem(with: nil)
    }
}
