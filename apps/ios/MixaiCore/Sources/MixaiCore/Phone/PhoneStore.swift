import Foundation

/// Phone-only server calls (server 3.9.0, WP16-50): downloads, bookmarks, subtitle search, usage/caps, family stats,
/// Plex import, Watch Together rooms (HTTP side).
public struct PhoneStore: Sendable {
    public let client: MmoClient
    public let profile: String

    public init(client: MmoClient, profile: String) {
        self.client = client
        self.profile = profile.isEmpty ? "default" : profile
    }

    private var p: String { MmoClient.enc(profile) }

    // MARK: downloads (`GET /video/download/{id}?container=mp4&audio=n` → 202 job | 200 bytes)

    public enum DownloadPrep: Sendable, Equatable {
        /// Cached on the server: download this URL (Range-capable).
        case ready(url: String, sizeBytes: Int?)
        case preparing(DownloadJob, retryAfterSec: Int)
        case failed(String)
    }

    /// Absolute URL a background URLSession can fetch (token + viewer profile in the query; no headers needed).
    public func downloadURL(fileId: String, audio: Int) -> String {
        client.withToken("/video/download/\(MmoClient.enc(fileId))?container=mp4&audio=\(audio)&profile=\(p)")
    }

    /// Asks the server for the MP4 remux; does not download bytes (`/status` answers JSON for a cached file too).
    public func prepareDownload(fileId: String, audio: Int) async throws -> DownloadPrep {
        let statusPath = "/video/download/\(MmoClient.enc(fileId))/status?audio=\(audio)"
        if let job = try? await client.get(DownloadJob.self, statusPath), job.state == .done {
            return .ready(url: downloadURL(fileId: fileId, audio: audio), sizeBytes: job.sizeBytes)
        }
        // HEAD-like kick: a ranged GET of 1 byte starts the remux (202) or proves it is cached (206/200).
        guard let url = URL(string: downloadURL(fileId: fileId, audio: audio)) else { throw URLError(.badURL) }
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        let res = try await URLSessionTransport.shared.send(req, followRedirects: true)
        return try Self.interpretKick(status: res.status, body: res.body, retryAfter: res.header("Retry-After"), readyURL: downloadURL(fileId: fileId, audio: audio))
    }

    public func downloadStatus(fileId: String, audio: Int) async throws -> DownloadJob {
        try await client.get(DownloadJob.self, "/video/download/\(MmoClient.enc(fileId))/status?audio=\(audio)")
    }

    /// Pure mapping of the kick answer (unit-tested).
    public static func interpretKick(status: Int, body: Data, retryAfter: String?, readyURL: String) throws -> DownloadPrep {
        switch status {
        case 200, 206:
            return .ready(url: readyURL, sizeBytes: nil)
        case 202:
            let job = try JSON.decoder.decode(DownloadJob.self, from: body)
            return .preparing(job, retryAfterSec: max(1, Int(retryAfter ?? "") ?? 3))
        case 500:
            let job = try? JSON.decoder.decode(DownloadJob.self, from: body)
            return .failed(job?.error ?? "remux_failed")
        default:
            throw APIStatusError(status: status, body: String(decoding: body.prefix(200), as: UTF8.self))
        }
    }

    // MARK: bookmarks

    public func bookmarks(titleKey: String?) async throws -> [Bookmark] {
        var path = "/media/bookmarks?profile=\(p)"
        if let titleKey { path += "&titleKey=\(MmoClient.enc(titleKey))" }
        return try await client.get(BookmarkList.self, path).bookmarks
    }

    @discardableResult
    public func addBookmark(_ b: BookmarkInput) async throws -> Bookmark {
        try await client.send(BookmarkEnvelope.self, "POST", "/media/bookmarks?profile=\(p)", b).bookmark
    }

    public func deleteBookmark(_ id: String) async throws {
        try await client.call("DELETE", "/media/bookmarks/\(MmoClient.enc(id))?profile=\(p)")
    }

    // MARK: subtitle search

    public func searchSubtitles(_ q: String, fileId: String?) async throws -> SubtitleSearchResult {
        var path = "/media/subtitles/search?q=\(MmoClient.enc(q))&profile=\(p)"
        if let fileId { path += "&fileId=\(MmoClient.enc(fileId))" }
        return try await client.get(SubtitleSearchResult.self, path)
    }

    public func indexSubtitles(fileId: String) async throws {
        _ = try await client.request("POST", "/media/subtitles/index", body: try JSON.encoder.encode(["fileId": fileId]))
    }

    // MARK: usage / caps / family

    public func usage(profileId: String) async throws -> ProfileUsage {
        try await client.get(ProfileUsage.self, "/media/profiles/\(MmoClient.enc(profileId))/usage")
    }

    public func familyStats() async throws -> FamilyStats {
        try await client.get(FamilyStats.self, "/media/stats/family")
    }

    // MARK: Plex importer (token used once by the server, never stored)

    public func importPlex(serverUrl: String, token: String) async throws -> PlexImportResult {
        try await client.send(PlexImportResult.self, "POST", "/media/import/plex", ["serverUrl": serverUrl, "token": token, "profileId": profile])
    }

    // MARK: Watch Together (HTTP)

    public func createRoom(name: String?) async throws -> CreatedRoom {
        try await client.send(CreatedRoom.self, "POST", "/hub/rooms", ["name": name ?? ""])
    }

    public func hubDevices() async throws -> [HubDevice] {
        try await client.get(HubDeviceList.self, "/hub/devices").devices
    }

    /// HTTP remote fallback (`POST /hub/command`, waits for the device ack up to 4 s).
    public func command(target: String, action: String, args: [String: JSONValue] = [:]) async throws -> HubAck {
        let body: [String: JSONValue] = ["target": .string(target), "action": .string(action), "args": .object(args)]
        let data = try await client.request("POST", "/hub/command", body: try JSON.encoder.encode(JSONValue.object(body)), timeout: 8)
        return try JSON.decoder.decode(HubAck.self, from: data)
    }
}

public struct CreatedRoom: Codable, Sendable, Equatable {
    public let roomId: String
    public let invite: String
}

struct BookmarkList: Codable, Sendable { let bookmarks: [Bookmark] }
struct BookmarkEnvelope: Codable, Sendable { let bookmark: Bookmark }
struct HubDeviceList: Codable, Sendable { let devices: [HubDevice] }

/// Web guest link for a room (`/together?server=&inv=`) — same as the TV QR codes.
public func togetherInviteURL(origin: String, serverBaseURL: String, invite: String) -> URL? {
    var c = URLComponents(string: origin.hasSuffix("/") ? String(origin.dropLast()) + "/together" : origin + "/together")
    c?.queryItems = [URLQueryItem(name: "server", value: serverBaseURL), URLQueryItem(name: "inv", value: invite)]
    return c?.url
}

/// `mixai://together?server=&inv=` or the web link → (server, invite).
public func parseTogetherLink(_ url: URL) -> (server: String, invite: String)? {
    guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    let isTogether = (url.scheme == "mixai" && url.host == "together") || c.path.hasSuffix("/together")
    guard isTogether,
          let inv = c.queryItems?.first(where: { $0.name == "inv" })?.value, !inv.isEmpty,
          let srv = c.queryItems?.first(where: { $0.name == "server" })?.value, !srv.isEmpty else { return nil }
    return (srv, inv)
}

/// Room id inside an invite `<roomId>.<exp>.<mac>`.
public func roomId(fromInvite invite: String) -> String? {
    let parts = invite.split(separator: ".")
    return parts.count == 3 ? String(parts[0]) : nil
}
