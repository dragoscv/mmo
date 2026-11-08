import AVFoundation
@preconcurrency import AudioStreaming
import MediaPlayer
import MixaiCore
import Observation
import UIKit

/// Another device that can take over the queue (MixAI TV / MixAI Music on the hub, D53).
public struct RemoteOutput: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let platform: String
    public init(id: String, name: String, platform: String) {
        self.id = id
        self.name = name
        self.platform = platform
    }
}

/// Music playback on AVAudioEngine (two `MusicDeck`s): gapless album continuations, equal-power crossfade
/// (off/3/6/9/12 s), EBU R128 loudness normalisation with a peak limiter, sleep timer, Now Playing + remote commands,
/// lyrics, queue edits and server queue sync. Same decisions as Android (`AudioPlan`, `PlayQueue` in MixaiCore).
@MainActor
@Observable
public final class MusicPlayer {
    // MARK: observable state

    public private(set) var queue = PlayQueue()
    public private(set) var playing = false
    public private(set) var buffering = false
    public private(set) var position: Double = 0
    public private(set) var duration: Double = 0
    public private(set) var lyrics: Lyrics?
    public var showNowPlaying = false
    public private(set) var sleep: SleepTimer = .off
    public private(set) var lastError: String?
    /// Hub devices that take a music queue; set by the app from its hub connection.
    public var remoteOutputs: [RemoteOutput] = []

    public var prefs: AudioPrefs {
        didSet { Self.savePrefs(prefs); if prefs.crossfadeMs != oldValue.crossfadeMs { planNext() } ; applyGain() }
    }
    /// Lock Screen animated artwork (generated Ken Burns loop of the cover, iOS 26).
    public var animatedArtwork: Bool = UserDefaults.standard.object(forKey: "music.animatedArtwork") as? Bool ?? true {
        didSet { UserDefaults.standard.set(animatedArtwork, forKey: "music.animatedArtwork"); updateNowPlaying(force: true) }
    }

    public var current: TrackCard? { queue.current }
    public var tracks: [TrackCard] { queue.tracks }

    // MARK: wiring (set by the host app)

    public private(set) var store: MusicStore?
    /// Local file for a downloaded track (offline playback), nil = stream.
    @ObservationIgnored public var localURL: ((String) -> URL?)?
    /// Hands the queue to another device; returns true when the device acknowledged.
    @ObservationIgnored public var onHandoff: ((RemoteOutput, MusicQueueInput) async -> Bool)?
    /// Called on every track change / play state change (widgets, hub state, upcoming downloads).
    @ObservationIgnored public var onChange: (() -> Void)?
    /// Called before music starts (the MixAI app stops its video player here).
    @ObservationIgnored public var willStart: (() -> Void)?

    // MARK: engine

    @ObservationIgnored private let deckA = MusicDeck(name: "A")
    @ObservationIgnored private let deckB = MusicDeck(name: "B")
    @ObservationIgnored private var active: MusicDeck
    @ObservationIgnored private var fading: MusicDeck?
    @ObservationIgnored private var fadeStart: Date?
    @ObservationIgnored private var fadeLength: Double = 0
    /// Next track id pre-queued gapless on the active deck.
    @ObservationIgnored private var gaplessNextId: String?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var syncTask: Task<Void, Never>?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var convertRetried: Set<String> = []
    @ObservationIgnored private var nowPlayingSig = ""
    @ObservationIgnored private var playReported: String?

    public init() {
        prefs = Self.loadPrefs()
        active = deckA
        for d in [deckA, deckB] { d.onEvent = { [weak self, weak d] e in if let self, let d { self.handle(e, from: d) } } }
        observeSession()
    }

    // MARK: public API

    /// Replace the queue and start playing at `index`.
    public func play(_ list: [TrackCard], at index: Int, store: MusicStore, shuffle: Bool = false) {
        guard !list.isEmpty else { return }
        willStart?()
        self.store = store
        var q = PlayQueue(tracks: list, index: index, repeatMode: queue.repeatMode)
        if shuffle { q.setShuffle(true) }
        queue = q
        activateSession()
        load(startAt: 0, autoplay: true)
        scheduleSync()
    }

