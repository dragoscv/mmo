import Foundation

/// One offline download (persisted as JSON by the app; bytes live in Application Support/downloads).
public struct DownloadItem: Codable, Sendable, Hashable, Identifiable {
    public enum State: String, Codable, Sendable { case queued, preparing, downloading, done, failed, paused }

    public let fileId: String
    public let audio: Int
    public var ref: MediaRef?
    public var title: String
    /// Show name for episodes (grouping key), nil for movies.
    public var show: String?
    public var posterPath: String?
    public var state: State
    public var progress: Double
    public var bytesTotal: Int64
    public var bytesDone: Int64
    public var localFile: String?
    public var error: String?
    public var addedAt: Date
    public var finishedAt: Date?
    /// When playback reached the end (auto-delete clock).
    public var watchedAt: Date?
    /// Last offline position (seconds) for resume without the server.
    public var positionSec: Double?
    public var durationSec: Double?
    /// Added by smart downloads (auto-deleted when watched).
    public var smart: Bool

    public var id: String { Self.key(fileId: fileId, audio: audio) }
    public static func key(fileId: String, audio: Int) -> String { "\(fileId)#\(audio)" }

    public init(fileId: String, audio: Int = 0, ref: MediaRef?, title: String, show: String? = nil, posterPath: String? = nil,
                state: State = .queued, addedAt: Date = .now, smart: Bool = false) {
        self.fileId = fileId
        self.audio = audio
        self.ref = ref
        self.title = title
        self.show = show
        self.posterPath = posterPath
        self.state = state
        self.progress = 0
        self.bytesTotal = 0
        self.bytesDone = 0
        self.addedAt = addedAt
        self.smart = smart
    }
}

/// A section of the offline library: one movie, or one show with seasons.
public struct OfflineGroup: Sendable, Hashable, Identifiable {
    public struct Season: Sendable, Hashable, Identifiable {
        public let number: Int
        public let items: [DownloadItem]
        public var id: Int { number }
    }
    public let id: String
    public let title: String
    public let posterPath: String?
    public let seasons: [Season]
    public let bytes: Int64
    public var isShow: Bool { seasons.count > 1 || seasons.first?.number ?? 0 > 0 }
}

public enum OfflineLibrary {
    /// Movies one group each; episodes grouped by show (tmdbId) then season, sorted by episode.
    public static func group(_ items: [DownloadItem]) -> [OfflineGroup] {
        var order: [String] = []
        var buckets: [String: [DownloadItem]] = [:]
        for i in items.sorted(by: { $0.addedAt > $1.addedAt }) {
            let key: String
            if let r = i.ref, r.kind == .tv { key = "tv-\(r.tmdbId)" } else { key = "f-\(i.id)" }
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(i)
        }
        return order.map { key in
            let list = buckets[key]!
            let bySeason = Dictionary(grouping: list) { $0.ref?.season ?? 0 }
            let seasons = bySeason.keys.sorted().map { s in
                OfflineGroup.Season(number: s, items: bySeason[s]!.sorted { ($0.ref?.episode ?? 0) < ($1.ref?.episode ?? 0) })
            }
            let first = list[0]
            return OfflineGroup(id: key, title: first.show ?? first.title, posterPath: first.posterPath, seasons: seasons,
                                bytes: list.reduce(0) { $0 + ($1.state == .done ? $1.bytesTotal : $1.bytesDone) })
        }
    }

    /// Watched downloads older than `after` (default 24 h) → delete; only `smart` ones unless `all`.
    public static func expired(_ items: [DownloadItem], now: Date, after: TimeInterval = 24 * 3600, all: Bool) -> [DownloadItem] {
        items.filter { i in
            guard i.state == .done, let w = i.watchedAt, now.timeIntervalSince(w) >= after else { return false }
            return all || i.smart
        }
    }

    /// Episodes to fetch next for a show: the `count` episodes after the last watched/downloaded one that are not
    /// downloaded yet. `available` = (season, episode, fileId) from the server, any order.
    public static func nextEpisodes(available: [(season: Int, episode: Int, fileId: String)], watchedUpTo: (season: Int, episode: Int)?,
                                    have: Set<String>, count: Int = 3) -> [(season: Int, episode: Int, fileId: String)] {
        let sorted = available.filter { $0.season > 0 }.sorted { ($0.season, $0.episode) < ($1.season, $1.episode) }
        let after = sorted.filter { e in
            guard let w = watchedUpTo else { return true }
            return (e.season, e.episode) > (w.season, w.episode)
        }
        return Array(after.filter { !have.contains($0.fileId) }.prefix(count))
    }

    /// Storage gauge: used by MixAI vs free on the device (bytes).
    public static func gauge(items: [DownloadItem], freeBytes: Int64) -> (used: Int64, free: Int64, fraction: Double) {
        let used = items.reduce(Int64(0)) { $0 + ($1.state == .done ? $1.bytesTotal : $1.bytesDone) }
        let total = used + max(0, freeBytes)
        return (used, max(0, freeBytes), total > 0 ? Double(used) / Double(total) : 0)
    }
}

/// Offline progress written while the server is unreachable; flushed by `ProgressSync` on the next success.
public struct OfflineProgressEntry: Codable, Sendable, Hashable {
    public let ref: MediaRef
    public let positionSec: Double
    public let durationSec: Double
    public let at: Date
    public init(ref: MediaRef, positionSec: Double, durationSec: Double, at: Date) {
        self.ref = ref
        self.positionSec = positionSec
        self.durationSec = durationSec
        self.at = at
    }
}
