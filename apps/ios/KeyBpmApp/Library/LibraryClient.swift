import Foundation
import MixaiCore

/// Optional MMO Server link (WP18-05 / WP18-07, port of Android `Library` + `LibraryMatching`): compatible tracks for
/// the live key/BPM, "in your MixAI library" badge after a Song ID match, server file path for M3U8 / rekordbox exports
/// and "Add to MixAI queue". Own lenient Decodables (only the fields used) so a newer server never breaks decoding.
@MainActor @Observable
final class LibraryClient {
    static let shared = LibraryClient()

    private let keychain = KeychainStore(service: "ro.mixai.keybpm")
    private(set) var baseURL: String?
    private(set) var serverName: String?
    @ObservationIgnored private var paths: [String: String] = [:]

    private init() {
        baseURL = keychain.get("server.base")
        serverName = keychain.get("server.name")
    }

    var connected: Bool { client != nil }

    private var client: MmoClient? {
        guard let b = baseURL, let t = keychain.get("server.token"), !t.isEmpty else { return nil }
        return MmoClient(baseURL: b, token: t)
    }

    func connect(name: String, baseURL: String, token: String) {
        keychain.set(MmoClient.normalise(baseURL), for: "server.base")
        keychain.set(name, for: "server.name")
        keychain.set(token, for: "server.token")
        self.baseURL = MmoClient.normalise(baseURL)
        self.serverName = name
    }

    func disconnect() {
        ["server.base", "server.name", "server.token"].forEach(keychain.delete)
        baseURL = nil
        serverName = nil
        paths = [:]
    }

    // MARK: compatible tracks

    struct Track: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let title: String
        let artist: String?
        let album: String?
        let bpm: Double?
        let keyCamelot: String?
        let score: Double?
    }

    private struct Compatible: Decodable { let tracks: [Track] }
    private struct Search: Decodable { let tracks: [Track] }

    func compatible(camelot: String?, bpm: Double?) async throws -> [Track] {
        guard let c = client else { return [] }
        var q = ["limit=30"]
        if let camelot { q.append("key=\(MmoClient.enc(camelot))") }
        if let bpm { q.append("bpm=\(String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), bpm))") }
        let data = try await c.request("GET", "/media/music/compatible?" + q.joined(separator: "&"))
        return try JSONDecoder().decode(Compatible.self, from: data).tracks
    }

    // MARK: Song ID enrichment

    /// Adds the library match (id, key, BPM, server path) to a Shazam result, or returns it unchanged.
    func enrich(_ song: SongMatch) async -> SongMatch {
        guard let c = client else { return song }
        var queries = [[song.artist, song.title].compactMap { $0 }.joined(separator: " ")]
        if song.artist != nil { queries.append(song.title) }
        for q in queries {
            guard let data = try? await c.request("GET", "/media/music/search?q=\(MmoClient.enc(q))"),
                  let hits = try? JSONDecoder().decode(Search.self, from: data).tracks else { continue }
            if let hit = hits.first(where: { LibraryMatching.matches(song.title, song.artist, $0.title, $0.artist) }) {
                var m = song
                m.libraryTrackId = hit.id
                m.libraryCamelot = hit.keyCamelot
                m.libraryBpm = hit.bpm
                m.libraryPath = await filePath(hit.id, client: c)
                return m
            }
        }
        return song
    }

    private struct TrackDetail: Decodable { struct T: Decodable { let filepath: String? }; let track: T? }

    private func filePath(_ id: String, client c: MmoClient) async -> String? {
        if let p = paths[id] { return p }
        let n = id.hasPrefix("tr_") ? String(id.dropFirst(3)) : id
        guard Int(n) != nil, let data = try? await c.request("GET", "/library/tracks/\(n)"),
              let p = try? JSONDecoder().decode(TrackDetail.self, from: data).track?.filepath else { return nil }
        paths[id] = p
        return p
    }

    // MARK: queue

    private struct Queue: Decodable { let trackIds: [String]; let index: Int? }
    private struct QueueBody: Encodable { let trackIds: [String]; let index: Int }

    func addToQueue(trackId: String, profile: String = "default") async -> Bool {
        guard let c = client else { return false }
        let path = "/media/music/queue?profile=\(MmoClient.enc(profile))"
        do {
            let q = try JSONDecoder().decode(Queue.self, from: try await c.request("GET", path))
            let id = trackId.replacingOccurrences(of: "\"", with: "")
            guard !q.trackIds.contains(id) else { return true }
            let body = try JSONEncoder().encode(QueueBody(trackIds: q.trackIds + [id], index: q.index ?? 0))
            _ = try await c.request("PUT", path, body: body)
            return true
        } catch {
            return false
        }
    }

    /// `mixai-music://play?ids=<id>&index=0` (MixAI Music); nil when the id cannot be encoded.
    static func playURL(trackId: String) -> URL? { URL(string: "mixai-music://play?ids=\(MmoClient.enc(trackId))&index=0") }
}

/// Fuzzy title/artist match between a Shazam result and a library track (same rules as Android `LibraryMatching`).
enum LibraryMatching {
    static func normalize(_ s: String) -> String {
        var t = s.lowercased().folding(options: [.diacriticInsensitive], locale: nil)
        for p in [#"\((feat|ft|with)[^)]*\)"#, #"\[(feat|ft|with)[^\]]*\]"#, #"\s(feat|ft)\.?\s.*$"#] {
            t = t.replacingOccurrences(of: p, with: "", options: .regularExpression)
        }
        t = t.replacingOccurrences(of: "[^a-z0-9]+", with: " ", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespaces)
    }

    static func stripMix(_ s: String) -> String {
        s.replacingOccurrences(of: #"\s(original|extended|radio|club)?\s?(mix|edit|version)$"#, with: "", options: .regularExpression)
    }

    static func matches(_ matchTitle: String, _ matchArtist: String?, _ title: String, _ artist: String?) -> Bool {
        let a = normalize(matchTitle), b = normalize(title)
        guard !a.isEmpty, !b.isEmpty, a == b || stripMix(a) == stripMix(b) else { return false }
        let ma = normalize(matchArtist ?? ""), ta = normalize(artist ?? "")
        if ma.isEmpty || ta.isEmpty { return true }
        if ma.contains(ta) || ta.contains(ma) { return true }
        let wa = Set(ma.split(separator: " ").filter { $0.count > 2 }), wb = Set(ta.split(separator: " ").filter { $0.count > 2 })
        return !wa.isDisjoint(with: wb)
    }
}