    /// Adopt a queue without playing (restore after launch / from the server), paused at `positionSec`.
    public func restore(_ list: [TrackCard], index: Int, positionSec: Double, repeatMode: RepeatMode, store: MusicStore) {
        guard !list.isEmpty, queue.isEmpty else { return }
        self.store = store
        queue = PlayQueue(tracks: list, index: index, repeatMode: repeatMode)
        position = positionSec
        duration = current?.durationSec ?? 0
        pendingResumeAt = positionSec
        updateNowPlaying(force: true)
        onChange?()
    }

    @ObservationIgnored private var pendingResumeAt: Double?

    public func setStore(_ s: MusicStore?) { store = s }

    public func toggle() { playing ? pause() : play() }

    public func play() {
        guard current != nil else { return }
        willStart?()
        activateSession()
        if let at = pendingResumeAt ?? (active.isIdle ? position : nil) {
            pendingResumeAt = nil
            load(startAt: at, autoplay: true)
            return
        }
        active.resume()
        playing = true
        startTicker()
        updateNowPlaying(force: true)
        onChange?()
    }

    public func pause() {
        cancelFade(keepIncoming: true)
        active.pause()
        playing = false
        updateNowPlaying(force: true)
        scheduleSync()
        onChange?()
    }

    public func seek(_ s: Double) {
        cancelFade(keepIncoming: true)
        let t = max(0, min(s, max(0, duration - 0.5)))
        if pendingResumeAt != nil { pendingResumeAt = t; position = t; return }
        active.seek(t)
        position = t
        updateNowPlaying(force: true)
    }

    public func next() {
        guard let i = queue.nextIndexForSkip() else { stopAtEnd(); return }
        cancelFade(keepIncoming: false)
        queue.move(to: i)
        load(startAt: 0, autoplay: true)
        scheduleSync()
    }

    public func previous() {
        if position > 4 { seek(0); return }
        guard let i = queue.previousIndex() else { seek(0); return }
        cancelFade(keepIncoming: false)
        queue.move(to: i)
        load(startAt: 0, autoplay: true)
        scheduleSync()
    }

    public func jump(to i: Int) {
        guard queue.tracks.indices.contains(i) else { return }
        cancelFade(keepIncoming: false)
        queue.move(to: i)
        load(startAt: 0, autoplay: true)
        scheduleSync()
    }

    public func stop() {
        cancelFade(keepIncoming: false)
        deckA.stop(); deckB.stop()
        ticker?.cancel(); ticker = nil
        queue = PlayQueue()
        playing = false
        position = 0
        duration = 0
        lyrics = nil
        sleep = .off
        pendingResumeAt = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        onChange?()
    }

    // MARK: queue edits

    public func playNext(_ t: [TrackCard]) {
        let wasEmpty = queue.isEmpty
        queue.playNext(t)
        if wasEmpty, let s = store { play(queue.tracks, at: 0, store: s) } else { planNext(); scheduleSync() }
    }

    public func addToQueue(_ t: [TrackCard]) {
        let wasEmpty = queue.isEmpty
        queue.append(t)
        if wasEmpty, let s = store { play(queue.tracks, at: 0, store: s) } else { planNext(); scheduleSync() }
    }

    public func removeFromQueue(at offsets: IndexSet) {
        if queue.remove(at: offsets) {
            if queue.isEmpty { stop(); return }
            load(startAt: 0, autoplay: playing)
        } else {
            planNext()
        }
        scheduleSync()
    }

    public func moveInQueue(from: IndexSet, to: Int) {
        queue.move(fromOffsets: from, toOffset: to)
        planNext()
        scheduleSync()
    }

    public func clearUpcoming() {
        queue.clearUpcoming()
        planNext()
        scheduleSync()
    }

    public var shuffled: Bool { queue.shuffled }

    public func setShuffle(_ on: Bool) {
        queue.setShuffle(on)
        planNext()
        scheduleSync()
    }

    public var repeatMode: RepeatMode { queue.repeatMode }

    public func cycleRepeat() {
        queue.repeatMode = queue.repeatMode.next
        planNext()
        scheduleSync()
    }

