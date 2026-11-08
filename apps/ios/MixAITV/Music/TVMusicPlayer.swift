import AVFoundation
import Combine
import MediaPlayer
import MixaiCore
import Observation
import UIKit

/// Built-in music player of MixAI TV on Apple TV (WP17-45, D55). AVPlayer over the shared MixaiCore `PlayQueue`;
/// formats AVFoundation cannot decode stream as server-converted MP3. Siri Remote play/pause + Control Center
/// work through MPRemoteCommandCenter; plays are reported to the server like on every other surface.
@MainActor
@Observable
final class TVMusicPlayer {
    private(set) var queue = PlayQueue()
    private(set) var playing = false
    private(set) var position: Double = 0
    private(set) var duration: Double = 0
    private(set) var buffering = false
    var current: TrackCard? { queue.current }

    @ObservationIgnored private var store: MusicStore?
    @ObservationIgnored private let player = AVPlayer()
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var endObserver: NSObjectProtocol?
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    @ObservationIgnored private var artwork: (albumId: String, image: UIImage)?
    @ObservationIgnored private var commandsInstalled = false

    init() {
        player.automaticallyWaitsToMinimizeStalling = true
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.position = t.seconds.isFinite ? t.seconds : 0
                self.buffering = self.player.timeControlStatus == .waitingToPlayAtSpecifiedRate
            }
        }
    }

    // MARK: queue

    func play(_ tracks: [TrackCard], at index: Int, store: MusicStore, shuffle: Bool = false) {
        guard !tracks.isEmpty else { return }
        self.store = store
        var q = PlayQueue(tracks: tracks, index: index, repeatMode: queue.repeatMode)
        if shuffle { q.setShuffle(true) }
        queue = q
        installCommands()
        load(autoplay: true)
    }

    func startMix(store: MusicStore) async -> Bool {
        let tracks = (try? await store.random(size: 100)) ?? []
        guard !tracks.isEmpty else { return false }
        play(tracks, at: 0, store: store)
        return true
    }

    func skip(to i: Int) {
        guard queue.tracks.indices.contains(i) else { return }
        reportPlay(completed: false)
        queue.move(to: i)
        load(autoplay: true)
    }

    func next() {
        guard let i = queue.nextIndexForSkip() else { return }
        reportPlay(completed: false)
        queue.move(to: i)
        load(autoplay: true)
    }

    func previous() {
        if position > 3 { seek(0); return }
        guard let i = queue.previousIndex() else { seek(0); return }
        queue.move(to: i)
        load(autoplay: true)
    }

    func setShuffle(_ on: Bool) { queue.setShuffle(on); updateNowPlaying() }
    func cycleRepeat() { queue.repeatMode = queue.repeatMode.next }

    // MARK: transport

    func toggle() { playing ? pause() : resume() }

    func resume() {
        guard current != nil else { return }
        player.play(); playing = true; updateNowPlaying()
    }

    func pause() { player.pause(); playing = false; updateNowPlaying() }

    func seek(_ sec: Double) {
        let s = max(0, min(sec, max(0, duration - 0.5)))
        player.seek(to: CMTime(seconds: s, preferredTimescale: 600))
        position = s
        updateNowPlaying()
    }

    func stop() {
        reportPlay(completed: false)
        player.pause(); player.replaceCurrentItem(with: nil)
        queue = PlayQueue(); playing = false; position = 0; duration = 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    // MARK: internals

    private func url(for t: TrackCard) -> URL? {
        guard let store else { return nil }
        return MusicStore.needsConversion(t) ? store.streamURL(t, format: "mp3") : store.streamURL(t)
    }

    private func load(autoplay: Bool) {
        guard let t = current, let u = url(for: t) else { stop(); return }
        let item = AVPlayerItem(url: u)
        duration = t.durationSec
        position = 0
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.trackEnded() }
        }
        statusTask?.cancel()
        statusTask = Task { [weak self] in
            for await s in item.publisher(for: \.status).values {
                guard let self else { return }
                if s == .readyToPlay {
                    let d = item.duration.seconds
                    if d.isFinite, d > 0 { self.duration = d }
                    self.updateNowPlaying()
                } else if s == .failed {
                    self.next()
                }
            }
        }
        player.replaceCurrentItem(with: item)
        if autoplay { player.play(); playing = true }
        updateNowPlaying()
        loadArtwork(t)
    }

    private func trackEnded() {
        reportPlay(completed: true)
        guard let i = queue.nextIndexAfterEnd() else { playing = false; seek(0); player.pause(); updateNowPlaying(); return }
        queue.move(to: i)
        load(autoplay: true)
    }

    private func reportPlay(completed: Bool) {
        guard let t = current, let store, position >= 30 || completed else { return }
        let listened = completed ? duration : position
        Task { await store.postPlay(t, durationSec: listened, completed: completed) }
    }

    private func loadArtwork(_ t: TrackCard) {
        guard artwork?.albumId != t.albumId, let u = store?.coverURL(t.coverUrlPath) else { return }
        Task { [weak self] in
            guard let (data, _) = try? await URLSession.shared.data(from: u), let img = UIImage(data: data) else { return }
            guard let self, self.current?.albumId == t.albumId else { return }
            self.artwork = (t.albumId, img)
            self.updateNowPlaying()
        }
    }

    private func updateNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        guard let t = current else { center.nowPlayingInfo = nil; return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: t.title,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let a = t.artist { info[MPMediaItemPropertyArtist] = a }
        if let al = t.album { info[MPMediaItemPropertyAlbumTitle] = al }
        if let art = artwork, art.albumId == t.albumId {
            let img = art.image
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { @Sendable _ in img }
        }
        center.nowPlayingInfo = info
    }

    private func installCommands() {
        guard !commandsInstalled else { return }
        commandsInstalled = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.resume() }; return .success }
        c.pauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.pause() }; return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.toggle() }; return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.next() }; return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.previous() }; return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            MainActor.assumeIsolated { self?.seek(e.positionTime) }
            return .success
        }
    }
}
