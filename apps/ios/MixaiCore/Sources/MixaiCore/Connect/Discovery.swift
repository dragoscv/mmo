import Foundation
#if canImport(Network)
import Network
#endif

/// A server found on the LAN (Bonjour `_mmo-companion._tcp`) or typed by the user.
public struct DiscoveredServer: Sendable, Hashable, Identifiable {
    public let name: String
    public let baseURL: String
    public let pairing: Bool
    public var id: String { baseURL }

    public init(name: String, baseURL: String, pairing: Bool = true) {
        self.name = name
        self.baseURL = MmoClient.normalise(baseURL)
        self.pairing = pairing
    }
}

/// Bonjour browse for MMO Server companions (port of tv-android `Discovery`, NsdManager → NWBrowser).
/// Each result is resolved to `host:port` with a short NWConnection, then confirmed via `/pair/info`.
public final class Discovery: @unchecked Sendable {
    public static let serviceType = "_mmo-companion._tcp"

    #if canImport(Network)
    private var browser: NWBrowser?
    #endif
    private let queue = DispatchQueue(label: "ro.mixai.discovery")

    public init() {}

    /// Streams the current set of servers (deduplicated by base URL) until cancelled.
    public func browse() -> AsyncStream<[DiscoveredServer]> {
        AsyncStream { cont in
            #if canImport(Network)
            let params = NWParameters.tcp
            params.includePeerToPeer = false
            let b = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: params)
            let found = FoundSet()
            b.browseResultsChangedHandler = { [queue] results, _ in
                for r in results {
                    guard case .service(let name, _, _, _) = r.endpoint else { continue }
                    var pairFlag = true
                    if case .bonjour(let txt) = r.metadata, let p = txt.dictionary["pair"] { pairFlag = p == "1" }
                    let pairing = pairFlag
                    Self.resolve(r.endpoint, on: queue) { hostPort in
                        guard let hostPort else { return }
                        let s = DiscoveredServer(name: name, baseURL: "http://\(hostPort)", pairing: pairing)
                        cont.yield(found.insert(s))
                    }
                }
            }
            b.start(queue: queue)
            browser = b
            cont.onTermination = { _ in b.cancel() }
            #else
            cont.finish()
            #endif
        }
    }

    #if canImport(Network)
    /// Opens a TCP connection to the service just long enough to learn the remote IPv4/IPv6 + port.
    static func resolve(_ endpoint: NWEndpoint, on queue: DispatchQueue, done: @escaping @Sendable (String?) -> Void) {
        let params = NWParameters.tcp
        if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let conn = NWConnection(to: endpoint, using: params)
        let once = OnceFlag()
        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                var out: String?
                if case .hostPort(let host, let port) = conn.currentPath?.remoteEndpoint {
                    out = "\(Self.hostString(host)):\(port.rawValue)"
                }
                conn.cancel()
                if once.fire() { done(out) }
            case .failed, .cancelled:
                if once.fire() { done(nil) }
            default: break
            }
        }
        conn.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 4) { conn.cancel() }
    }

    static func hostString(_ h: NWEndpoint.Host) -> String {
        switch h {
        case .ipv4(let a): return "\(a)".components(separatedBy: "%").first ?? "\(a)"
        case .ipv6(let a): return "[\("\(a)".components(separatedBy: "%").first ?? "\(a)")]"
        case .name(let n, _): return n
        @unknown default: return "\(h)"
        }
    }
    #endif
}

final class FoundSet: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: DiscoveredServer] = [:]
    func insert(_ s: DiscoveredServer) -> [DiscoveredServer] {
        lock.lock(); defer { lock.unlock() }
        items[s.baseURL] = s
        return items.values.sorted { $0.name < $1.name }
    }
}

final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    func fire() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if fired { return false }
        fired = true
        return true
    }
}
