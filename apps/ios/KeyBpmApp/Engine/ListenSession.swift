import Foundation
import Observation
import SwiftUI

/// Process-wide live session (WP18-05, port of Android `ListenSession`): owns the mic, the Rust engine, the 15 s PCM
/// ring for Song ID, auto-save into the set log, tracklist mode, drift alarm, key-change announcer, the Live Activity
/// and the watch mirror. Every screen, intent and widget goes through `ListenSession.shared`.
@MainActor @Observable
final class ListenSession {
    static let shared = ListenSession()

    // MARK: state shown by the UI
    private(set) var listening = false
    private(set) var reading: Reading?
    private(set) var micDenied = false
    private(set) var startedAt: Date?
    var tempoFactor = 1.0
    var notation: Notation = .camelot { didSet { prefs.notation = notation } }
    var a4: Double = 440 { didSet { engine.setA4(a4) } }
    private(set) var keyChange: Int?
    private(set) var saved = false
    private(set) var fileName: String?
    private(set) var analysing = false
    private(set) var fileError = false
    private(set) var drift: Double?
    private(set) var driftReference: Double?
    /// Song ID card state.
    private(set) var songId: SongIdState = .idle
    private(set) var pendingIds = 0
    /// Music Understanding (iOS 27+) second opinion when it disagrees with the live key.
    private(set) var appleKey: Int?

    let prefs = KeyBpmPrefs()
    let log = SetLog.shared
    let songIdEngine = SongIdEngine()

    var bpm: Double? { reading?.bpm.map { $0 * tempoFactor } }
    var isFileMode: Bool { fileName != nil }

    // MARK: internals
    @ObservationIgnored private let mic = MicCapture()
    @ObservationIgnored private let engine = EngineBox()
    @ObservationIgnored let ring = PcmRing(seconds: 15)
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var identifyTask: Task<Void, Never>?
    @ObservationIgnored private var lastEmit: TimeInterval = 0
    @ObservationIgnored private var lastKey: Int?
    @ObservationIgnored private var currentEntryAt: Date?
    @ObservationIgnored private var unsavedMatch: SongMatch?
    @ObservationIgnored private var lastIdentifyAt: TimeInterval = 0
    @ObservationIgnored private var driftMonitor = DriftMonitor()
    @ObservationIgnored private var whatKeyPending = false
    @ObservationIgnored let announcer = KeyAnnouncer()
    /// Watch mirror + Live Activity hooks (set by the app at launch; nil in previews / widgets).
    @ObservationIgnored var onPublish: ((ListenSession) -> Void)?
    @ObservationIgnored let clock = BeatClockBox()

    private init() {
        notation = prefs.notation
        pendingIds = songIdEngine.pendingCount
    }

