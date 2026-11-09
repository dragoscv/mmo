import Foundation
import LiveCore
import Network

/// Bonjour browse for `_mixai-live._tcp` (TXT `v=1`, `name`, `port`, `osc`). Discovery only finds the engine;
/// the token still comes from the QR code or the pairing link (the engine never advertises it).
@MainActor @Observable
final class LiveDiscovery {
    struct Found: Identifiable, Hashable {
        let id: String
        let name: String
        let result: NWBrowser.Result
        static func == (a: Found, b: Found) -> Bool { a.id == b.id }
        func hash(into h: inout Hasher) { h.combine(id) }
    }

    private(set) var found: [Found] = []
    private(set) var denied = false
    @ObservationIgnored private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: LiveProtocol.bonjourType, domain: nil), using: .tcp)
        b.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .failed, .waiting: self?.denied = true
                case .ready: self?.denied = false
                default: break
                }
            }
        }
        b.browseResultsChangedHandler = { [weak self] results, _ in
            let list = results.compactMap(Self.found).sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
            Task { @MainActor in self?.found = list }
        }
        b.start(queue: .main)
        browser = b
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }

    nonisolated private static func found(_ r: NWBrowser.Result) -> Found? {
        guard case .service(let name, _, _, _) = r.endpoint else { return nil }
        var shown = name
        if case .bonjour(let txt) = r.metadata {
            if let v = txt["v"], let n = Int(v), n > LiveProtocol.version { return nil }
            if let n = txt["name"], !n.isEmpty { shown = n }
        }
        return Found(id: name, name: shown, result: r)
    }

    /// Resolve a Bonjour service to `host:port` by opening (and dropping) a TCP connection.
    nonisolated static func resolve(_ f: Found) async -> EngineEndpoint? {
        let conn = NWConnection(to: f.result.endpoint, using: .tcp)
        let box = ResolveBox()
        return await withCheckedContinuation { (cont: CheckedContinuation<EngineEndpoint?, Never>) in
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    var out: EngineEndpoint?
                    if case .hostPort(let host, let port) = conn.currentPath?.remoteEndpoint {
                        out = EngineEndpoint(host: Self.text(host), port: Int(port.rawValue))
                    }
                    conn.cancel()
                    box.finish(cont, out)
                case .failed, .cancelled:
                    box.finish(cont, nil)
                default: break
                }
            }
            conn.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { conn.cancel(); box.finish(cont, nil) }
        }
    }

    nonisolated private static func text(_ h: NWEndpoint.Host) -> String {
        switch h {
        case .ipv4(let a): return "\(a)"
        case .ipv6(let a): return "\(a)"
        case .name(let n, _): return n
        @unknown default: return "\(h)"
        }
    }
}

/// Resumes a continuation exactly once across racing callbacks.
private final class ResolveBox: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func finish(_ c: CheckedContinuation<EngineEndpoint?, Never>, _ v: EngineEndpoint?) {
        lock.lock()
        defer { lock.unlock() }
        guard !done else { return }
        done = true
        c.resume(returning: v)
    }
}
