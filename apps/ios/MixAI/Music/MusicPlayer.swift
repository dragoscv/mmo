import AVFoundation
import MediaPlayer
import MixaiCore
import Observation
import UIKit

/// Background music queue on AVQueuePlayer (AVAudioSession .playback; Now Playing + remote commands).
@MainActor
@Observable
final class MusicPlayer {
    var queue: [TrackCard] = []
    var index = 0
    var playing = false
    var position: Double = 0
    var lyrics: Lyrics?
    var showNowPlaying = false

    private let player = AVPlayer()
    private var store: MusicStore?
    private var observer: Any?
    private var endObserver: NSObjectProtocol?

    var current: TrackCard? { queue.indices.contains(index) ? queue[index] : nil }

    func play(_ tracks: [TrackCard], at i: Int, store: MusicStore, video: PlayerCoordinator) {
        guard !tracks.isEmpty else { return }
        video.stop()
        self.store = store
        queue = tracks
        index = max(0, min(i, tracks.count - 1))
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, policy: .longFormAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        loadCurrent()
    }

    private func loadCurrent() {
        guard let t = current, let store, let url = store.streamURL(t) else { return }
        player.replaceCurrentItem(with: AVPlayerItem(url: url))
        player.play()
        playing = true
        lyrics = nil
        if observer == nil {
            observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.position = time.seconds.isFinite ? time.seconds : 0
                    if Int(self.position * 4) % 8 == 0 { self.updateNowPlaying() }
                }
            }
        }
        endObserver.map(NotificationCenter.default.removeObserver)
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: player.currentItem, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let t = self.current else { return }
                Task { await self.store?.postPlay(t, durationSec: t.durationSec, completed: true) }
                self.next()
            }
        }
        let id = t.id
        Task {
            let l = try? await store.lyrics(id)
            if self.current?.id == id { self.lyrics = l ?? nil }
        }
        updateNowPlaying()
    }

    func toggle() { playing ? pause() : play() }
    func play() { guard current != nil else { return }; player.play(); playing = true; updateNowPlaying() }
    func pause() { player.pause(); playing = false; updateNowPlaying() }
    func seek(_ s: Double) { player.seek(to: CMTime(seconds: s, preferredTimescale: 600)); position = s }

    func next() {
        guard index + 1 < queue.count else { pause(); return }
        index += 1
        loadCurrent()
    }

    func previous() {
        if position > 4 || index == 0 { seek(0); return }
        index -= 1
        loadCurrent()
    }

    func stop() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        queue = []
        playing = false
    }

    var activeLyric: Int? {
        guard let synced = lyrics?.synced, !synced.isEmpty else { return nil }
        return activeLyricIndex(synced, ms: Int(position * 1000))
    }

    private func updateNowPlaying() {
        guard let t = current else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: t.title,
            MPMediaItemPropertyPlaybackDuration: t.durationSec,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let a = t.artist { info[MPMediaItemPropertyArtist] = a }
        if let a = t.album { info[MPMediaItemPropertyAlbumTitle] = a }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
