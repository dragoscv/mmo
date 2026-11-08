import Foundation
import Synchronization

/// HTTP status outside 2xx (message = first 200 chars of the body).
public struct APIStatusError: LocalizedError, Sendable, CustomStringConvertible {
    public let status: Int
    public let body: String
    public init(status: Int, body: String) { self.status = status; self.body = body }
    public var description: String { "HTTP \(status): \(body)" }
    /// Shown by `error.localizedDescription` (was the opaque "error 1").
    public var errorDescription: String? {
        status == 401 ? String(localized: "error.unauthorized") : "HTTP \(status)"
    }
}

/// Codecs AVPlayer plays on iPhone (server copies these, converts only the rest; hvc1 tagged by the server).
public let iosPlaybackCaps = "h264,hevc,aac,ac3,eac3,mp3,flac,alac,opus"

/// Thin client for one MMO Server (port of tv-android `MmoApi`).
///
/// Auth: `x-device-token` header on JSON calls; `?t=<token>` on media URLs (AVPlayer loads those itself);
/// Subsonic URLs carry the token as `apiKey`. `x-profile-token` of the unlocked profile rides on every
/// authenticated JSON call via [setProfileToken].
public final class MmoClient: Sendable {
    public let baseURL: String
    private let token: String
    private let transport: any HTTPTransport
    private let profileToken = Mutex<String>("")

    public init(baseURL: String, token: String, transport: any HTTPTransport = URLSessionTransport.shared) {
        self.baseURL = MmoClient.normalise(baseURL)
        self.token = token
        self.transport = transport
    }

    /// `host:port` / `http://host:port/` → `http://host:port` (no trailing slash; http when no scheme).
    public static func normalise(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    public var hasToken: Bool { !token.isEmpty }

    public func setProfileToken(_ value: String) { profileToken.withLock { $0 = value } }

    /// Headers a media loader must send where `?t=` is not accepted (`/livetv/stream`).
    public var authHeaders: [String: String] { ["x-device-token": token] }

    // MARK: URLs

    public static func enc(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        // `alphanumerics` includes non-ASCII letters; restrict to ASCII so the result is a valid URL component.
        return s.unicodeScalars.map { u in
            if u.isASCII, allowed.contains(u) { return String(u) }
            return String(u).utf8.map { String(format: "%%%02X", $0) }.joined()
        }.joined()
    }

    private func join(_ path: String, _ query: String) -> String {
        baseURL + path + (path.contains("?") ? "&" : "?") + query
    }

    /// Server-relative path → absolute URL with `t=<token>` (routes behind `queryAuth`).
    public func withToken(_ path: String) -> String { join(path, "t=\(Self.enc(token))") }

    /// Server-relative Subsonic path (`coverUrlPath`, `streamUrlPath`) → absolute URL with client params + `apiKey`.
    public func withApiKey(_ path: String) -> String { join(path, "v=1.16.1&c=mixai-ios&apiKey=\(Self.enc(token))") }

    /// `ws(s)://host:port/hub?t=<token>`.
    public func hubURL() -> String {
        var b = baseURL
        if b.hasPrefix("https://") { b = "wss://" + b.dropFirst(8) } else if b.hasPrefix("http://") { b = "ws://" + b.dropFirst(7) }
        return b + "/hub?t=\(Self.enc(token))"
    }

    /// Always the original video; `caps` lets the server copy what iOS decodes. `startSec` = server starts AT the resume
    /// point; `audio` = source audio track ordinal (0 = default).
    public func hlsURL(fileId: String, startSec: Int = 0, audio: Int = 0) -> String {
        var s = "\(baseURL)/video/stream/\(Self.enc(fileId))?q=original&caps=\(iosPlaybackCaps)"
        if startSec > 0 { s += "&start=\(startSec)" }
        if audio > 0 { s += "&audio=\(audio)" }
        return s + "&t=\(Self.enc(token))"
    }

    public func directURL(fileId: String) -> String { withToken("/video/direct/\(Self.enc(fileId))") }
    public func subtitleURL(fileId: String, ordinal: Int) -> String { withToken("/video/subs/\(Self.enc(fileId))/\(ordinal)") }
    public func stillURL(fileId: String) -> String { withToken("/video/thumbs/\(Self.enc(fileId))/still.jpg") }
    public func spriteURL(fileId: String) -> String { withToken("/video/thumbs/\(Self.enc(fileId))/sprite.jpg") }

    /// Cached TMDB image proxy; nil for a missing path.
    public func tmdbImageURL(size: String, path: String?) -> URL? {
        guard let p = path, !p.isEmpty else { return nil }
        return URL(string: withToken("/video/tmdb-image/\(size)\(p.hasPrefix("/") ? p : "/" + p)"))
    }

    // MARK: transport

    public func request(_ method: String, _ path: String, body: Data? = nil, auth: Bool = true, timeout: TimeInterval = 20) async throws -> Data {
        guard let url = URL(string: baseURL + path) else { throw URLError(.badURL) }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if ["POST", "PUT", "PATCH"].contains(method) {
            req.httpBody = Data()
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if auth {
            req.setValue(token, forHTTPHeaderField: "x-device-token")
            let pt = profileToken.withLock { $0 }
            if !pt.isEmpty { req.setValue(pt, forHTTPHeaderField: "x-profile-token") }
        }
        let res = try await transport.send(req, followRedirects: true)
        guard (200..<300).contains(res.status) else { throw APIStatusError(status: res.status, body: String(res.text.prefix(200))) }
        return res.body
    }

    public func get<T: Decodable>(_ type: T.Type, _ path: String, auth: Bool = true) async throws -> T {
        try JSON.decoder.decode(T.self, from: try await request("GET", path, auth: auth))
    }

    public func send<T: Decodable, B: Encodable>(_ type: T.Type, _ method: String, _ path: String, _ body: B) async throws -> T {
        try JSON.decoder.decode(T.self, from: try await request(method, path, body: try JSON.encoder.encode(body)))
    }

    /// Status-only call (response body ignored).
    public func call(_ method: String, _ path: String, body: Data? = nil) async throws {
        _ = try await request(method, path, body: body)
    }

    /// Server answer to GET `path` WITHOUT following redirects (device token header) — Live TV resolver.
    public func peekRedirect(_ path: String) async throws -> HTTPResponse {
        guard let url = URL(string: baseURL + path) else { throw URLError(.badURL) }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.setValue(token, forHTTPHeaderField: "x-device-token")
        return try await transport.send(req, followRedirects: false)
    }

    // MARK: server basics

    public func health() async throws -> Health { try await get(Health.self, "/health", auth: false) }
    public func pairInfo() async throws -> PairInfo { try await get(PairInfo.self, "/pair/info", auth: false) }

    /// 200 with the token, 401 without → "paired or not".
    public func checkToken() async throws -> Bool {
        do { _ = try await request("GET", "/video/flags"); return true } catch let e as APIStatusError where e.status == 401 { return false }
    }
}

/// Shared JSON coders (server sends camelCase; unknown keys are ignored by Codable).
public enum JSON {
    public static let decoder = JSONDecoder()
    public static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()
}