    /// "Start a mix": radio from a seed (`tr_`/`al_`/`ar_`), or random tracks without one.
    public func startMix(seed: String? = nil, store: MusicStore) async {
        do {
            let list: [TrackCard]
            if let seed { list = try await store.radio(seed: seed, size: 60) } else { list = try await store.random(size: 60) }
            guard !list.isEmpty else { lastError = String(localized: "music.mix_empty"); return }
            play(list, at: 0, store: store)
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: sleep timer

    public func setSleep(minutes: Int?) {
        if let m = minutes { sleep = .start(minutes: m) } else { sleep = .off }
        if sleep == .off { active.volume = 1 }
        planNext()
    }

    public func setSleepEndOfTrack() {
        sleep = .endOfTrack
        planNext()
    }

    // MARK: handoff

    public func handoff(to output: RemoteOutput) async -> Bool {
        guard let onHandoff, !queue.isEmpty else { return false }
        let ok = await onHandoff(output, queue.input(positionSec: position))
        if ok { pause() }
        return ok
    }

    // MARK: lyrics

    public var activeLyric: Int? {
        guard let synced = lyrics?.synced, !synced.isEmpty else { return nil }
        return activeLyricIndex(synced, ms: Int(position * 1000))
    }

    // MARK: loading

    private func url(for t: TrackCard) -> URL? {
        if let local = localURL?(t.id) { return local }
        guard let store else { return nil }
        if MusicStore.needsConversion(t) || convertRetried.contains(t.id) { return store.streamURL(t, format: "mp3") }
        return store.streamURL(t)
    }

    private func load(startAt: Double, autoplay: Bool) {
        guard let t = current, let u = url(for: t) else { return }
        pendingResumeAt = nil
        gaplessNextId = nil
        active.stop()
        active.volume = sleep.fadeFactor()
        active.gainDb = AudioPlan.gainDb(for: t, normalize: prefs.normalize)
        active.play(u, trackId: t.id)
        if startAt > 1 { active.seek(startAt) }
        if !autoplay { active.pause() }
        playing = autoplay
        buffering = true
        position = startAt
        duration = t.durationSec
        lyrics = nil
        playReported = nil
        lastError = nil
        startTicker()
        fetchLyrics(t.id)
        updateNowPlaying(force: true)
        planNext()
        onChange?()
    }

    private func fetchLyrics(_ id: String) {
        guard let store else { return }
        Task {
            let l = try? await store.lyrics(id)
            if self.current?.id == id { self.lyrics = l ?? nil }
        }
    }

    /// Decide how the next track starts: gapless (queued on the active deck) or crossfade (timer-driven).
    private func planNext() {
        active.clearQueued()
        gaplessNextId = nil
        guard sleep != .endOfTrack, let cur = current, let ni = queue.nextIndexAfterEnd(), ni != queue.index else { return }
        let next = queue.tracks[ni]
        if fadeMs(cur, next) == 0, let u = url(for: next) {
            active.queue(u, trackId: next.id)
            gaplessNextId = next.id
        }
    }

    private func fadeMs(_ cur: TrackCard, _ next: TrackCard) -> Int {
        AudioPlan.fadeMs(pref: prefs.crossfadeMs, curDurMs: Int(cur.durationSec * 1000), nextDurMs: Int(next.durationSec * 1000), cur: cur, next: next)
    }

    private func applyGain() {
        active.gainDb = AudioPlan.gainDb(for: current, normalize: prefs.normalize)
    }

    // MARK: deck events

    private func handle(_ e: MusicDeck.Event, from deck: MusicDeck) {
        switch e {
        case .started(let id):
            guard deck === active else { return }
            buffering = false
            if id != current?.id, id == gaplessNextId, let i = queue.tracks.firstIndex(where: { $0.id == id }) {
                // Gapless transition happened on the engine: follow it.
                reportPlay(completed: true)
                queue.move(to: i)
                position = 0
                duration = queue.tracks[i].durationSec
                lyrics = nil
                playReported = nil
                applyGain()
                fetchLyrics(id)
                updateNowPlaying(force: true)
                planNext()
                scheduleSync()
                onChange?()
            }
        case .finished(let id, let eof):
            if deck === fading { deck.stop(); fading = nil; return }
            guard deck === active, eof, id == current?.id else { return }
            if gaplessNextId != nil { return } // the engine continues with the queued entry
            reportPlay(completed: true)
            if sleep == .endOfTrack { sleep = .off; playing = false; position = 0; updateNowPlaying(force: true); onChange?(); return }
            if let i = queue.nextIndexAfterEnd() {
                queue.move(to: i)
                load(startAt: 0, autoplay: true)
                scheduleSync()
            } else {
                stopAtEnd()
            }
        case .failed(let err):
            guard deck === active, let t = current else { return }
            if !convertRetried.contains(t.id), store != nil, localURL?(t.id) == nil {
                // Decoder refused the original (rare containers): retry once as server-converted MP3 (3.12 format=).
                convertRetried.insert(t.id)
                load(startAt: position, autoplay: playing)
                return
            }
            lastError = err.localizedDescription
            buffering = false
            if queue.nextIndexForSkip() != nil { next() } else { playing = false; onChange?() }
        }
    }

    private func stopAtEnd() {
        active.stop()
        playing = false
        position = 0
        updateNowPlaying(force: true)
        scheduleSync()
        onChange?()
    }

    private func reportPlay(completed: Bool) {
        guard let t = current, let store, playReported != t.id else { return }
        playReported = t.id
        let dur = completed ? t.durationSec : position
        Task { await store.postPlay(t, durationSec: dur, completed: completed) }
    }

    // MARK: ticker (position, crossfade, sleep)

    private func startTicker() {
        guard ticker == nil else { return }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard let self else { return }
                self.tick()
            }
        }
    }

