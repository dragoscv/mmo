import Foundation

/// Music JSON API (`/media/music/*`, port of `MusicRepository`). Covers + streams are Subsonic URLs with `apiKey`.
public struct MusicStore: Sendable {
    public let client: MmoClient
    public let profile: String

    public init(client: MmoClient, profile: String) {
        self.client = client
        self.profile = profile.isEmpty ? "default" : profile
    }

    private var p: String { MmoClient.enc(profile) }

    public func home() async throws -> MusicHome { try await client.get(MusicHome.self, "/media/music/home?profile=\(p)") }
    public func artist(_ id: String) async throws -> ArtistDetail { try await client.get(ArtistDetail.self, "/media/music/artists/\(MmoClient.enc(id))") }
    public func album(_ id: String) async throws -> AlbumDetail { try await client.get(AlbumDetail.self, "/media/music/albums/\(MmoClient.enc(id))") }
    public func search(_ q: String) async throws -> MusicSearch { try await client.get(MusicSearch.self, "/media/music/search?q=\(MmoClient.enc(q))") }

    public func artists(offset: Int = 0, limit: Int = 200) async throws -> ArtistPage {
        try await client.get(ArtistPage.self, "/media/music/artists?offset=\(offset)&limit=\(limit)")
    }

    /// 404 → nil (no lyrics).
    public func lyrics(_ trackId: String) async throws -> Lyrics? {
        do { return try await client.get(Lyrics.self, "/media/music/lyrics/\(MmoClient.enc(trackId))") } catch let e as APIStatusError where e.status == 404 { return nil }
    }

    public func coverURL(_ path: String?) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        return URL(string: client.withApiKey(path))
    }

    public func streamURL(_ t: TrackCard) -> URL? { URL(string: client.withApiKey(t.streamUrlPath)) }

    public func postPlay(_ t: TrackCard, durationSec: Double, completed: Bool) async {
        let input = TrackPlayInput(profileId: profile, trackKey: t.id, durationSec: durationSec, completed: completed, playedAt: Int(Date().timeIntervalSince1970 * 1000))
        _ = try? await client.request("POST", "/media/plays?profile=\(p)", body: try? JSON.encoder.encode(input))
    }
}

/// Index of the synced lyric line active at `ms` (last line whose time ≤ ms), nil before the first.
public func activeLyricIndex(_ lines: [LyricLine], ms: Int) -> Int? {
    var lo = 0, hi = lines.count - 1, ans: Int?
    while lo <= hi {
        let mid = (lo + hi) / 2
        if lines[mid].timeMs <= ms { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return ans
}
