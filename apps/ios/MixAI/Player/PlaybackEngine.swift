import AVFoundation
import AVKit
import Foundation
import MediaPlayer

/// Seam between the player UI and the decoder. v1 = AVPlayer on the server's HLS remux (`-c copy`);
/// a VLCKit engine for containers/codecs AVPlayer refuses is a later slice (D36) and plugs in here.
@MainActor
protocol PlaybackEngine: AnyObject {
    var avPlayer: AVPlayer? { get }
    /// Seconds into the HLS stream (add `offset` for absolute media time).
    var currentTime: Double { get }
    var isPlaying: Bool { get }
    var rate: Float { get set }
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

    var currentTime: Double {
        let t = avPlayer?.currentTime().seconds ?? 0
        return t.isFinite ? t : 0
    }

    var isPlaying: Bool { (avPlayer?.timeControlStatus ?? .paused) != .paused }

    var rate: Float {
        get { desiredRate }
        set {
            desiredRate = newValue
            avPlayer?.defaultRate = newValue
            if isPlaying { avPlayer?.rate = newValue }
        }
    }

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
