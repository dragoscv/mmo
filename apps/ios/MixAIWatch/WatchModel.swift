import Foundation
import Observation
import WatchConnectivity

/// The latest `WatchContext` from the iPhone plus the command channel back to it.
/// Delegate callbacks arrive on a WCSession queue: they decode to Sendable values first, then hop to the main actor.
@MainActor @Observable
final class WatchModel: NSObject, WCSessionDelegate {
    private(set) var context: WatchContext?
    private(set) var reachable = false
    /// A String Catalog key (or a system error description) shown under the tabs.
    var lastError: String?

    func start() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.delegate == nil else { return }
        session.delegate = self
        session.activate()
    }

    func send(_ cmd: WatchCommand) {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else {
            lastError = "watch.phone_unreachable"
            return
        }
        lastError = nil
        Self.deliver(cmd.dictionary, via: session, to: self)
    }

    /// Built outside the main actor: WCSession calls these handlers on its own queue, and a closure formed
    /// in a @MainActor method would inherit main-actor isolation and trap at runtime under Swift 6.
    private nonisolated static func deliver(_ message: [String: Any], via session: WCSession, to model: WatchModel) {
        session.sendMessage(
            message,
            replyHandler: { [weak target = model] reply in
                let ok = (reply["ok"] as? Bool) ?? true
                Task { @MainActor in
                    if !ok { target?.lastError = "watch.command_failed" }
                }
            },
            errorHandler: { [weak target = model] error in
                let text = error.localizedDescription
                Task { @MainActor in target?.lastError = text }
            })
    }

    private func accept(_ next: WatchContext?, reachable: Bool) {
        self.reachable = reachable
        guard let next else { return }
        // A context delivered late must not replace a fresher one.
        if let current = context, current.updatedAt > next.updatedAt { return }
        context = next
    }

    // MARK: WCSessionDelegate

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let ctx = WatchContext(dictionary: session.receivedApplicationContext)
        let reachable = session.isReachable
        let message = error?.localizedDescription
        Task { @MainActor in
            self.accept(ctx, reachable: reachable)
            if let message { self.lastError = message }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let ctx = WatchContext(dictionary: applicationContext)
        let reachable = session.isReachable
        Task { @MainActor in self.accept(ctx, reachable: reachable) }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in
            self.reachable = reachable
            if reachable, self.lastError == "watch.phone_unreachable" { self.lastError = nil }
        }
    }
}
