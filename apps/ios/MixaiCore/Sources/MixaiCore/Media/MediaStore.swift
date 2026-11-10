import Foundation

/// `/media/*` calls other than home (port of `MediaRepository`). `profile` = active viewer profile id.
public struct MediaStore: Sendable {
    public let client: MmoClient
    public let profile: String

    public init(client: MmoClient, profile: String) {
        self.client = client
        self.profile = profile.isEmpty ? "default" : profile
    }

    private var p: String { MmoClient.enc(profile) }

    public func title(kind: MediaKind, tmdbId: Int) async throws -> MediaTitleResponse {
        try await client.get(MediaTitleResponse.self, "/media/title/\(kind.rawValue)/\(tmdbId)?profile=\(p)")
    }

    public func season(tmdbId: Int, number: Int) async throws -> MediaSeasonResponse {
        try await client.get(MediaSeasonResponse.self, "/media/title/tv/\(tmdbId)/season/\(number)?profile=\(p)")
    }

    /// The profile decides what a search may return (a kid profile gets nothing above its age limit): without it
    /// the server answers for the unrestricted default profile.
    public func search(_ q: String, page: Int = 1) async throws -> MediaSearchPage {
        try await client.get(MediaSearchPage.self, "/media/search?q=\(MmoClient.enc(q))&page=\(page)&profile=\(p)")
    }

    /// Server 3.15+ returns only the files of titles this profile may watch; older servers ignore `profile`.
    public func library() async throws -> LibraryIndex {
        try await client.get(LibraryIndex.self, "/media/library?profile=\(p)")
    }

    public func progress() async throws -> ProgressList {
        try await client.get(ProgressList.self, "/media/progress?profile=\(p)")
    }

    /// Batch upsert (1..500). Returns the new server revision (-1 unknown).
    @discardableResult
    public func putProgress(_ list: [ProgressInput]) async throws -> Int {
        guard !list.isEmpty else { return -1 }
        let ans = try await client.send(RevisionAnswer.self, "PUT", "/media/progress?profile=\(p)", Array(list.prefix(500)))
        return ans.revision ?? -1
    }

    public func watchlist() async throws -> WatchlistPage {
        try await client.get(WatchlistPage.self, "/media/watchlist?profile=\(p)")
    }

    public func setWatchlist(kind: MediaKind, tmdbId: Int, on: Bool) async throws {
        let path = "/media/watchlist/\(kind.rawValue)/\(tmdbId)?profile=\(p)"
        if on { try await client.call("PUT", path, body: Data("{}".utf8)) } else { try await client.call("DELETE", path) }
    }

    /// Intro / recap span (absolute seconds) or nil.
    public func marker(_ kind: String, fileId: String) async -> ClosedRange<Double>? {
        guard let s = try? await client.get(MarkerSpan.self, "/video/\(kind)/\(MmoClient.enc(fileId))"),
              let a = s.start, let b = s.end, b > a else { return nil }
        return a...b
    }

    public func creditsStart(fileId: String) async -> Double? {
        guard let s = try? await client.get(MarkerSpan.self, "/video/credits/\(MmoClient.enc(fileId))"), let a = s.start, a > 0 else { return nil }
        return a
    }

    public func fileInfo(fileId: String) async throws -> VideoFile {
        try await client.get(VideoFile.self, "/video/file/\(MmoClient.enc(fileId))/info")
    }
}

/// TMDB image sizes the server proxy accepts (port of `TmdbSize`).
public enum TmdbSize {
    public static func poster(_ px: Int) -> String { [(185, "w185"), (342, "w342"), (500, "w500"), (780, "w780")].first { $0.0 >= px }?.1 ?? "w780" }
    public static func backdrop(_ px: Int) -> String { [(300, "w300"), (780, "w780"), (1280, "w1280")].first { $0.0 >= px }?.1 ?? "w1280" }
}
