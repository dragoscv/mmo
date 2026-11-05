import CryptoKit
import Foundation

// MixAI account calls on the web origin with a native session (`Authorization: Bearer <sessionToken>`):
//   POST   /api/auth/native/apple {identityToken, nonce, authorizationCode?, fullName?} -> {sessionToken, expires, user}
//   POST   /api/push/register     {platform:"ios", token, environment, deviceName?, profileId?, liveActivityToken?}
//   DELETE /api/push/register     {token}
//   DELETE /api/account           {confirmation:"DELETE"}

/// Nonce for Sign in with Apple: the RAW value goes to the server, its SHA-256 hex into the Apple request.
public struct AppleNonce: Sendable, Equatable {
    public let raw: String
    public var hashed: String { Self.sha256(raw) }

    public init(raw: String) { self.raw = raw }

    /// 32 bytes from the system CSPRNG, URL-safe charset.
    public static func random(length: Int = 32) -> AppleNonce {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var rng = SystemRandomNumberGenerator()
        return AppleNonce(raw: String((0..<length).map { _ in charset[Int(rng.next() % UInt64(charset.count))] }))
    }

    public static func sha256(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

public struct AccountUser: Codable, Sendable, Equatable {
    public let id: String
    public let name: String?
    public let email: String?
    public let image: String?

    public init(id: String, name: String?, email: String?, image: String?) {
        self.id = id
        self.name = name
        self.email = email
        self.image = image
    }
}

/// `{session_token|sessionToken, expires, user, created?}`.
public struct NativeSession: Codable, Sendable, Equatable {
    public let sessionToken: String
    public let expires: String?
    public let user: AccountUser
    public let created: Bool?

    enum CodingKeys: String, CodingKey { case sessionToken, session_token, expires, user, created }

    public init(sessionToken: String, expires: String?, user: AccountUser, created: Bool? = nil) {
        self.sessionToken = sessionToken
        self.expires = expires
        self.user = user
        self.created = created
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let tok = try c.decodeIfPresent(String.self, forKey: .sessionToken) ?? c.decodeIfPresent(String.self, forKey: .session_token) else {
            throw DecodingError.keyNotFound(CodingKeys.sessionToken, .init(codingPath: c.codingPath, debugDescription: "no session token"))
        }
        sessionToken = tok
        expires = try c.decodeIfPresent(String.self, forKey: .expires)
        user = try c.decode(AccountUser.self, forKey: .user)
        created = try c.decodeIfPresent(Bool.self, forKey: .created)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sessionToken, forKey: .sessionToken)
        try c.encodeIfPresent(expires, forKey: .expires)
        try c.encode(user, forKey: .user)
        try c.encodeIfPresent(created, forKey: .created)
    }
}

public struct AccountError: Error, Sendable, Equatable, CustomStringConvertible {
    /// `invalid_token`, `nonce_mismatch`, `link_conflict`, `email_required`, `unauthorized`, `rate_limited`,
    /// `provider_unavailable`, `push_unavailable`, `confirmation_required`, `network`, `http_<status>`.
    public let code: String
    public let status: Int
    public init(code: String, status: Int) { self.code = code; self.status = status }
    public var description: String { "\(code) (\(status))" }
}

public enum PushEnvironment: String, Sendable, Codable { case sandbox, production }

public struct PushRegistration: Encodable, Sendable, Equatable {
    public let platform = "ios"
    public let token: String
    public let environment: PushEnvironment
    public let deviceName: String?
    public let profileId: String?
    public let liveActivityToken: String?

    public init(token: String, environment: PushEnvironment, deviceName: String?, profileId: String?, liveActivityToken: String?) {
        self.token = token
        self.environment = environment
        self.deviceName = deviceName
        self.profileId = profileId
        self.liveActivityToken = liveActivityToken
    }

    enum CodingKeys: String, CodingKey { case platform, token, environment, deviceName, profileId, liveActivityToken }
}

public struct AccountAPI: Sendable {
    public let origin: String
    public let transport: any HTTPTransport

    public init(origin: String, transport: any HTTPTransport = URLSessionTransport.shared) {
        var o = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        while o.hasSuffix("/") { o.removeLast() }
        self.origin = o
        self.transport = transport
    }

    public func signInWithApple(identityToken: String, nonce: String, authorizationCode: String?, givenName: String?, familyName: String?) async throws -> NativeSession {
        var body: [String: JSONValue] = ["identityToken": .string(identityToken), "nonce": .string(nonce)]
        if let authorizationCode { body["authorizationCode"] = .string(authorizationCode) }
        if givenName != nil || familyName != nil {
            body["fullName"] = .object(["givenName": givenName.map(JSONValue.string) ?? .null, "familyName": familyName.map(JSONValue.string) ?? .null])
        }
        let res = try await send("POST", "/api/auth/native/apple", body: try JSON.encoder.encode(JSONValue.object(body)), bearer: nil)
        try Self.check(res)
        do { return try JSON.decoder.decode(NativeSession.self, from: res.body) } catch { throw AccountError(code: "invalid_response", status: res.status) }
    }

    public func registerPush(_ r: PushRegistration, session: String) async throws {
        try Self.check(try await send("POST", "/api/push/register", body: try JSON.encoder.encode(r), bearer: session))
    }

    public func unregisterPush(token: String, session: String) async throws {
        try Self.check(try await send("DELETE", "/api/push/register", body: try JSON.encoder.encode(["token": token]), bearer: session))
    }

    /// In-app account deletion (App Store 5.1.1(v)); `confirmation` must be the literal "DELETE".
    public func deleteAccount(confirmation: String, session: String) async throws {
        try Self.check(try await send("DELETE", "/api/account", body: try JSON.encoder.encode(["confirmation": confirmation]), bearer: session))
    }

    /// Maps a non-2xx answer to `AccountError(code:)` from `{error}` (unit-tested).
    public static func check(_ res: HTTPResponse) throws {
        guard !(200..<300).contains(res.status) else { return }
        let err = (try? JSONSerialization.jsonObject(with: res.body) as? [String: Any])?["error"] as? String
        throw AccountError(code: err ?? "http_\(res.status)", status: res.status)
    }

    private func send(_ method: String, _ path: String, body: Data?, bearer: String?) async throws -> HTTPResponse {
        guard let url = URL(string: origin + path) else { throw AccountError(code: "network", status: 0) }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearer { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        do { return try await transport.send(req, followRedirects: true) } catch { throw AccountError(code: "network", status: 0) }
    }
}

/// APNs device token bytes → lowercase hex (what the relay sends to APNs).
public func apnsTokenHex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

/// `aps-environment` of the embedded provisioning profile: `development` → sandbox; App Store / TestFlight builds
/// carry no embedded profile → production.
public func pushEnvironment(embeddedProfile: Data?) -> PushEnvironment {
    guard let data = embeddedProfile else { return .production }
    let text = String(decoding: data, as: UTF8.self)
    guard let r = text.range(of: "<key>aps-environment</key>") else { return .production }
    let tail = text[r.upperBound...].prefix(200)
    return tail.contains("<string>development</string>") ? .sandbox : .production
}
