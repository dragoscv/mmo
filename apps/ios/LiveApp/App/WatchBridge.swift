import Foundation
import LiveCore
import WatchConnectivity

/// Phone side of the Apple Watch link (`WatchLink` v1): the engine config + last snapshot as `applicationContext`
/// (the watch has it when it wakes, and can reach the engine itself), live snapshots by `sendMessage` while the
/// watch app is reachable, and watch commands relayed to the engine through the phone's socket.
@MainActor
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private var config: WatchLink.EngineConfig?
    private var last: WatchLink.Snapshot?
    private var lastAt: TimeInterval = 0
    private var lastContextSnap: WatchLink.Snapshot?

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private var ready: Bool {
        WCSession.isSupported() && WCSession.default.activationState == .activated && WCSession.default.isWatchAppInstalled
    }

    func publishConfig(engine: PairedEngine?, token: String?, model: LiveModel) {
        if let engine, let token { config = WatchLink.EngineConfig(name: engine.name, endpoint: engine.endpoint, token: token) } else { config = nil }
        pushContext(WatchLink.Snapshot(model: model, engineName: engine?.name ?? ""))
    }

    func publish(_ m: LiveModel, engineName: String) {
        guard ready else { return }
        let snap = WatchLink.Snapshot(model: m, engineName: engineName)
        let now = ProcessInfo.processInfo.systemUptime
        if WCSession.default.isReachable, WatchLink.shouldSend(prev: last, next: snap, sinceLast: now - lastAt) {
            WCSession.default.sendMessage(WatchLink.encode(.snapshot(snap)), replyHandler: nil, errorHandler: nil)
            last = snap
            lastAt = now
        }
        // The complication shows the current part: refresh the context only when the content changed.
        if let prev = lastContextSnap, prev.sameContent(snap) { return }
        pushContext(snap)
    }

    private func pushContext(_ snap: WatchLink.Snapshot) {
        guard ready else { return }
        lastContextSnap = snap
        try? WCSession.default.updateApplicationContext(WatchLink.encode(.config(config, snap)))
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard case .command(let c) = WatchLink.decode(message) else { return }
        Task { @MainActor in LiveSession.shared.relay(c) }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            let s = LiveSession.shared
            self.publishConfig(engine: s.current, token: s.current.flatMap { s.store.token(for: $0) }, model: s.model)
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
