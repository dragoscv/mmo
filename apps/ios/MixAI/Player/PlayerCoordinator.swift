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

/// One subtitle search result (server hit or local cue), absolute media seconds.
struct SubtitleMatch: Identifiable, Hashable, Sendable {
    let id: Int
    let start: Double
    let end: Double
    let text: String
}

struct SubtitleSearchOutcome: Sendable {
    var matches: [SubtitleMatch]
    /// The server search failed / returned nothing: matches come from the loaded subtitle tracks only.
    var localOnly: Bool
}

/// AVPlayerItem failure, flattened to Sendable values on the KVO thread.
private struct ItemFailure: Sendable {
    let domain: String
    let code: Int
    let underlying: [Int]
    let message: String
}

/// Codes of the `NSUnderlyingErrorKey` chain (+ `underlyingErrors`), outermost first.
private func underlyingErrorCodes(_ error: NSError?) -> [Int] {
    var out: [Int] = []
    var current = error?.userInfo[NSUnderlyingErrorKey] as? NSError
    var depth = 0
    while let c = current, depth < 8 {
        out.append(c.code)
        current = c.userInfo[NSUnderlyingErrorKey] as? NSError
        depth += 1
    }
    for e in error?.underlyingErrors ?? [] { out.append((e as NSError).code) }
    return out
}

/// Owns the active playback session: engine (AVPlayer, VLC fallback), HLS offset math, audio/subtitle tracks,
/// markers, fading sleep timer, night mode, bookmarks, Now Playing info, progress writes. One per app (the
/// full-screen player is a view over it).
@MainActor
@Observable
final class PlayerCoordinator {
    var request: PlayRequest?
    var presented = false
    var playing = false
    /// Absolute media seconds (stream time + server `?start=` offset; VLC/offline: offset 0).
    var position: Double = 0
    var duration: Double = 0
    var buffering = true
    var error: String?
    var audioTracks: [AudioTrack] = []
    var subtitleTracks: [(ordinal: Int, track: SubtitleTrack)] = []
    var audioOrdinal = 0
    var subtitleOrdinal: Int?
    var cues: [SubtitleCue] = []
    var secondarySubtitleOrdinal: Int?
    var secondaryCues: [SubtitleCue] = []
    var intro: ClosedRange<Double>?
    var creditsAt: Double?
    var speed: Float = 1
    var sleepAt: Date?
    var sleepEndOfItem = false

    private(set) var engine: any PlaybackEngine = AVPlayerEngine()
    /// Mirrors `engine.avPlayer` as observable state (the surface / PiP rebind when it changes).
    private(set) var avPlayer: AVPlayer?
    private(set) var engineName = "AVPlayer"
    /// Bumped on every engine swap so the VLC surface re-attaches.
    private(set) var engineGeneration = 0
    /// Playing a downloaded file (no HLS, no audio switching).
    private(set) var isOffline = false
    /// Kid profile over its daily cap (server-enforced).
    var capLocked = false
    private(set) var capMinutes: Int?
    /// Data saver: expensive network + saver on → ask before streaming original quality.
    var askDataSaver = false
    private(set) var dataSaverAck = false
    private(set) var nightMode = false
    var bookmarks: [Bookmark] = []
    var bookmarksLoading = false
    var bookmarkError: String?

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var offset: Double = 0
    @ObservationIgnored private var pendingStartSec: Double = 0
    @ObservationIgnored private var client: MmoClient?
    @ObservationIgnored private var progress: ProgressSync?
    @ObservationIgnored private var ref: MediaRef?
    @ObservationIgnored private var fileId: String?
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var timeObserverOwner: AVPlayer?
    @ObservationIgnored private var tick = 0
    @ObservationIgnored private var tickTask: Task<Void, Never>?
    @ObservationIgnored private var endObserver: NSObjectProtocol?
    @ObservationIgnored private var statusObservation: NSKeyValueObservation?
    @ObservationIgnored private var fallbackTried = false
    @ObservationIgnored private var endedFired = false

    var usingVLC: Bool { !(engine is AVPlayerEngine) }
    var canSwitchAudio: Bool { !isOffline && !usingVLC }
    /// Night mode needs the AVPlayer audio tap (no-op for VLC; silently ineffective on HLS, see NightModeTap).
    var nightModeAvailable: Bool { !usingVLC }
    var isFile: Bool {
        if case .file = request?.source { return true }
        return false
    }

