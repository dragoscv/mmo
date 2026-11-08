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

    /// Artists A–Z; `letter` = initial (`#` for non-letters as the server defines it).
    public func artists(letter: String? = nil, offset: Int = 0, limit: Int = 200) async throws -> ArtistPage {
        var path = "/media/music/artists?offset=\(offset)&limit=\(limit)"
        if let letter, !letter.isEmpty { path += "&letter=\(MmoClient.enc(letter))" }
        return try await client.get(ArtistPage.self, path)
    }

    /// Albums A–Z (paged, optional first letter).
    public func albums(letter: String? = nil, offset: Int = 0, limit: Int = 100) async throws -> AlbumPage {
        var path = "/media/music/albums?offset=\(offset)&limit=\(limit)"
        if let letter, !letter.isEmpty { path += "&letter=\(MmoClient.enc(letter))" }
        return try await client.get(AlbumPage.self, path)
    }

    /// `GET /media/music/playlists` (server 3.10+).
    public func playlists() async throws -> [PlaylistCard] {
        try await client.get(PlaylistList.self, "/media/music/playlists").playlists
    }

    /// Playlist tracks in order (server 3.10+).
    public func playlistTracks(_ id: String) async throws -> [TrackCard] {
        try await client.get(TrackList.self, "/media/music/playlists/\(MmoClient.enc(id))").tracks
    }

    /// `GET /media/music/random?size=` (1..500): shuffle-all / "Start a mix" without a seed.
    public func random(size: Int = 50) async throws -> [TrackCard] {
        try await client.get(TrackList.self, "/media/music/random?size=\(min(500, max(1, size)))").tracks
    }

    /// `GET /media/music/radio?seed=tr_|al_|ar_&size=` — a track seed comes first.
    public func radio(seed: String, size: Int = 50) async throws -> [TrackCard] {
        try await client.get(TrackList.self, "/media/music/radio?seed=\(MmoClient.enc(seed))&size=\(min(200, max(1, size)))").tracks
    }

    /// Tracks by id in the requested order (server ≥ 3.12; older servers return a page, filtered to the asked ids).
    public func tracks(ids: [String]) async throws -> [TrackCard] {
        var out: [TrackCard] = []
        var start = 0
        while start < ids.count {
            let chunk = Array(ids[start..<min(ids.count, start + 200)])
            start += 200
            let page = try await client.get(AlbumTrackPage.self, "/media/music/tracks?ids=\(MmoClient.enc(chunk.joined(separator: ",")))")
            let byId = Dictionary(page.items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            out += chunk.compactMap { byId[$0] }
        }
        return out
    }

    public func queue() async throws -> MusicQueue { try await client.get(MusicQueue.self, "/media/music/queue?profile=\(p)") }

    @discardableResult
    public func putQueue(_ input: MusicQueueInput) async throws -> MusicQueue {
        try await client.send(MusicQueue.self, "PUT", "/media/music/queue?profile=\(p)", input)
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

    /// Server-converted stream (server 3.12 `format=`) for files the device cannot decode (e.g. Opus in Ogg, WMA).
    public func streamURL(_ t: TrackCard, format: String) -> URL? {
        URL(string: client.withApiKey(t.streamUrlPath + (t.streamUrlPath.contains("?") ? "&" : "?") + "format=\(MmoClient.enc(format))"))
    }

    /// Original file (Subsonic `download.view`) for offline copies.
    public func downloadURL(_ trackId: String) -> URL? {
        URL(string: client.withApiKey("/rest/download.view?id=\(MmoClient.enc(trackId))"))
    }

    /// Formats the iOS decoders play natively; anything else streams as MP3 from the server.
    public static let nativeFormats: Set<String> = ["mp3", "m4a", "aac", "alac", "flac", "wav", "aif", "aiff", "caf", "mp4"]

    public static func needsConversion(_ t: TrackCard) -> Bool { !nativeFormats.contains(t.format.lowercased()) }

    public func postPlay(_ t: TrackCard, durationSec: Double, completed: Bool) async {
        let input = TrackPlayInput(profileId: profile, trackKey: t.id, durationSec: durationSec, completed: completed, playedAt: Int(Date().timeIntervalSince1970 * 1000))
        _ = try? await client.request("POST", "/media/plays?profile=\(p)", body: try? JSON.encoder.encode(input))
    }
}

public struct AlbumPage: Codable, Sendable, Hashable {
    public let total: Int
    public let offset: Int
    public let limit: Int
    public let items: [AlbumCard]
}

struct PlaylistList: Decodable { let playlists: [PlaylistCard] }
struct TrackList: Decodable { let tracks: [TrackCard] }
struct AlbumTrackPage: Decodable { let items: [TrackCard] }

/// Index of the synced lyric line active at `ms` (last line whose time ≤ ms), nil before the first.
public func activeLyricIndex(_ lines: [LyricLine], ms: Int) -> Int? {
    var lo = 0, hi = lines.count - 1, ans: Int?
    while lo <= hi {
        let mid = (lo + hi) / 2
        if lines[mid].timeMs <= ms { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return ans
}