    private var lastNowPlayingTick = Date.distantPast

    private func tick() {
        if fading != nil { stepFade() }
        guard playing else { return }
        let p = active.progress
        if p > 0 || !active.isPlaying { position = p }
        let d = active.duration
        if d > 1 { duration = d }
        buffering = !active.isPlaying && playing
        if sleep.isActive {
            if sleep.expired() {
                sleep = .off
                pause()
                active.volume = 1
                return
            }
            if fading == nil { active.volume = sleep.fadeFactor() }
        }
        maybeStartCrossfade()
        if Date().timeIntervalSince(lastNowPlayingTick) > 5 {
            lastNowPlayingTick = .now
            updateNowPlaying(force: false)
        }
    }

    private func maybeStartCrossfade() {
        guard fading == nil, gaplessNextId == nil, sleep != .endOfTrack, let cur = current,
              let ni = queue.nextIndexAfterEnd(), ni != queue.index else { return }
        let next = queue.tracks[ni]
        let f = fadeMs(cur, next)
        guard f > 0, duration > 0, position >= duration - Double(f) / 1000, let u = url(for: next) else { return }
        reportPlay(completed: true)
        let incoming = active === deckA ? deckB : deckA
        incoming.stop()
        incoming.volume = 0
        incoming.gainDb = AudioPlan.gainDb(for: next, normalize: prefs.normalize)
        incoming.play(u, trackId: next.id)
        fading = active
        active = incoming
        fadeStart = .now
        fadeLength = Double(f) / 1000
        queue.move(to: ni)
        position = 0
        duration = next.durationSec
        lyrics = nil
        playReported = nil
        fetchLyrics(next.id)
        updateNowPlaying(force: true)
        planNext()
        scheduleSync()
        onChange?()
    }

    private func stepFade() {
        guard let out = fading, let start = fadeStart else { return }
        let t = Date().timeIntervalSince(start) / max(0.1, fadeLength)
        let sleepF = sleep.fadeFactor()
        out.volume = AudioPlan.fadeOut(t) * sleepF
        active.volume = AudioPlan.fadeIn(t) * sleepF
        if t >= 1 {
            out.stop()
            fading = nil
            fadeStart = nil
            active.volume = sleepF
        }
    }

    /// Pause / seek / skip during a fade: drop the outgoing deck at once.
    private func cancelFade(keepIncoming: Bool) {
        guard let out = fading else { return }
        out.stop()
        fading = nil
        fadeStart = nil
        if keepIncoming { active.volume = sleep.fadeFactor() }
    }

    // MARK: server queue sync (debounced)

