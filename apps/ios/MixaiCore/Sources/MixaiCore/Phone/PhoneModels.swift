import Foundation

// Server 3.9.0 phone schemas not emitted by openapi-swift.mjs (it mirrors the Kotlin TV set). Hand-written from
// server/openapi.yaml components (DownloadJob, Bookmark, BookmarkInput, SubtitleHit, ProfileUsage, FamilyStats,
// PlexImportResult, DailyCapError). Optional where an older server may omit the field.

public struct DownloadJob: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable { case queued, running, done, failed }
    public let jobId: String
    public let fileId: String
    public let audio: Int
    public let state: State
    public let progress: Double
    public let error: String?
    public let sizeBytes: Int?
    public let createdAt: Double?
    public let finishedAt: Double?

    public init(jobId: String, fileId: String, audio: Int, state: State, progress: Double, error: String? = nil, sizeBytes: Int? = nil, createdAt: Double? = nil, finishedAt: Double? = nil) {
        self.jobId = jobId
        self.fileId = fileId
        self.audio = audio
        self.state = state
        self.progress = progress
        self.error = error
        self.sizeBytes = sizeBytes
        self.createdAt = createdAt
        self.finishedAt = finishedAt
    }
}

public struct Bookmark: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let profileId: String
    public let titleKey: String
    public let kind: MediaKind?
    public let tmdbId: Int?
    public let season: Int?
    public let episode: Int?
    public let fileId: String?
    public let sec: Double
    public let label: String
    public let shared: Bool
    public let createdAt: Int
    public let mine: Bool?
    public let profileName: String?
}

public struct BookmarkInput: Codable, Sendable, Equatable {
    public var kind: MediaKind?
    public var tmdbId: Int?
    public var season: Int?
    public var episode: Int?
    public var fileId: String?
    public var sec: Double
    public var label: String?
    public var shared: Bool?

    public init(ref: MediaRef?, fileId: String?, sec: Double, label: String?, shared: Bool = false) {
        kind = ref?.kind
        tmdbId = ref?.tmdbId
        season = ref?.season
        episode = ref?.episode
        self.fileId = ref == nil ? fileId : nil
        self.sec = max(0, min(172_800, sec))
        self.label = label.map { String($0.prefix(120)) }
        self.shared = shared
    }

    /// `movie:603`, `tv:1399:s1e2`, `file:<id>` (the server's titleKey for list filtering).
    public static func titleKey(ref: MediaRef?, fileId: String?) -> String? {
        if let r = ref {
            if r.kind == .tv, let s = r.season, let e = r.episode { return "tv:\(r.tmdbId):s\(s)e\(e)" }
            return "\(r.kind.rawValue):\(r.tmdbId)"
        }
        return fileId.map { "file:\($0)" }
    }
}

public struct SubtitleHit: Codable, Sendable, Hashable {
    public let fileId: String
    public let tmdbId: Int?
    public let kind: String?
    public let season: Int?
    public let episode: Int?
    public let title: String
    public let source: String
    public let trackIndex: Int?
    public let trackKey: String
    public let lang: String?
    public let startSec: Double
    public let endSec: Double
    public let text: String
}

public struct SubtitleSearchResult: Codable, Sendable {
    public let q: String
    public let hits: [SubtitleHit]
    public let indexedFiles: Bool?
}

public struct ProfileUsage: Codable, Sendable, Equatable {
    public let profileId: String
    public let day: String
    public let watchMin: Int
    public let listenMin: Int
    public let dailyCapMin: Int?
    public let remainingMin: Int?
    public let overCap: Bool
    public let enforced: Bool
    public let week: WeeklyUsage?
}

public struct FamilyStats: Codable, Sendable, Equatable {
    public struct Row: Codable, Sendable, Equatable, Identifiable {
        public let profileId: String
        public let name: String
        public let kind: String
        public let avatar: String?
        public let color: String?
        public let days: [String]
        public let watchMin: [Int]
        public let listenMin: [Int]
        public let weeklyWatchMin: Int
        public let weeklyListenMin: Int
        public let todayWatchMin: Int
        public let dailyCapMin: Int?
        public let overCap: Bool
        public var id: String { profileId }
    }
    public let generatedAt: Int
    public let profiles: [Row]
}

public struct PlexImportResult: Codable, Sendable, Equatable {
    public let profileId: String
    public let sections: Int
    public let watchedMovies: Int
    public let watchedEpisodes: Int
    public let ratings: Int
    public let watchlist: Int
    public let unmatched: Int
    public let errors: [String]
}

/// 403 body `{error:"daily_cap", profileId, dailyCapMin}` on playback starts of a kid profile over its cap.
public struct DailyCapError: Codable, Sendable, Equatable, Error {
    public let error: String
    public let profileId: String?
    public let dailyCapMin: Int?

    public static func parse(_ e: Error) -> DailyCapError? {
        guard let s = e as? APIStatusError, s.status == 403,
              let v = try? JSON.decoder.decode(DailyCapError.self, from: Data(s.body.utf8)), v.error == "daily_cap" else { return nil }
        return v
    }
}
