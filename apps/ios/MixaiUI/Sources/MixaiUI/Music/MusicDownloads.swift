import Foundation
import MixaiCore
import Network
import Observation

/// Offline music (MixAI Music): original files via Subsonic `download.view` → background URLSession →
/// Application Support/mixai-music/tracks (excluded from iCloud backup). Wi-Fi only (default on), storage limit
/// (default 2 GB, oldest automatic downloads evicted first), "download upcoming" N tracks of the queue.
@MainActor
@Observable
public final class MusicDownloads {
    public nonisolated static let sessionId = "ro.mixai.music.downloads"

    public private(set) var items: [MusicDownload] = []
    public var wifiOnly: Bool = UserDefaults.standard.object(forKey: "dl.wifiOnly") as? Bool ?? true {
        didSet { UserDefaults.standard.set(wifiOnly, forKey: "dl.wifiOnly"); pump() }
    }
    public var limitGB: Int = UserDefaults.standard.object(forKey: "dl.limitGB") as? Int ?? MusicOffline.defaultLimitGB {
        didSet { UserDefaults.standard.set(limitGB, forKey: "dl.limitGB"); enforceLimit(incoming: 0) }
    }
    public var upcomingCount: Int = UserDefaults.standard.object(forKey: "dl.upcoming") as? Int ?? 0 {
        didSet { UserDefaults.standard.set(upcomingCount, forKey: "dl.upcoming") }
    }
    public private(set) var expensiveNetwork = false

    @ObservationIgnored public var store: (() -> MusicStore?)?
    @ObservationIgnored public var backgroundEventsHandler: (() -> Void)?
    @ObservationIgnored private var session: URLSession?
    @ObservationIgnored private let monitor = NWPathMonitor()
    /// Max parallel transfers (the background session also throttles).
    private let parallel = 3

    public init() {
        items = (try? Data(contentsOf: Self.indexFile)).flatMap { try? JSONDecoder().decode([MusicDownload].self, from: $0) } ?? []
        // Files gone (OS purge / restore from backup): drop their rows.
        items.removeAll { $0.state == .done && !FileManager.default.fileExists(atPath: Self.fileURL(for: $0).path) }
        for i in items.indices where items[i].state == .downloading { items[i].state = .queued }
        monitor.pathUpdateHandler = { @Sendable path in
            let expensive = path.isExpensive || path.isConstrained
            Task { @MainActor [weak self] in self?.networkChanged(expensive: expensive) }
        }
        monitor.start(queue: DispatchQueue(label: "ro.mixai.music.dlpath"))
        ensureSession()
    }

    // MARK: paths

