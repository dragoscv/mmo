import Foundation

/// One offline music track (original file from `download.view`). Persisted as JSON by the Music app;
/// the bytes live in Application Support/mixai-music/tracks (excluded from backup).
public struct MusicDownload: Codable, Sendable, Hashable, Identifiable {
    public enum State: String, Codable, Sendable { case queued, downloading, done, failed, paused }

    public let track: TrackCard
    public var state: State
    public var bytes: Int64
    public var progress: Double
    public var error: String?
    public let addedAt: Date
    public var finishedAt: Date?
    /// Added automatically for the upcoming queue (removed when no longer upcoming); manual ones stay.
    public var auto: Bool

    public var id: String { track.id }

    public init(track: TrackCard, state: State = .queued, addedAt: Date = .now, auto: Bool = false) {
        self.track = track
        self.state = state
        self.bytes = 0
        self.progress = 0
        self.addedAt = addedAt
        self.auto = auto
    }

    /// File extension for the stored original (keeps the decoder hint right).
    public var fileExtension: String {
        let f = track.format.lowercased()
        return f.isEmpty ? "bin" : String(f.prefix(5).filter { $0.isLetter || $0.isNumber })
    }
}

/// Pure decisions for music downloads (Android parity: Wi-Fi only, upcoming N, storage limit).
public enum MusicOffline {
    /// Storage limit choices in GB (0 = unlimited). Default 2 GB like Android.
    public static let limitChoicesGB = [1, 2, 5, 10, 0]
    public static let defaultLimitGB = 2
    /// "Download upcoming" choices (tracks after the current one).
    public static let upcomingChoices = [0, 5, 10, 25]

    public static func usedBytes(_ items: [MusicDownload]) -> Int64 {
        items.reduce(0) { $0 + ($1.state == .done ? $1.bytes : 0) }
    }

    /// Album download state for a badge: all done / some / none.
    public enum Coverage: Sendable, Equatable { case none, partial(Int, Int), all }

    public static func coverage(of tracks: [TrackCard], in items: [MusicDownload]) -> Coverage {
        guard !tracks.isEmpty else { return .none }
        let done = Set(items.filter { $0.state == .done }.map(\.id))
        let n = tracks.filter { done.contains($0.id) }.count
        if n == 0 { return .none }
        return n == tracks.count ? .all : .partial(n, tracks.count)
    }

    /// Auto downloads to drop so `used + incoming` fits under `limitBytes` (oldest auto first; manual never).
    public static func evictions(_ items: [MusicDownload], incoming: Int64, limitBytes: Int64) -> [String] {
        guard limitBytes > 0 else { return [] }
        var used = usedBytes(items) + incoming
        guard used > limitBytes else { return [] }
        var out: [String] = []
        for i in items.filter({ $0.auto && $0.state == .done }).sorted(by: { $0.addedAt < $1.addedAt }) {
            out.append(i.id)
            used -= i.bytes
            if used <= limitBytes { break }
        }
        return out
    }

    /// Upcoming tracks to fetch (next `count` after the current one not yet stored), and auto downloads that are
    /// no longer upcoming (to remove).
    public static func upcomingPlan(queue: PlayQueue, count: Int, items: [MusicDownload]) -> (fetch: [TrackCard], drop: [String]) {
        guard count > 0 else { return ([], items.filter { $0.auto }.map(\.id)) }
        let window = Array(queue.upcoming.prefix(count))
        let windowIds = Set(window.map(\.id)).union(queue.current.map { [$0.id] } ?? [])
        let have = Set(items.map(\.id))
        let fetch = window.filter { !have.contains($0.id) }
        let drop = items.filter { $0.auto && $0.state == .done && !windowIds.contains($0.id) }.map(\.id)
        return (fetch, drop)
    }

    /// Safe file name for a track id (ids look like `tr_12`).
    public static func fileName(id: String, ext: String) -> String {
        let safe = String(id.unicodeScalars.map { ($0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_")) ? Character($0) : "_" })
        return "\(safe).\(ext)"
    }
}
