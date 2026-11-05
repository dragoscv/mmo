import AVFoundation
import AVKit
import Foundation
import MediaPlayer
import MixaiCore
import Observation
import UIKit

/// What to play (passed from Title / Home / Live to the player).
struct PlayRequest: Identifiable, Hashable {
    enum Source: Hashable {
        case file(fileId: String, ref: MediaRef?, startSec: Double)
        case live(channelId: String, name: String)
    }
    let id = UUID()
    let source: Source
    let title: String
    let subtitle: String?
    let artwork: URL?
}

/// Owns the active playback session: engine, HLS offset math, audio/subtitle tracks, markers, sleep timer,
/// Now Playing info, progress writes. One per app (the full-screen player is a view over it).
@MainActor
@Observable
final class PlayerCoordinator {
    var request: PlayRequest?
    var presented = false
    var playing = false
    /// Absolute media seconds (stream time + server `?start=` offset).
    var position: Double = 0
    var duration: Double = 0
    var buffering = true
    var error: String?
    var audioTracks: [AudioTrack] = []
    var subtitleTracks: [(ordinal: Int, track: SubtitleTrack)] = []
    var audioOrdinal = 0
    var subtitleOrdinal: Int?
    var cues: [SubtitleCue] = []
    var intro: ClosedRange<Double>?
    var creditsAt: Double?
    var speed: Float = 1
    var sleepAt: Date?
    var sleepEndOfItem = false

    let engine: PlaybackEngine = AVPlayerEngine()
    private var offset: Double = 0
    private var client: MmoClient?
    private var progress: ProgressSync?
    private var ref: MediaRef?
    private var fileId: String?
    private var timeObserver: Any?
    private var tick = 0
    private var endObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?

    var avPlayer: AVPlayer? { engine.avPlayer }