    private func scheduleSync() {
        syncTask?.cancel()
        guard let store else { return }
        let body = queue.input(positionSec: position)
        syncTask = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            _ = try? await store.putQueue(body)
        }
    }

    // MARK: audio session

    private func activateSession() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .default, policy: .longFormAudio)
        try? s.setActive(true)
    }

    private func observeSession() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let type = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            let opts = (n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init(rawValue:))
            MainActor.assumeIsolated {
                guard let self else { return }
                if type == .began, self.playing { self.pause(); self.resumeAfterInterruption = true }
                if type == .ended, self.resumeAfterInterruption, opts?.contains(.shouldResume) == true { self.play() }
                if type == .ended { self.resumeAfterInterruption = false }
            }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] n in
            let reason = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            MainActor.assumeIsolated {
                // Headphones unplugged / Bluetooth gone: pause like every music app.
                if reason == .oldDeviceUnavailable, self?.playing == true { self?.pause() }
            }
        })
    }

    @ObservationIgnored private var resumeAfterInterruption = false

    // MARK: Now Playing + remote commands

    /// Lock screen / Control Center / headphones / CarPlay. The MixAI app routes these itself (video first).
    public func installRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.play() }; return .success }
        c.pauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.pause() }; return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.toggle() }; return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.next() }; return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.previous() }; return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            MainActor.assumeIsolated { self?.seek(e.positionTime) }
            return .success
        }
        c.changeShuffleModeCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangeShuffleModeCommandEvent else { return .commandFailed }
            MainActor.assumeIsolated { self?.setShuffle(e.shuffleType != .off) }
            return .success
        }
        c.changeRepeatModeCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangeRepeatModeCommandEvent else { return .commandFailed }
            MainActor.assumeIsolated {
                guard let self else { return }
                let want: RepeatMode = e.repeatType == .one ? .one : e.repeatType == .all ? .all : .off
                while self.queue.repeatMode != want { self.queue.repeatMode = self.queue.repeatMode.next }
                self.planNext()
            }
            return .success
        }
        c.skipForwardCommand.isEnabled = false
        c.skipBackwardCommand.isEnabled = false
    }

    @ObservationIgnored private var artworkCache: (albumId: String, image: UIImage)?
    @ObservationIgnored private var artworkTask: Task<Void, Never>?

    private func updateNowPlaying(force: Bool) {
        let center = MPNowPlayingInfoCenter.default()
        guard let t = current else { center.nowPlayingInfo = nil; return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: t.title,
            MPMediaItemPropertyPlaybackDuration: duration > 0 ? duration : t.durationSec,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: queue.index,
            MPNowPlayingInfoPropertyPlaybackQueueCount: queue.tracks.count,
            MPMediaItemPropertyPersistentID: NSNumber(value: UInt64(truncatingIfNeeded: t.id.hashValue)),
        ]
        if let a = t.artist { info[MPMediaItemPropertyArtist] = a }
        if let a = t.album { info[MPMediaItemPropertyAlbumTitle] = a }
        if let cached = artworkCache, cached.albumId == t.albumId {
            let img = cached.image
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { @Sendable _ in img }
            if animatedArtwork, let anim = AnimatedArtwork.item(albumId: t.albumId, image: img) {
                info[MPNowPlayingInfoProperty1x1AnimatedArtwork] = anim
                info[MPNowPlayingInfoProperty3x4AnimatedArtwork] = anim
            }
        } else {
            loadArtwork(for: t)
        }
        center.nowPlayingInfo = info
        let sig = "\(t.id)|\(playing)"
        if force || sig != nowPlayingSig { nowPlayingSig = sig }
    }

    private func loadArtwork(for t: TrackCard) {
        artworkTask?.cancel()
        let albumId = t.albumId
        let local = Self.coverCacheURL(albumId: albumId)
        let remote = store?.coverURL(t.coverUrlPath)
        artworkTask = Task {
            var data = try? Data(contentsOf: local)
            if data == nil, let remote, let res = try? await URLSession.shared.data(from: remote), (res.1 as? HTTPURLResponse)?.statusCode == 200 {
                data = res.0
                try? FileManager.default.createDirectory(at: local.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? res.0.write(to: local, options: .atomic)
            }
            guard !Task.isCancelled, let data, let img = UIImage(data: data) else { return }
            self.artworkCache = (albumId, img)
            if self.current?.albumId == albumId { self.updateNowPlaying(force: true) }
        }
    }

    /// Covers cached for Now Playing, widgets and offline (Caches/mixai-covers/<albumId>.jpg).
    public nonisolated static func coverCacheURL(albumId: String) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("mixai-covers", isDirectory: true)
            .appendingPathComponent(MusicOffline.fileName(id: albumId, ext: "jpg"))
    }

    // MARK: prefs

    private static func loadPrefs() -> AudioPrefs {
        UserDefaults.standard.data(forKey: "music.audioPrefs").flatMap { try? JSONDecoder().decode(AudioPrefs.self, from: $0) }
            ?? AudioPrefs(crossfadeMs: 0, normalize: true)
    }

    private static func savePrefs(_ p: AudioPrefs) {
        UserDefaults.standard.set(try? JSONEncoder().encode(p), forKey: "music.audioPrefs")
    }
}