    // MARK: listening
    func start() async {
        guard !listening else { return }
        guard await MicCapture.requestPermission() else { micDenied = true; return }
        micDenied = false
        stopFileMode()
        let ring = self.ring, engine = self.engine
        do {
            try mic.start { p, n in
                engine.push(p, count: n)
                ring.push(p, count: n)
            }
        } catch {
            micDenied = true
            return
        }
        engine.make(sampleRate: mic.sampleRate, a4: a4)
        ring.reset(sampleRate: mic.sampleRate)
        mic.onLost = { [weak self] in Task { @MainActor in self?.stop() } }
        listening = true
        startedAt = .now
        reading = nil
        keyChange = nil
        tempoFactor = 1
        saved = false
        songId = .idle
        drift = nil
        driftReference = nil
        driftMonitor.setReference(nil)
        currentEntryAt = nil
        unsavedMatch = nil
        lastKey = nil
        appleKey = nil
        LiveActivityController.shared.start(session: self)
        retryPending()
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                self?.tick()
            }
        }
        onPublish?(self)
    }

    func stop() {
        guard listening else { return }
        poll?.cancel(); poll = nil
        identifyTask?.cancel(); identifyTask = nil
        mic.stop()
        engine.close()
        listening = false
        startedAt = nil
        clock.box.stop()
        if case .collecting = songId { songId = .idle }
        if case .matching = songId { songId = .idle }
        LiveActivityController.shared.end(session: self)
        onPublish?(self)
    }

    func restart() async { stop(); await start() }

    private func tick() {
        guard let r = engine.read() else { return }
        let now = ProcessInfo.processInfo.systemUptime
        var change: Int?
        if r.keyChanged, let k = r.keyIndex, let lk = lastKey, k != lk { change = k }
        if let k = r.keyIndex { lastKey = k }
        if let change {
            currentEntryAt = nil
            unsavedMatch = nil
            identifyTask?.cancel(); identifyTask = nil
            if prefs.announceKey { announcer.keyChanged(change) }
            _ = change
        }
        if let b = r.bpm { clock.box.update(bpm: b * tempoFactor, nextIn: r.nextBeatIn, now: now) }
        if prefs.driftAlarm, r.tempoLocked, let b = r.bpm {
            let d = driftMonitor.update(bpm: b * tempoFactor, now: now)
            if d != nil, drift == nil { announcer.driftBuzz() }
            if d != drift { drift = d }
            if driftMonitor.reference != driftReference { driftReference = driftMonitor.reference }
        }
        let freshLock = (r.keyLocked && r.tempoLocked) && !((reading?.keyLocked ?? false) && (reading?.tempoLocked ?? false))
        guard change != nil || freshLock || now - lastEmit >= 0.1 else { return }
        lastEmit = now
        reading = r
        if let change { keyChange = change; saved = false; songId = .idle }
        if whatKeyPending, r.keyLocked, r.tempoLocked, let k = r.keyIndex, let b = bpm {
            whatKeyPending = false
            announcer.whatKey(k, bpm: b)
        }
        if !saved, r.keyLocked, r.tempoLocked { save() }
        onPublish?(self)
        LiveActivityController.shared.update(session: self)
    }

    func cycleTempo() { tempoFactor = tempoFactor == 1 ? 2 : (tempoFactor == 2 ? 0.5 : 1) }
    func dismissKeyChange() { keyChange = nil }
    func setA4(_ hz: Double) { a4 = min(466, max(415, hz)) }

    /// Siri / shortcut "What key is this?": listen, then speak key + BPM once both lock.
    func requestWhatKey() async {
        whatKeyPending = true
        if !listening { await start() }
    }

    // MARK: set log
    /// Saves the current reading (auto when key + tempo lock, or the Save button / notification action).
    func save() {
        guard let r = reading, let k = r.keyIndex, let b = bpm else { return }
        let source: LogEntry.Source = isFileMode ? .file : .mic
        var e = LogEntry(at: .now, camelot: Harmony.camelot(k), keyName: Harmony.longName(k), bpm: b, keyConfidence: r.keyConfidence, source: source, title: fileName)
        var applied = false
        if source == .mic, let m = unsavedMatch { e = e.with(m); unsavedMatch = nil; applied = true }
        log.add(e)
        saved = true
        if source == .mic { currentEntryAt = e.at }
        LastReading.save(LastReading(keyIndex: k, bpm: b, at: .now, title: e.title, artist: e.artist))
        WidgetBridge.reload()
        let now = ProcessInfo.processInfo.systemUptime
        if source == .mic, !applied, prefs.tracklistMode, songIdEngine.available, now - lastIdentifyAt > 45 { identify() }
    }

    func setTracklistMode(_ on: Bool) {
        prefs.tracklistMode = on
        if on, listening, saved, currentEntryAt != nil, case .idle = songId { identify() }
    }

    func setDriftAlarm(_ on: Bool) {
        prefs.driftAlarm = on
        driftMonitor.setReference(nil)
        driftReference = nil
        drift = nil
    }

    func useCurrentBpmAsReference() {
        guard let b = bpm else { return }
        driftMonitor.setReference(b)
        driftReference = b
        drift = nil
    }

    // MARK: Song ID
    func identify() {
        guard songIdEngine.available, listening, identifyTask == nil else { return }
        lastIdentifyAt = ProcessInfo.processInfo.systemUptime
        let entryAt = currentEntryAt
        identifyTask = Task { [weak self] in
            guard let self else { return }
            defer { self.identifyTask = nil }
            if self.ring.filledSeconds < 8 {
                self.songId = .collecting
                var waited = 0.0
                while self.ring.filledSeconds < 8, waited < 20, !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(250)); waited += 0.25
                }
            }
            guard !Task.isCancelled else { return }
            self.songId = .matching
            let pcm = self.ring.last(12)
            let result = await self.songIdEngine.identify(pcm: pcm, sampleRate: self.ring.sampleRate, entryAt: entryAt)
            guard !Task.isCancelled else { return }
            await self.apply(result, entryAt: entryAt, live: true)
            self.pendingIds = self.songIdEngine.pendingCount
            if case .match = result { self.retryPending() }
        }
    }

    private func apply(_ result: SongIdResult, entryAt: Date?, live: Bool) async {
        switch result {
        case .match(let song):
            let found = await LibraryClient.shared.enrich(song)
            if let at = entryAt {
                if let survivor = log.update(at: at, { $0.with(found) }), live { currentEntryAt = survivor }
            } else if live {
                unsavedMatch = found
            }
            if live { songId = .found(found, queued: false) }
            if let k = reading?.keyIndex, let b = bpm {
                LastReading.save(LastReading(keyIndex: k, bpm: b, at: .now, title: found.title, artist: found.artist))
            }
        case .noMatch: if live { songId = .noMatch }
        case .queued: if live { songId = .offline }
        case .failed(let reason): if live { songId = .error(reason) }
        }
        onPublish?(self)
        LiveActivityController.shared.update(session: self)
    }

    func retryPending() {
        guard songIdEngine.available else { return }
        Task { [weak self] in
            guard let self else { return }
            for item in self.songIdEngine.takePending(max: 5) {
                let r = await self.songIdEngine.retry(item)
                if case .queued = r { break }
                await self.apply(r, entryAt: item.entryAt, live: false)
            }
            self.pendingIds = self.songIdEngine.pendingCount
        }
    }

    func addFoundToQueue() async {
        guard case .found(let m, _) = songId, let id = m.libraryTrackId else { return }
        if await LibraryClient.shared.addToQueue(trackId: id) { songId = .found(m, queued: true) }
    }

    // MARK: file mode
    func analyze(url: URL) async {
        stop()
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        fileName = url.lastPathComponent
        analysing = true
        fileError = false
        reading = nil
        saved = false
        let ext = String(url.pathExtension.lowercased().prefix(5)).isEmpty ? "mp3" : String(url.pathExtension.lowercased().prefix(5))
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("analyse.\(ext)")
        try? FileManager.default.removeItem(at: tmp)
        do {
            try FileManager.default.copyItem(at: url, to: tmp)
            let path = tmp.path
            let r = try await Task.detached(priority: .userInitiated) { try EngineBox.analyzeFile(path) }.value
            reading = r
            await crossCheck(url: tmp, live: r.keyIndex)
        } catch {
            fileError = true
        }
        try? FileManager.default.removeItem(at: tmp)
        analysing = false
    }

    private func stopFileMode() {
        fileName = nil
        fileError = false
        analysing = false
    }

    /// iOS 27 Music Understanding: Apple's on-device key as a second opinion (shown only when it disagrees).
    private func crossCheck(url: URL, live: Int?) async {
        appleKey = nil
        guard let k = await AppleMusicUnderstanding.key(of: url), k != live else { return }
        appleKey = k
    }
}

/// Song ID card state (port of Android `SongIdUi`).
enum SongIdState: Equatable {
    case idle, collecting, matching, noMatch, offline
    case error(String)
    case found(SongMatch, queued: Bool)
}

