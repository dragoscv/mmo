import BackgroundTasks
import Foundation
import MixaiCore
import Observation

/// Offline downloads: server MP4 remux (`PhoneStore.prepareDownload`) → background URLSession → Application
/// Support/mixai/downloads (excluded from iCloud backup). Persists `[DownloadItem]` as JSON; offline progress is
/// queued and handed to `ProgressSync` when the server is reachable again.
@MainActor
@Observable
final class OfflineStore {
    nonisolated static let sessionId = "ro.mixai.app.downloads"
    nonisolated static let smartTaskId = "ro.mixai.app.smartdownloads"

    enum EnqueueResult: Equatable { case started, waitingForWifi, alreadyThere, noServer }

    private(set) var items: [DownloadItem] = []
    var wifiOnly: Bool = Prefs.flag("dl.wifiOnly", default: true) { didSet { Prefs.setFlag("dl.wifiOnly", wifiOnly); if !wifiOnly { resumePaused() } } }
    var smartEnabled: Bool = Prefs.flag("dl.smart", default: true) { didSet { Prefs.setFlag("dl.smart", smartEnabled) } }
    var autoDeleteWatched: Bool = Prefs.flag("dl.autoDelete", default: false) { didSet { Prefs.setFlag("dl.autoDelete", autoDeleteWatched) } }

    @ObservationIgnored weak var app: AppModel?
    @ObservationIgnored var backgroundEventsHandler: (() -> Void)?
    @ObservationIgnored private var session: URLSession?
    @ObservationIgnored private var preparing: Task<Void, Never>?
    @ObservationIgnored private var lastActivityUpdate: [String: Double] = [:]
    @ObservationIgnored private var pendingProgress: [OfflineProgressEntry] = []

    init() {
        items = (try? Data(contentsOf: Self.indexFile)).flatMap { try? JSONDecoder().decode([DownloadItem].self, from: $0) } ?? []
        pendingProgress = (try? Data(contentsOf: Self.progressFile)).flatMap { try? JSONDecoder().decode([OfflineProgressEntry].self, from: $0) } ?? []
        ensureSession()
    }

    // MARK: paths (pure, any thread)

