import Foundation
import WatchConnectivity

/// Phone → watch mirror over WatchConnectivity (WP18-05; Android `WatchBridge` equivalent, same `WearLink` v1 line):
/// `sendMessage` while the watch app is reachable (throttled like Android), `applicationContext` with the last locked
/// reading so the complication and the watch app have it when they wake.
@MainActor
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private var last: WearLink.Reading?
    private var lastAt: TimeInterval = 0
    private var lastContext: String?

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func publish(_ s: ListenSession) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated, WCSession.default.isWatchAppInstalled else { return }
        var title: String?
        if case .found(let m, _) = s.songId { title = [m.title, m.artist].compactMap { $0 }.joined(separator: " \u{2014} ") }
        let r = WearLink.Reading(
            listening: s.listening, keyIndex: s.reading?.keyIndex, keyLocked: s.reading?.keyLocked ?? false, bpm: s.bpm,
            tempoLocked: s.reading?.tempoLocked ?? false, nextBeatMs: s.reading.map { Int($0.nextBeatIn * 1000) },
            atMillis: Int64(Date.now.timeIntervalSince1970 * 1000), title: title)
        let now = ProcessInfo.processInfo.systemUptime
        if !r.listening, last?.listening == false { return }
        if WCSession.default.isReachable, WearLink.shouldSend(prev: last, next: r, sinceLastMs: Int64((now - lastAt) * 1000)) {
            WCSession.default.sendMessage([WearLink.lineKey: WearLink.encode(r), WearLink.kindKey: "live"], replyHandler: nil, errorHandler: nil)
            last = r
            lastAt = now
        }
        if r.keyLocked, r.tempoLocked, let k = r.keyIndex, let b = r.bpm {
            let sig = "\(k);\((b * 2).rounded() / 2)"
            if sig != lastContext {
                lastContext = sig
                try? WCSession.default.updateApplicationContext([WearLink.lineKey: WearLink.encode(r), WearLink.kindKey: "last"])
            }
        }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