    public nonisolated static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("mixai-music", isDirectory: true)
    }
    nonisolated static var filesDir: URL { root.appendingPathComponent("tracks", isDirectory: true) }
    nonisolated static var indexFile: URL { root.appendingPathComponent("downloads.json") }

    public nonisolated static func fileURL(for d: MusicDownload) -> URL {
        filesDir.appendingPathComponent(MusicOffline.fileName(id: d.id, ext: d.fileExtension))
    }

    // MARK: queries

    public func localURL(trackId: String) -> URL? {
        guard let d = items.first(where: { $0.id == trackId && $0.state == .done }) else { return nil }
        let u = Self.fileURL(for: d)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    public func state(_ trackId: String) -> MusicDownload.State? { items.first { $0.id == trackId }?.state }
    public func coverage(_ tracks: [TrackCard]) -> MusicOffline.Coverage { MusicOffline.coverage(of: tracks, in: items) }
    public var usedBytes: Int64 { MusicOffline.usedBytes(items) }
    public var doneTracks: [TrackCard] { items.filter { $0.state == .done }.sorted { $0.addedAt > $1.addedAt }.map(\.track) }
    public var active: [MusicDownload] { items.filter { $0.state != .done } }
    public var limitBytes: Int64 { Int64(limitGB) * 1_000_000_000 }
    public var waitingForWifi: Bool { wifiOnly && expensiveNetwork && items.contains { $0.state == .queued || $0.state == .paused } }

    // MARK: actions

    public func download(_ tracks: [TrackCard], auto: Bool = false) {
        var changed = false
        for t in tracks {
            if let i = items.firstIndex(where: { $0.id == t.id }) {
                if items[i].state == .failed { items[i].state = .queued; items[i].error = nil; changed = true }
                if !auto && items[i].auto { items[i].auto = false; changed = true }
                continue
            }
            items.append(MusicDownload(track: t, auto: auto))
            changed = true
        }
        if changed { persist(); pump() }
    }

    public func remove(_ trackIds: [String]) {
        drop(trackIds)
        pump()
    }

    /// Cancels transfers and deletes files + rows (no pump: safe to call from inside it).
    private func drop(_ trackIds: [String]) {
        let ids = Set(trackIds)
        guard !ids.isEmpty else { return }
        session?.getAllTasks { @Sendable tasks in for t in tasks where ids.contains(t.taskDescription ?? "") { t.cancel() } }
        for d in items where ids.contains(d.id) { try? FileManager.default.removeItem(at: Self.fileURL(for: d)) }
        items.removeAll { ids.contains($0.id) }
        persist()
    }

    public func removeAll() {
        session?.getAllTasks { @Sendable tasks in tasks.forEach { $0.cancel() } }
        try? FileManager.default.removeItem(at: Self.filesDir)
        items = []
        persist()
    }

    /// Keep the next N queue tracks offline while playing (setting "Download upcoming").
    public func syncUpcoming(queue: PlayQueue) {
        let plan = MusicOffline.upcomingPlan(queue: queue, count: upcomingCount, items: items)
        if !plan.drop.isEmpty { remove(plan.drop) }
        if !plan.fetch.isEmpty { download(plan.fetch, auto: true) }
    }

    // MARK: pipeline

    func ensureSession() {
        guard session == nil else { return }
        let cfg = URLSessionConfiguration.background(withIdentifier: Self.sessionId)
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        session = URLSession(configuration: cfg, delegate: MusicDownloadDelegate(owner: self), delegateQueue: nil)
        session?.getAllTasks { @Sendable tasks in
            let live = Set(tasks.compactMap(\.taskDescription))
            Task { @MainActor [weak self] in self?.reconcile(live: live) }
        }
    }

    private func reconcile(live: Set<String>) {
        for i in items.indices where items[i].state == .downloading && !live.contains(items[i].id) { items[i].state = .queued }
        pump()
    }

    private func networkChanged(expensive: Bool) {
        expensiveNetwork = expensive
        pump()
    }

    private func pump() {
        let blocked = wifiOnly && expensiveNetwork
        for i in items.indices {
            if blocked, items[i].state == .queued { items[i].state = .paused }
            if !blocked, items[i].state == .paused { items[i].state = .queued }
        }
        guard !blocked, let store = store?() else { persist(); return }
        var running = items.filter { $0.state == .downloading }.count
        for id in items.filter({ $0.state == .queued }).map(\.id) where running < parallel {
            guard let url = store.downloadURL(id), items.contains(where: { $0.id == id }) else { continue }
            let t = items.first { $0.id == id }!.track
            // Subsonic bitrate is kbit/s → bytes ≈ kbps × 125 × seconds.
            let incoming = Int64((t.bitrate ?? 0) * 125) * Int64(t.durationSec)
            enforceLimit(incoming: incoming)
            guard let i = items.firstIndex(where: { $0.id == id }) else { continue }
            if limitBytes > 0 && usedBytes + incoming > limitBytes && !items[i].auto {
                items[i].state = .failed
                items[i].error = String(localized: "music.dl.limit_reached")
                continue
            }
            var req = URLRequest(url: url)
            req.allowsCellularAccess = !wifiOnly
            req.allowsExpensiveNetworkAccess = !wifiOnly
            req.allowsConstrainedNetworkAccess = !wifiOnly
            guard let task = session?.downloadTask(with: req) else { continue }
            task.taskDescription = items[i].id
            if incoming > 0 { task.countOfBytesClientExpectsToReceive = incoming }
            items[i].state = .downloading
            items[i].progress = 0
            task.resume()
            running += 1
        }
        persist()
    }

    private func enforceLimit(incoming: Int64) {
        drop(MusicOffline.evictions(items, incoming: incoming, limitBytes: limitBytes))
    }

    // MARK: delegate callbacks

    func didWrite(id: String, done: Int64, total: Int64) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].bytes = done
        items[i].progress = total > 0 ? Double(done) / Double(total) : 0
    }

    func didFinish(id: String, bytes: Int64?, error: String?) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        if let error {
            items[i].state = .failed
            items[i].error = error
        } else {
            items[i].state = .done
            items[i].progress = 1
            items[i].bytes = bytes ?? items[i].bytes
            items[i].finishedAt = .now
            items[i].error = nil
        }
        persist()
        pump()
    }

    func finishBackgroundEvents() {
        backgroundEventsHandler?()
        backgroundEventsHandler = nil
    }

    func target(for id: String) -> URL? { items.first { $0.id == id }.map(Self.fileURL(for:)) }

    private func persist() {
        try? FileManager.default.createDirectory(at: Self.root, withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(items) { try? d.write(to: Self.indexFile, options: .atomic) }
    }
}

/// Background session delegate (system queue): moves the temp file BEFORE returning, then hops to the store.
final class MusicDownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private weak var owner: MusicDownloads?

    init(owner: MusicDownloads) { self.owner = owner }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription else { return }
        let owner = self.owner
        if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let status = http.statusCode
            Task { @MainActor in owner?.didFinish(id: id, bytes: nil, error: "HTTP \(status)") }
            return
        }
        // Temp file must move synchronously; the target name only needs the id + extension.
        let staged = MusicDownloads.filesDir.appendingPathComponent("\(MusicOffline.fileName(id: id, ext: "part"))")
        var failure: String?
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: MusicDownloads.filesDir, withIntermediateDirectories: true)
            if fm.fileExists(atPath: staged.path) { try fm.removeItem(at: staged) }
            try fm.moveItem(at: location, to: staged)
        } catch {
            failure = error.localizedDescription
        }
        let f = failure
        Task { @MainActor in
            guard let owner else { return }
            if let f { owner.didFinish(id: id, bytes: nil, error: f); return }
            guard let dest = owner.target(for: id) else { try? fm.removeItem(at: staged); return }
            do {
                if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
                try fm.moveItem(at: staged, to: dest)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                var d = dest
                try? d.setResourceValues(values)
                let bytes = (try? fm.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.int64Value
                owner.didFinish(id: id, bytes: bytes, error: nil)
            } catch {
                owner.didFinish(id: id, bytes: nil, error: error.localizedDescription)
            }
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription else { return }
        let owner = self.owner, done = totalBytesWritten, total = totalBytesExpectedToWrite
        Task { @MainActor in owner?.didWrite(id: id, done: done, total: total) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let error, let id = task.taskDescription, (error as NSError).code != NSURLErrorCancelled else { return }
        let owner = self.owner, msg = error.localizedDescription
        Task { @MainActor in owner?.didFinish(id: id, bytes: nil, error: msg) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let owner = self.owner
        Task { @MainActor in owner?.finishBackgroundEvents() }
    }
}