    nonisolated static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("mixai", isDirectory: true)
    }
    nonisolated static var filesDir: URL { root.appendingPathComponent("downloads", isDirectory: true) }
    nonisolated static var indexFile: URL { root.appendingPathComponent("downloads.json") }
    nonisolated static var progressFile: URL { root.appendingPathComponent("offline-progress.json") }

    nonisolated static func fileURL(for id: String) -> URL {
        let safe = String(id.unicodeScalars.map { ($0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_")) ? Character($0) : "_" })
        return filesDir.appendingPathComponent("\(safe).mp4")
    }

    // MARK: queries used by the player

    func localURL(fileId: String) -> URL? {
        guard let i = items.first(where: { $0.fileId == fileId && $0.state == .done }) else { return nil }
        let url = Self.fileURL(for: i.id)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func item(fileId: String) -> DownloadItem? { items.first { $0.fileId == fileId } }

    func recordProgress(ref: MediaRef?, fileId: String, positionSec: Double, durationSec: Double) {
        mutate(fileId: fileId) { $0.positionSec = positionSec; $0.durationSec = durationSec }
        if let ref {
            pendingProgress.removeAll { $0.ref == ref }
            pendingProgress.append(OfflineProgressEntry(ref: ref, positionSec: positionSec, durationSec: durationSec, at: .now))
            if pendingProgress.count > 500 { pendingProgress.removeFirst(pendingProgress.count - 500) }
            persistProgress()
        }
    }

    func markWatched(fileId: String) {
        mutate(fileId: fileId) { $0.watchedAt = .now }
    }

    /// Offline positions → ProgressSync (which keeps its own retry queue).
    func flushProgress() async {
        guard let app, app.networkOnline, let sync = app.progress, !pendingProgress.isEmpty else { return }
        let batch = pendingProgress
        pendingProgress = []
        persistProgress()
        for e in batch {
            await sync.save(e.ref, positionSec: e.positionSec, durationSec: e.durationSec, completed: e.durationSec > 0 && e.positionSec / e.durationSec > 0.93 ? true : nil)
        }
    }

    // MARK: enqueue / delete

    @discardableResult
    func enqueue(fileId: String, audio: Int, ref: MediaRef?, title: String, show: String?, posterPath: String?, smart: Bool) -> EnqueueResult {
        guard app?.client != nil else { return .noServer }
        let key = DownloadItem.key(fileId: fileId, audio: audio)
        if let existing = items.first(where: { $0.id == key }), existing.state != .failed { return .alreadyThere }
        items.removeAll { $0.id == key }
        var item = DownloadItem(fileId: fileId, audio: audio, ref: ref, title: title, show: show, posterPath: posterPath, smart: smart)
        let blocked = wifiOnly && (app?.networkExpensive ?? false)
        if blocked {
            item.state = .paused
            item.error = String(localized: "downloads.waiting_wifi")
        }
        items.append(item)
        persist()
        if blocked { return .waitingForWifi }
        app?.activities.startDownload(item: item, queued: queuedCount)
        pump()
        return .started
    }

    func retry(_ id: String) {
        mutate(id: id) { $0.state = .queued; $0.error = nil; $0.progress = 0 }
        pump()
    }

    func delete(_ id: String) {
        session?.getAllTasks { @Sendable tasks in
            for t in tasks where t.taskDescription == id { t.cancel() }
        }
        try? FileManager.default.removeItem(at: Self.fileURL(for: id))
        items.removeAll { $0.id == id }
        app?.activities.endDownload(id: id, success: false)
        persist()
    }

    func deleteAll() {
        session?.getAllTasks { @Sendable tasks in tasks.forEach { $0.cancel() } }
        preparing?.cancel()
        preparing = nil
        for i in items { app?.activities.endDownload(id: i.id, success: false) }
        try? FileManager.default.removeItem(at: Self.filesDir)
        items = []
        persist()
    }

    var usedBytes: Int64 { OfflineLibrary.gauge(items: items, freeBytes: 0).used }

    nonisolated static func freeBytes() -> Int64 {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        return (try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage ?? 0
    }

    private var queuedCount: Int { items.filter { $0.state == .queued || $0.state == .preparing }.count }

    // MARK: pipeline

    func ensureSession() {
        guard session == nil else { return }
        let cfg = URLSessionConfiguration.background(withIdentifier: Self.sessionId)
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        // Wi-Fi only is enforced per request (allowsCellularAccess / allowsExpensiveNetworkAccess) so the toggle
        // applies without recreating the background session.
        cfg.allowsCellularAccess = true
        session = URLSession(configuration: cfg, delegate: DownloadDelegate(), delegateQueue: nil)
    }

    /// Boot / reconnect: interrupted preparations go back to the queue; downloads without a live task restart.
    func resumePending() {
        var changed = false
        for idx in items.indices where items[idx].state == .preparing {
            items[idx].state = .queued
            changed = true
        }
        if changed { persist() }
        session?.getAllTasks { @Sendable tasks in
            let live = Set(tasks.compactMap(\.taskDescription))
            Task { @MainActor in AppModel.shared.offline.requeueOrphans(live: live) }
        }
    }

    private func requeueOrphans(live: Set<String>) {
        for idx in items.indices where items[idx].state == .downloading && !live.contains(items[idx].id) {
            items[idx].state = .queued
        }
        persist()
        pump()
    }

    /// Network became cheap (or Wi-Fi only switched off): paused items go back to the queue.
    func resumePaused() {
        guard !(wifiOnly && (app?.networkExpensive ?? false)) else { return }
        var any = false
        for idx in items.indices where items[idx].state == .paused {
            items[idx].state = .queued
            items[idx].error = nil
            any = true
        }
        if any { persist(); pump() }
    }

    /// One preparation at a time (server remux), transfers run in parallel in the background session.
    private func pump() {
        guard preparing == nil, let next = items.first(where: { $0.state == .queued }) else { return }
        preparing = Task {
            await self.prepare(next.id)
            self.preparing = nil
            self.pump()
        }
    }

    private func prepare(_ id: String) async {
        guard let item = items.first(where: { $0.id == id }), let phone = app?.phone else { return }
        if wifiOnly && (app?.networkExpensive ?? false) {
            mutate(id: id) { $0.state = .paused; $0.error = String(localized: "downloads.waiting_wifi") }
            return
        }
        mutate(id: id) { $0.state = .preparing; $0.error = nil }
        app?.activities.startDownload(item: item, queued: queuedCount)
        var failures = 0
        while !Task.isCancelled {
            guard items.contains(where: { $0.id == id }) else { return }
            do {
                switch try await phone.prepareDownload(fileId: item.fileId, audio: item.audio) {
                case .ready(let urlString, let size):
                    guard let url = URL(string: urlString) else { fail(id, "bad_url"); return }
                    start(id: id, url: url, sizeHint: size)
                    return
                case .preparing(let job, let retry):
                    mutate(id: id) { $0.progress = job.progress }
                    app?.activities.updateDownload(id: id, state: .init(phase: .preparing, progress: job.progress, bytesDone: 0, bytesTotal: 0, queued: queuedCount))
                    try await Task.sleep(for: .seconds(max(1, retry)))
                case .failed(let msg):
                    fail(id, msg)
                    return
                }
            } catch is CancellationError {
                return
            } catch {
                failures += 1
                if failures >= 5 { fail(id, error.localizedDescription); return }
                try? await Task.sleep(for: .seconds(3 * failures))
            }
        }
    }

    private func start(id: String, url: URL, sizeHint: Int?) {
        ensureSession()
        var req = URLRequest(url: url)
        req.allowsCellularAccess = !wifiOnly
        req.allowsExpensiveNetworkAccess = !wifiOnly
        req.allowsConstrainedNetworkAccess = !wifiOnly
        guard let task = session?.downloadTask(with: req) else { fail(id, "no_session"); return }
        task.taskDescription = id
        if let s = sizeHint { task.countOfBytesClientExpectsToReceive = Int64(s) }
        mutate(id: id) { $0.state = .downloading; $0.progress = 0; $0.bytesTotal = Int64(sizeHint ?? 0) }
        task.resume()
    }

    private func fail(_ id: String, _ message: String) {
        mutate(id: id) { $0.state = .failed; $0.error = message }
        app?.activities.endDownload(id: id, success: false)
    }

    // MARK: delegate callbacks (main actor)

    func didWrite(id: String, done: Int64, total: Int64) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        items[idx].bytesDone = done
        if total > 0 { items[idx].bytesTotal = total }
        let t = items[idx].bytesTotal
        items[idx].progress = t > 0 ? Double(done) / Double(t) : 0
        let p = items[idx].progress
        if p - (lastActivityUpdate[id] ?? -1) >= 0.02 {
            lastActivityUpdate[id] = p
            app?.activities.updateDownload(id: id, state: .init(phase: .downloading, progress: p, bytesDone: done, bytesTotal: t, queued: queuedCount))
        }
    }

    func didFinish(id: String, bytes: Int64?, error: String?) {
        lastActivityUpdate[id] = nil
        guard items.contains(where: { $0.id == id }) else {
            try? FileManager.default.removeItem(at: Self.fileURL(for: id))
            return
        }
        if let error {
            fail(id, error)
            return
        }
        mutate(id: id) {
            $0.state = .done
            $0.progress = 1
            if let b = bytes { $0.bytesTotal = b; $0.bytesDone = b }
            $0.localFile = Self.fileURL(for: id).lastPathComponent
            $0.finishedAt = .now
            $0.error = nil
        }
        app?.activities.endDownload(id: id, success: true)
    }

    func didFail(id: String, error: String) {
        guard let i = items.first(where: { $0.id == id }), i.state == .downloading else { return }
        fail(id, error)
    }

    func finishBackgroundEvents() {
        backgroundEventsHandler?()
        backgroundEventsHandler = nil
    }

    // MARK: auto-delete + smart downloads

    func autoDelete() {
        for i in OfflineLibrary.expired(items, now: .now, all: autoDeleteWatched) { delete(i.id) }
    }

    /// For every show with a downloaded episode: the next 3 episodes (current + next season) not yet downloaded.
    func smartDownloads() async {
        guard smartEnabled, let media = app?.media else { return }
        let shows = Dictionary(grouping: items.filter { $0.ref?.kind == .tv && $0.state == .done }) { $0.ref!.tmdbId }
        let have = Set(items.map(\.fileId))
        for (tmdbId, eps) in shows {
            let last = eps.compactMap { e -> (Int, Int)? in
                guard let s = e.ref?.season, let n = e.ref?.episode else { return nil }
                return (s, n)
            }.max { $0 < $1 }
            guard let last else { continue }
            var available: [(season: Int, episode: Int, fileId: String)] = []
            var names: [String: String] = [:]
            for season in [last.0, last.0 + 1] {
                guard let sd = try? await media.season(tmdbId: tmdbId, number: season) else { continue }
                for ep in sd.episodes {
                    guard let f = PlayResolver.bestFile(ep.files) else { continue }
                    available.append((season: ep.seasonNumber, episode: ep.episodeNumber, fileId: f.serverFileId))
                    names[f.serverFileId] = ep.name
                }
            }
            let next = OfflineLibrary.nextEpisodes(available: available, watchedUpTo: (season: last.0, episode: last.1), have: have)
            let sample = eps[0]
            for n in next {
                let title = "S\(n.season) E\(n.episode) · \(names[n.fileId] ?? "")"
                enqueue(fileId: n.fileId, audio: 0, ref: MediaRef(kind: .tv, tmdbId: tmdbId, season: n.season, episode: n.episode),
                        title: title, show: sample.show ?? sample.title, posterPath: sample.posterPath, smart: true)
            }
        }
    }

    func runSmartTask(_ task: BGTask) {
        Self.scheduleSmartTask()
        let work = Task { @MainActor in
            self.autoDelete()
            await self.smartDownloads()
        }
        task.expirationHandler = { @Sendable in work.cancel() }
        let box = MainActorBox(value: task)
        Task { @MainActor in
            await work.value
            box.value.setTaskCompleted(success: !work.isCancelled)
        }
    }

    nonisolated static func scheduleSmartTask() {
        let req = BGProcessingTaskRequest(identifier: smartTaskId)
        req.requiresExternalPower = true
        req.requiresNetworkConnectivity = true
        req.earliestBeginDate = Date().addingTimeInterval(3600)
        try? BGTaskScheduler.shared.submit(req)
    }

    // MARK: persistence

    private func mutate(id: String, _ f: (inout DownloadItem) -> Void) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        f(&items[idx])
        persist()
    }

    private func mutate(fileId: String, _ f: (inout DownloadItem) -> Void) {
        var any = false
        for idx in items.indices where items[idx].fileId == fileId {
            f(&items[idx])
            any = true
        }
        if any { persist() }
    }

    private func persist() {
        try? FileManager.default.createDirectory(at: Self.root, withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(items) { try? d.write(to: Self.indexFile, options: .atomic) }
    }

    private func persistProgress() {
        try? FileManager.default.createDirectory(at: Self.root, withIntermediateDirectories: true)
        if pendingProgress.isEmpty {
            try? FileManager.default.removeItem(at: Self.progressFile)
        } else if let d = try? JSONEncoder().encode(pendingProgress) {
            try? d.write(to: Self.progressFile, options: .atomic)
        }
    }
}

/// Background URLSession delegate (system queue). Moves the temp file BEFORE returning, then hops to the store.
final class DownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription else { return }
        if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let status = http.statusCode
            Task { @MainActor in AppModel.shared.offline.didFinish(id: id, bytes: nil, error: "HTTP \(status)") }
            return
        }
        var dest = OfflineStore.fileURL(for: id)
        let fm = FileManager.default
        var bytes: Int64?
        var failure: String?
        do {
            try fm.createDirectory(at: OfflineStore.filesDir, withIntermediateDirectories: true)
            if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
            try fm.moveItem(at: location, to: dest)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? dest.setResourceValues(values)
            bytes = (try? fm.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.int64Value
        } catch {
            failure = error.localizedDescription
        }
        let b = bytes, f = failure
        Task { @MainActor in AppModel.shared.offline.didFinish(id: id, bytes: b, error: f) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription else { return }
        let done = totalBytesWritten, total = totalBytesExpectedToWrite
        Task { @MainActor in AppModel.shared.offline.didWrite(id: id, done: done, total: total) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let error, let id = task.taskDescription else { return }
        if (error as NSError).code == NSURLErrorCancelled { return }
        let msg = error.localizedDescription
        Task { @MainActor in AppModel.shared.offline.didFail(id: id, error: msg) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in AppModel.shared.offline.finishBackgroundEvents() }
    }
}