    func start(_ req: PlayRequest, app: AppModel) {
        guard let client = app.client else { return }
        stop()
        self.app = app
        self.client = client
        self.progress = app.progress
        request = req
        presented = true
        error = nil
        buffering = true
        position = 0
        duration = 0
        cues = []
        secondaryCues = []
        secondarySubtitleOrdinal = nil
        intro = nil
        creditsAt = nil
        capLocked = false
        capMinutes = nil
        askDataSaver = false
        isOffline = false
        bookmarks = []
        bookmarkError = nil
        fallbackTried = false
        endedFired = false
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, policy: .longFormVideo)
        try? AVAudioSession.sharedInstance().setActive(true)
        app.music.pause()
        switch req.source {
        case .file(let fid, let r, let startSec):
            fileId = fid
            ref = r
            audioOrdinal = 0
            subtitleOrdinal = nil
            position = max(0, startSec)
            Task { await loadFileMeta(fid, profile: app.profileId) }
            if let local = app.offline.localURL(fileId: fid) {
                isOffline = true
                loadLocal(local, startSec: startSec)
            } else {
                pendingStartSec = startSec
                let id = req.id
                Task { await proceedFile(requestId: id) }
            }
        case .live(let channelId, _):
            fileId = nil
            ref = nil
            Task { await loadLive(channelId, app: app) }
        }
        updateNowPlaying()
    }

    /// Daily cap + data saver gates, then the HLS stream.
    private func proceedFile(requestId: UUID) async {
        guard let app, let fid = fileId else { return }
        if let phone = app.phone, let usage = try? await phone.usage(profileId: app.profileId) {
            guard request?.id == requestId else { return }
            if usage.overCap && usage.enforced {
                capMinutes = usage.dailyCapMin
                capLocked = true
                buffering = false
                return
            }
        }
        guard request?.id == requestId else { return }
        if dataSaverDecision(expensive: app.networkExpensive, saverOn: app.dataSaver, acknowledged: dataSaverAck, isDownload: false) == .ask {
            askDataSaver = true
            buffering = false
            return
        }
        loadFile(fid, startSec: pendingStartSec)
    }

    /// "Play anyway" from the data-saver alert (remembered for this player session).
    func confirmDataSaver() {
        dataSaverAck = true
        askDataSaver = false
        guard request != nil, let fid = fileId else { return }
        buffering = true
        loadFile(fid, startSec: pendingStartSec)
    }

    private func loadFile(_ fid: String, startSec: Double) {
        guard let client else { return }
        offset = max(0, startSec.rounded(.down))
        guard let url = URL(string: client.hlsURL(fileId: fid, startSec: Int(offset), audio: audioOrdinal)) else { return }
        engine.load(url: url, headers: [:])
        engine.rate = speed
        engine.play()
        didLoad()
    }

    private func loadLocal(_ url: URL, startSec: Double) {
        offset = 0
        engine.load(url: url, headers: [:])
        engine.rate = speed
        if startSec > 0 { engine.seek(to: startSec) }
        engine.play()
        didLoad()
    }

    private func loadLive(_ channelId: String, app: AppModel) async {
        guard let live = app.liveTv else { return }
        do {
            let s = try await live.resolve(channelId)
            guard let url = URL(string: s.url) else { return }
            offset = 0
            engine.load(url: url, headers: s.proxied ? live.client.authHeaders : [:])
            engine.play()
            didLoad()
        } catch {
            self.error = String(localized: "player.error.live")
        }
    }

    /// After every (re)load: rebind the surface, re-observe the new item, re-apply night mode.
    private func didLoad() {
        avPlayer = engine.avPlayer
        engineName = engine.engineName
        observe()
        applyNightMode()
        updateNowPlaying()
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
        removeObservers()
        if let p = engine.avPlayer {
            timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.onTick() }
            }
            timeObserverOwner = p
            // A failed item (server 500, unsupported stream) never moves the clock, so the periodic observer stays silent.
            statusObservation = p.currentItem?.observe(\.status, options: [.new]) { [weak self] item, _ in
                guard item.status == .failed else { return }
                let ns = item.error.map { $0 as NSError }
                let failure = ItemFailure(
                    domain: ns?.domain ?? "",
                    code: ns?.code ?? 0,
                    underlying: underlyingErrorCodes(ns),
                    message: ns?.localizedDescription ?? String(localized: "player.error.title")
                )
                Task { @MainActor in self?.handleItemFailure(failure) }
            }
            endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: p.currentItem, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.onEnded() }
            }
        } else {
            // Engines without an AVPlayer clock (VLC) are polled.
            tickTask = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(500))
                    guard let self else { return }
                    self.onTick()
                }
            }
        }
    }

    private func removeObservers() {
        if let o = timeObserver { timeObserverOwner?.removeTimeObserver(o) }
        timeObserver = nil
        timeObserverOwner = nil
        endObserver.map(NotificationCenter.default.removeObserver)
        endObserver = nil
        statusObservation?.invalidate()
        statusObservation = nil
        tickTask?.cancel()
        tickTask = nil
    }

    /// AVFoundation refused the item: VLC for container/codec errors (D36), daily-cap probe, else the error card.
    private func handleItemFailure(_ f: ItemFailure) {
        guard request != nil, !usingVLC else { return }
        buffering = false
        if isFile, !fallbackTried, VLCAvailability.available,
           shouldFallBackToVLC(errorDomain: f.domain, errorCode: f.code, underlyingCodes: f.underlying) {
            fallbackTried = true
            if switchToVLC() { return }
        }
        if isFile, !isOffline, let fid = fileId {
            let id = request?.id
            Task {
                let locked = await probeCap(fid)
                guard request?.id == id else { return }
                if locked { capLocked = true } else { error = f.message }
            }
        } else {
            error = f.message
        }
    }

    /// GET of the stream URL: 403 `{error:"daily_cap"}` → locked (AVPlayer hides the HTTP status from us).
    private func probeCap(_ fid: String) async -> Bool {
        guard let client, let url = URL(string: client.hlsURL(fileId: fid, startSec: Int(offset), audio: audioOrdinal)) else { return false }
        guard let (data, response) = try? await URLSession.shared.data(from: url),
              let http = response as? HTTPURLResponse, http.statusCode == 403 else { return false }
        guard let cap = DailyCapError.parse(APIStatusError(status: 403, body: String(decoding: data, as: UTF8.self))) else { return false }
        capMinutes = cap.dailyCapMin
        return true
    }

    /// Original file through libVLC, resuming at the current absolute position.
    private func switchToVLC() -> Bool {
        guard let fid = fileId, let vlc = VLCAvailability.makeEngine() else { return false }
        let url: URL
        if isOffline, let local = app?.offline.localURL(fileId: fid) {
            url = local
        } else if let client, let u = URL(string: client.directURL(fileId: fid)) {
            url = u
        } else {
            return false
        }
        let resumeAt = position
        removeObservers()
        engine.stop()
        vlc.rate = speed
        vlc.volume = engine.volume
        engine = vlc
        engineGeneration += 1
        offset = 0
        error = nil
        buffering = true
        vlc.load(url: url, headers: [:])
        if resumeAt > 1 { vlc.seek(to: resumeAt) }
        vlc.play()
        didLoad()
        return true
    }

    /// The SwiftUI surface hands its UIView to engines that draw into one (VLC).
    func attachSurface(_ view: UIView) { engine.attach(to: view) }

    private func onTick() {
        let e = engine
        let t = e.currentTime
        // VLC reports 0 once stopped/ended; keep the last known position.
        if t > 0 || !usingVLC { position = offset + t }
        playing = e.isPlaying
        buffering = e.isBuffering
        if duration <= 0, let d = e.durationSec { duration = offset + d }
        if usingVLC {
            if e.lastError != nil, error == nil {
                error = String(localized: "player.error.vlc")
                buffering = false
            }
            if !endedFired, duration > 0, !e.isPlaying, position >= duration - 2 {
                endedFired = true
                onEnded()
            }
        }
        applySleepFade()
        tick += 1
        if tick % 20 == 0 { saveProgress() }
        if tick % 4 == 0 { updateNowPlaying() }
    }

    /// Fading sleep timer: linear fade over the last 30 s, then pause and restore the volume.
    private func applySleepFade() {
        if let at = sleepAt {
            let remaining = at.timeIntervalSinceNow
            setVolume(sleepFadeVolume(remainingSec: remaining))
            if remaining <= 0 {
                sleepAt = nil
                pause()
                setVolume(1)
            }
        } else if sleepEndOfItem, duration > 0, position > 0 {
            let remaining = duration - position
            setVolume(sleepFadeVolume(remainingSec: remaining))
            if remaining <= 0.75 {
                sleepEndOfItem = false
                pause()
                setVolume(1)
            }
        }
    }

    private func setVolume(_ v: Float) {
        if engine.volume != v { engine.volume = v }
    }

    private func onEnded() {
        if let ref, duration > 0 {
            let d = duration
            Task { await progress?.markWatched(ref, durationSec: d) }
        }
        if let fid = fileId { app?.offline.markWatched(fileId: fid) }
        if sleepEndOfItem {
            sleepEndOfItem = false
            setVolume(1)
        }
        playing = false
    }

    // MARK: controls

    func togglePlay() { engine.isPlaying ? pause() : play() }
    func play() { engine.play(); playing = true; updateNowPlaying() }
    func pause() { engine.pause(); playing = false; saveProgress(); updateNowPlaying() }

    /// Seek in ABSOLUTE seconds. Before the server offset (HLS only) → restart the stream at the new point.
    func seek(to absolute: Double) {
        let target = max(0, duration > 0 ? min(absolute, duration - 1) : absolute)
        if target < offset, let fid = fileId {
            loadFile(fid, startSec: target)
        } else {
            engine.seek(to: target - offset)
        }
        position = target
        endedFired = false
    }

    func skip(_ delta: Double) { seek(to: position + delta) }

    func setSpeed(_ s: Float) { speed = s; engine.rate = s }

    /// Switching audio = new server session for `audio=<n>` at the current position (HLS only).
    func selectAudio(_ ordinal: Int) {
        guard ordinal != audioOrdinal, canSwitchAudio, let fid = fileId else { return }
        audioOrdinal = ordinal
        loadFile(fid, startSec: position)
    }

    func selectSubtitle(_ ordinal: Int?) {
        subtitleOrdinal = ordinal
        cues = []
        guard let ordinal else { return }
        Task {
            let loaded = await fetchCues(ordinal)
            if subtitleOrdinal == ordinal { cues = loaded }
        }
    }

    /// Dual subtitles: a second track rendered smaller above the primary line.
    func selectSecondarySubtitle(_ ordinal: Int?) {
        secondarySubtitleOrdinal = ordinal
        secondaryCues = []
        guard let ordinal else { return }
        Task {
            let loaded = await fetchCues(ordinal)
            if secondarySubtitleOrdinal == ordinal { secondaryCues = loaded }
        }
    }

    private func fetchCues(_ ordinal: Int) async -> [SubtitleCue] {
        guard let fid = fileId, let client, let url = URL(string: client.subtitleURL(fileId: fid, ordinal: ordinal)) else { return [] }
        guard let (data, _) = try? await URLSession.shared.data(from: url) else { return [] }
        return WebVTT.parse(String(decoding: data, as: UTF8.self))
    }

    var activeCue: String? { subtitleOrdinal == nil ? nil : WebVTT.active(cues, at: position) }

    var secondaryCue: String? {
        secondarySubtitleOrdinal == nil ? nil : dualSubtitleLine(primary: activeCue, secondaryCues: secondaryCues, at: position)
    }

    var showSkipIntro: Bool { intro.map { $0.contains(position) && $0.upperBound - position > 2 } ?? false }

    func skipIntro() { if let i = intro { seek(to: i.upperBound) } }

    func setSleep(minutes: Int?) {
        sleepEndOfItem = false
        setVolume(1)
        sleepAt = minutes.map { Date().addingTimeInterval(TimeInterval($0 * 60)) }
    }

    /// Sleep at the end of this episode/movie (fades over the last 30 s).
    func setSleepEndOfItem() {
        sleepAt = nil
        setVolume(1)
        sleepEndOfItem = true
    }

    // MARK: night mode

    func setNightMode(_ on: Bool) {
        nightMode = on
        applyNightMode()
    }

    private func applyNightMode() {
        guard let item = engine.avPlayer?.currentItem else { return }
        guard nightMode else {
            item.audioMix = nil
            return
        }
        Task {
            let mix = await NightModeTap.makeAudioMix(for: item)
            guard nightMode, engine.avPlayer?.currentItem === item else { return }
            item.audioMix = mix
        }
    }

    // MARK: search inside subtitles

    /// Server index first (`/media/subtitles/search`), loaded tracks as the offline fallback.
    func searchSubtitles(_ q: String) async -> SubtitleSearchOutcome {
        let query = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return SubtitleSearchOutcome(matches: [], localOnly: false) }
        if let phone = app?.phone, let fid = fileId, let result = try? await phone.searchSubtitles(query, fileId: fid) {
            let hits = result.hits.filter { $0.fileId == fid }
            if !hits.isEmpty {
                let matches = hits.enumerated().map { SubtitleMatch(id: $0.offset, start: $0.element.startSec, end: $0.element.endSec, text: $0.element.text) }
                return SubtitleSearchOutcome(matches: matches, localOnly: false)
            }
        }
        let local = searchCues(cues + secondaryCues, query: query)
        let matches = local.enumerated().map { SubtitleMatch(id: $0.offset, start: $0.element.start, end: $0.element.end, text: $0.element.text) }
        return SubtitleSearchOutcome(matches: matches, localOnly: true)
    }

    /// Jump to a search hit (1 s of lead-in).
    func seekToMatch(_ m: SubtitleMatch) { seek(to: max(0, m.start - 1)) }

    // MARK: scene bookmarks

    func loadBookmarks() async {
        guard let phone = app?.phone, let key = BookmarkInput.titleKey(ref: ref, fileId: fileId) else {
            bookmarks = []
            bookmarkError = String(localized: "bookmarks.unavailable")
            return
        }
        bookmarksLoading = true
        defer { bookmarksLoading = false }
        do {
            bookmarks = try await phone.bookmarks(titleKey: key).sorted { $0.sec < $1.sec }
            bookmarkError = nil
        } catch {
            bookmarkError = String(localized: "bookmarks.load_failed")
        }
    }

    @discardableResult
    func addBookmark(label: String?, shared: Bool) async -> Bool {
        guard let phone = app?.phone, fileId != nil else { return false }
        let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        let clean: String? = (trimmed?.isEmpty ?? true) ? nil : trimmed
        let input = BookmarkInput(ref: ref, fileId: fileId, sec: position, label: clean, shared: shared)
        do {
            let b = try await phone.addBookmark(input)
            bookmarks = (bookmarks + [b]).sorted { $0.sec < $1.sec }
            bookmarkError = nil
            return true
        } catch {
            bookmarkError = String(localized: "bookmarks.save_failed")
            return false
        }
    }

    func deleteBookmark(_ b: Bookmark) async {
        guard let phone = app?.phone else { return }
        do {
            try await phone.deleteBookmark(b.id)
            bookmarks.removeAll { $0.id == b.id }
        } catch {
            bookmarkError = String(localized: "bookmarks.delete_failed")
        }
    }

    func seekToBookmark(_ b: Bookmark) { seek(to: b.sec) }

    // MARK: Play on TV (the sheet is owned by the app shell)

    /// Hands the current title (at the current position) to the Play-on sheet and closes the local player.
    func playOnTV() {
        guard let app, let req = request else { return }
        let handoff: PlayRequest
        if case .file(let fid, let r, _) = req.source {
            handoff = PlayRequest(source: .file(fileId: fid, ref: r, startSec: position), title: req.title, subtitle: req.subtitle, artwork: req.artwork)
        } else {
            handoff = req
        }
        dismiss()
        app.playOnRequest = handoff
        app.showPlayOn = true
    }

    func dismiss() {
        saveProgress()
        presented = false
        stop()
    }

    func stop() {
        removeObservers()
        engine.stop()
        if usingVLC {
            engine = AVPlayerEngine()
            engineGeneration += 1
        }
        engine.volume = 1
        avPlayer = engine.avPlayer
        engineName = engine.engineName
        playing = false
        askDataSaver = false
        sleepAt = nil
        sleepEndOfItem = false
        request = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// Server progress (queued by ProgressSync on failure) + the local offline record for downloaded files.
    private func saveProgress() {
        guard duration > 0, position > 5 else { return }
        let pos = position, dur = duration
        if let ref {
            Task { await progress?.save(ref, positionSec: pos, durationSec: dur, completed: pos / dur > 0.93 ? true : nil) }
        }
        if isOffline || ref == nil, let fid = fileId {
            app?.offline.recordProgress(ref: ref, fileId: fid, positionSec: pos, durationSec: dur)
        }
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
