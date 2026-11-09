import Foundation

/// Where an engine listens (HTTP + WebSocket on the same port).
public struct EngineEndpoint: Codable, Hashable, Sendable {
    public var host: String
    public var port: Int

    public init(host: String, port: Int = LiveProtocol.defaultPort) {
        self.host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[] "))
        self.port = port
    }

    /// Host as it goes into a URL (IPv6 in brackets, zone id percent-encoded).
    public var urlHost: String {
        guard host.contains(":") else { return host }
        return "[" + host.replacingOccurrences(of: "%", with: "%25") + "]"
    }

    public var httpBase: URL? { URL(string: "http://\(urlHost):\(port)") }

    public var display: String { "\(host):\(port)" }

    /// `ws://host:port/ws?t=<token>&c=<client-id>`.
    public func webSocketURL(token: String, clientId: String) -> URL? {
        var c = URLComponents()
        c.scheme = "ws"
        c.percentEncodedHost = urlHost
        c.port = port
        c.path = "/ws"
        c.queryItems = [URLQueryItem(name: "t", value: token), URLQueryItem(name: "c", value: clientId)]
        return c.url
    }
}

/// A scanned or typed pairing link: `mixai-live://pair?host=&port=&t=&name=`, or the web-remote form
/// `http://<ip>:17920/?t=<token>` (also accepted with `ws://`).
public struct PairingLink: Equatable, Sendable {
    public var endpoint: EngineEndpoint
    public var token: String
    public var name: String?

    public init(endpoint: EngineEndpoint, token: String, name: String? = nil) {
        self.endpoint = endpoint; self.token = token; self.name = name
    }

    public static func parse(_ raw: String) -> PairingLink? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let c = URLComponents(string: text), let scheme = c.scheme?.lowercased() else { return nil }
        let q = Dictionary((c.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard let token = q["t"], isToken(token) else { return nil }
        let name = q["name"].flatMap { $0.isEmpty ? nil : $0 }
        switch scheme {
        case LiveProtocol.pairScheme:
            guard c.host?.lowercased() == "pair" || c.path.contains("pair"), let host = q["host"], !host.isEmpty else { return nil }
            let port = q["port"].flatMap(Int.init) ?? LiveProtocol.defaultPort
            guard (1...65535).contains(port) else { return nil }
            return PairingLink(endpoint: EngineEndpoint(host: host, port: port), token: token, name: name)
        case "http", "https", "ws", "wss":
            guard let host = c.host, !host.isEmpty else { return nil }
            return PairingLink(endpoint: EngineEndpoint(host: host, port: c.port ?? LiveProtocol.defaultPort), token: token, name: name)
        default:
            return nil
        }
    }

    /// Tokens are 128-bit random hex (32 chars); accept 16..128 hex chars to stay forward compatible.
    public static func isToken(_ t: String) -> Bool {
        (16...128).contains(t.count) && t.allSatisfy(\.isHexDigit)
    }
}

/// A remembered engine. The token lives in the Keychain (`TokenVault`), never in defaults.
public struct PairedEngine: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var endpoint: EngineEndpoint
    public var role: Role?
    public var lastConnected: Date?

    public init(id: String = UUID().uuidString, name: String, endpoint: EngineEndpoint, role: Role? = nil, lastConnected: Date? = nil) {
        self.id = id; self.name = name; self.endpoint = endpoint; self.role = role; self.lastConnected = lastConnected
    }
}

/// Stable per-install client id for `?c=` (1..40 chars of `[A-Za-z0-9_-]`).
public enum ClientId {
    public static func make(prefix: String) -> String {
        let clean = prefix.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
        let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
        return String((clean.isEmpty ? "app" : clean).prefix(24)) + "-" + suffix
    }

    public static func load(prefix: String, defaults: UserDefaults = .standard) -> String {
        let key = "mixaiLiveClientId"
        if let v = defaults.string(forKey: key), isValid(v) { return v }
        let v = make(prefix: prefix)
        defaults.set(v, forKey: key)
        return v
    }

    public static func isValid(_ c: String) -> Bool {
        (1...40).contains(c.count) && c.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}
