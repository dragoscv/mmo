import Foundation

// MixAI account sign-in — device-code flow on the web origin (port of tv-android `DeviceAuth`):
//   POST {origin}/api/device/code  {deviceName, platform, appVersion} -> {device_code, user_code, verification_uri(_complete), expires_in, interval}
//   POST {origin}/api/device/token {device_code} -> 428 pending | 403 slow_down/access_denied | 410 expired | 200 session + companions

public struct DeviceCode: Codable, Sendable, Equatable {
    public let device_code: String
    public let user_code: String
    public let verification_uri: String?
    public let verification_uri_complete: String?
    public let expires_in: Int?
    public let interval: Int?
}

public struct SessionUser: Codable, Sendable, Equatable {
    public let id: String
    public let name: String?
    public let image: String?
}

public struct CompanionServer: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String?
    public let lanUrl: String?
    public let apiUrl: String?
    public let tunnelHostname: String?
    public let token: String
}

public struct DeviceTokenOk: Codable, Sendable, Equatable {
    public let session_token: String
    public let expires: String?
    public let user: SessionUser
    public let companions: [CompanionServer]?
}

public enum TokenResult: Sendable, Equatable {
    case pending, slowDown, accessDenied, expired
    case ok(DeviceTokenOk)
}

public struct DeviceAuthError: Error, Sendable, Equatable {
    public enum Kind: Sendable { case network, status, invalid }
    public let status: Int
    public let kind: Kind
    public let host: String
}

/// Default web origins: mixai.ro (production) and the Cloud Run URL (works while mixai.ro DNS is down).
public enum MixaiOrigin {
    public static let production = "https://mixai.ro"
    public static let cloudRun = "https://mixai-web-622082681070.europe-west1.run.app"
}

public struct DeviceAuth: Sendable {
    public let origin: String
    public let transport: any HTTPTransport

    public init(origin: String, transport: any HTTPTransport = URLSessionTransport.shared) {
        var o = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        while o.hasSuffix("/") { o.removeLast() }
        self.origin = o
        self.transport = transport
    }

    public var host: String { URL(string: origin)?.host ?? origin }

    public func requestCode(deviceName: String) async throws -> DeviceCode {
        let id = ClientIdentity.current
        let body = try JSON.encoder.encode(["deviceName": deviceName, "platform": id.platform, "appVersion": id.appVersion])
        let res = try await post("/api/device/code", body)
        guard (200..<300).contains(res.status) else { throw DeviceAuthError(status: res.status, kind: .status, host: host) }
        do { return try JSON.decoder.decode(DeviceCode.self, from: res.body) } catch { throw DeviceAuthError(status: res.status, kind: .invalid, host: host) }
    }

    public func pollToken(deviceCode: String) async throws -> TokenResult {
        let res = try await post("/api/device/token", try JSON.encoder.encode(["device_code": deviceCode]))
        return try Self.interpret(status: res.status, body: res.body, host: host)
    }

    /// Pure mapping of a token answer (unit-tested).
    public static func interpret(status: Int, body: Data, host: String) throws -> TokenResult {
        if status == 200 {
            do { return .ok(try JSON.decoder.decode(DeviceTokenOk.self, from: body)) } catch { throw DeviceAuthError(status: status, kind: .invalid, host: host) }
        }
        let err = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["error"] as? String
        if status == 428 || err == "authorization_pending" { return .pending }
        if err == "slow_down" { return .slowDown }
        if status == 403 || err == "access_denied" { return .accessDenied }
        if status == 410 || err == "expired_token" { return .expired }
        throw DeviceAuthError(status: status, kind: .status, host: host)
    }

    /// First companion whose `lanUrl` (then `apiUrl`) answers `/health`.
    public func pickReachable(_ companions: [CompanionServer]) async -> (CompanionServer, String)? {
        for c in companions where !c.token.isEmpty {
            for raw in [c.lanUrl, c.apiUrl].compactMap({ $0 }).filter({ !$0.isEmpty }) {
                let base = MmoClient.normalise(raw)
                if await Self.probeHealth(base, transport: transport) { return (c, base) }
            }
        }
        return nil
    }

    public static func probeHealth(_ base: String, transport: any HTTPTransport = URLSessionTransport.shared, timeout: TimeInterval = 2.5) async -> Bool {
        guard let url = URL(string: MmoClient.normalise(base) + "/health") else { return false }
        let req = URLRequest(url: url, timeoutInterval: timeout)
        guard let res = try? await transport.send(req, followRedirects: true) else { return false }
        return (200..<300).contains(res.status)
    }

    private func post(_ path: String, _ body: Data) async throws -> HTTPResponse {
        guard let url = URL(string: origin + path) else { throw DeviceAuthError(status: 0, kind: .network, host: host) }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do { return try await transport.send(req, followRedirects: true) } catch { throw DeviceAuthError(status: 0, kind: .network, host: host) }
    }
}