    func start(_ req: PlayRequest, app: AppModel) {
        guard let client = app.client else { return }
        stop()
        self.client = client
        self.progress = app.progress
        request = req
        presented = true
        error = nil
        buffering = true
        position = 0
        duration = 0
        cues = []
        intro = nil
        creditsAt = nil
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, policy: .longFormVideo)
        try? AVAudioSession.sharedInstance().setActive(true)
        app.music.pause()
        switch req.source {
        case .file(let fid, let r, let startSec):
            fileId = fid
            ref = r
            audioOrdinal = 0
            subtitleOrdinal = nil
            loadFile(fid, startSec: startSec)
            Task { await loadFileMeta(fid, profile: app.profileId) }
        case .live(let channelId, _):
            fileId = nil
            ref = nil
            Task { await loadLive(channelId, app: app) }
        }
        observe()
        updateNowPlaying()
    }

    private func loadFile(_ fid: String, startSec: Double) {
        guard let client else { return }
        offset = max(0, startSec.rounded(.down))
        guard let url = URL(string: client.hlsURL(fileId: fid, startSec: Int(offset), audio: audioOrdinal)) else { return }
        engine.load(url: url, headers: [:])
        engine.rate = speed
        engine.play()
    }

    private func loadLive(_ channelId: String, app: AppModel) async {
        guard let live = app.liveTv else { return }
        do {
            let s = try await live.resolve(channelId)
            guard let url = URL(string: s.url) else { return }
            offset = 0
            engine.load(url: url, headers: s.proxied ? live.client.authHeaders : [:])
            engine.play()
        } catch {
            self.error = String(localized: "player.error.live")
        }
    }

    private func loadFileMeta(_ fid: String, profile: String) async {
        guard let client else { return }
        let store = MediaStore(client: client, profile: profile)
        if let info = try? await store.fileInfo(fileId: fid) {
            audioTracks = info.audioTracks
            subtitleTracks = info.subtitleTracks.enumerated().filter { !bitmapSubtitleCodecs.contains($0.element.codec.lowercased()) }.map { ($0.offset, $0.element) }
            if let d = info.durationSec, d > 0 { duration = d }
        }
        intro = await store.marker("intro", fileId: fid)
        creditsAt = await store.creditsStart(fileId: fid)
    }

    private func observe() {
        guard let p = engine.avPlayer else { return }
        if let o = timeObserver { p.removeTimeObserver(o) }
        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onTick() }
        }
        // A failed item (server 500, unsupported stream) never moves the clock, so the periodic observer stays silent.
        statusObservation = p.currentItem?.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            let msg = item.error?.localizedDescription ?? String(localized: "player.error.title")
            Task { @MainActor in
                self?.error = msg
                self?.buffering = false
            }
        }
        endObserver.map(NotificationCenter.default.removeObserver)
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onEnded() }
        }
    }

    private func onTick() {
        let p = engine
        position = offset + p.currentTime
        playing = p.isPlaying
        buffering = p.avPlayer?.timeControlStatus == .waitingToPlayAtSpecifiedRate
        if duration <= 0, let d = p.avPlayer?.currentItem?.duration.seconds, d.isFinite, d > 0 { duration = offset + d }
        if let failed = p.avPlayer?.currentItem?.error { error = failed.localizedDescription }
        if let at = sleepAt, Date() >= at { pause(); sleepAt = nil }
        tick += 1
        if tick % 20 == 0 { saveProgress() }
        if tick % 4 == 0 { updateNowPlaying() }
    }

    private func onEnded() {
        if let ref, duration > 0 { Task { await progress?.markWatched(ref, durationSec: duration) } }
        if sleepEndOfItem { sleepEndOfItem = false }
        playing = false
    }

    // MARK: controls

    func togglePlay() { engine.isPlaying ? pause() : play() }
    func play() { engine.play(); playing = true; updateNowPlaying() }
    func pause() { engine.pause(); playing = false; saveProgress(); updateNowPlaying() }

    /// Seek in ABSOLUTE seconds. Before the server offset → restart the stream at the new point.
    func seek(to absolute: Double) {
        let target = max(0, duration > 0 ? min(absolute, duration - 1) : absolute)
        if target < offset, let fid = fileId {
            loadFile(fid, startSec: target)
            observe()
        } else {
            engine.seek(to: target - offset)
        }
        position = target
    }

    func skip(_ delta: Double) { seek(to: position + delta) }

    func setSpeed(_ s: Float) { speed = s; engine.rate = s }

    /// Switching audio = new server session for `audio=<n>` at the current position.
    func selectAudio(_ ordinal: Int) {
        guard ordinal != audioOrdinal, let fid = fileId else { return }
        audioOrdinal = ordinal
        loadFile(fid, startSec: position)
        observe()
    }

    func selectSubtitle(_ ordinal: Int?) {
        subtitleOrdinal = ordinal
        cues = []
        guard let ordinal, let fid = fileId, let client, let url = URL(string: client.subtitleURL(fileId: fid, ordinal: ordinal)) else { return }
        Task {
            if let (data, _) = try? await URLSession.shared.data(from: url) {
                cues = WebVTT.parse(String(decoding: data, as: UTF8.self))
            }
        }
    }

    var activeCue: String? { subtitleOrdinal == nil ? nil : WebVTT.active(cues, at: position) }

    var showSkipIntro: Bool { intro.map { $0.contains(position) && $0.upperBound - position > 2 } ?? false }

    func skipIntro() { if let i = intro { seek(to: i.upperBound) } }

    func setSleep(minutes: Int?) {
        sleepEndOfItem = false
        sleepAt = minutes.map { Date().addingTimeInterval(TimeInterval($0 * 60)) }
    }

    func dismiss() {
        saveProgress()
        presented = false
        stop()
    }

    func stop() {
        if let o = timeObserver { engine.avPlayer?.removeTimeObserver(o) }
        timeObserver = nil
        endObserver.map(NotificationCenter.default.removeObserver)
        endObserver = nil
        statusObservation = nil
        engine.stop()
        playing = false
        request = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func saveProgress() {
        guard let ref, duration > 0, position > 5 else { return }
        let pos = position, dur = duration
        Task { await progress?.save(ref, positionSec: pos, durationSec: dur, completed: pos / dur > 0.93 ? true : nil) }
    }

    private func updateNowPlaying() {
        guard let req = request else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: req.title,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? Double(speed) : 0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
        ]
        if let s = req.subtitle { info[MPMediaItemPropertyArtist] = s }
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        if case .live = req.source { info[MPNowPlayingInfoPropertyIsLiveStream] = true }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
