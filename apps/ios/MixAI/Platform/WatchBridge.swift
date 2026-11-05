import Foundation
import WatchConnectivity

/// Phone side of WatchConnectivity: playback + TV list as application context, remote commands from the watch.
@MainActor
final class WatchBridge: NSObject, WCSessionDelegate {
    private var last: WatchContext?

    func activate() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
    }

    /// Cheap when nothing changed (position deltas under 5 s are ignored).
    func push(_ ctx: WatchContext) {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated, s.isPaired, s.isWatchAppInstalled else { return }
        if let l = last, l.title == ctx.title, l.playing == ctx.playing, l.source == ctx.source, l.tvs == ctx.tvs,
           abs(l.positionSec - ctx.positionSec) < 5 { return }
        last = ctx
        try? s.updateApplicationContext(ctx.dictionary)
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {}
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        guard let cmd = WatchCommand(dictionary: message) else {
            replyHandler(["ok": false])
            return
        }
        // The reply handler is not Sendable: answer now, apply on the main actor.
        replyHandler(["ok": true])
        Task { @MainActor in AppModel.shared.applyWatch(cmd) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let cmd = WatchCommand(dictionary: message) else { return }
        Task { @MainActor in AppModel.shared.applyWatch(cmd) }
    }
}
