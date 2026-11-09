import LiveCore
import SwiftUI
import WatchConnectivity
import WatchKit
import WidgetKit

/// MixAI Live for Apple Watch (WP21-09): scene prev / next, mute / panic, current song + part, input level ring and a
/// complication. Commands go through the iPhone (WatchConnectivity relay) while it is reachable; otherwise the watch
/// talks to the engine itself with the config the phone sent in its `applicationContext` (direct LAN, 10 Hz meters).
@main
struct LiveWatchApp: App {
    @State private var model = WatchModel.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            WatchRoot().environment(model)
        }
        .onChange(of: phase) { _, p in model.scene(active: p == .active) }
    }
}

enum WatchRoute: Equatable { case none, phone, direct }

@MainActor @Observable
final class WatchModel: NSObject, WCSessionDelegate {
    static let shared = WatchModel()

    private(set) var snapshot = LiveWatchStore.load() ?? WatchLink.Snapshot()
    private(set) var route: WatchRoute = .none
    private(set) var config: WatchLink.EngineConfig?

    @ObservationIgnored private var direct: LiveClient?
    @ObservationIgnored private var phoneTimeout: Task<Void, Never>?
    @ObservationIgnored private var active = true
    @ObservationIgnored private var lastPosition: Position?

    private override init() {
        super.init()
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
    }

    var canPerform: Bool { snapshot.connected && snapshot.role >= .performer && route != .none }

    // MARK: commands

    func send(_ c: WatchLink.Command) {
        guard canPerform else { WKInterfaceDevice.current().play(.failure); return }
        if route == .phone, WCSession.default.isReachable {
            WCSession.default.sendMessage(WatchLink.encode(.command(c)), replyHandler: nil) { [weak self] _ in
                Task { @MainActor in self?.phoneLost() }
            }
        } else if let direct {
            direct.send(c.client)
        }
        WKInterfaceDevice.current().play(c == .panic ? .stop : .click)
    }

    // MARK: routes

    func scene(active: Bool) {
        self.active = active
        if active { pickRoute() } else { stopDirect() }
    }

    private func pickRoute() {
        if WCSession.default.activationState == .activated, WCSession.default.isReachable, snapshot.connected {
            stopDirect()
            route = .phone
        } else if active, let config {
            startDirect(config)
        } else {
            route = .none
        }
    }

    private func startDirect(_ c: WatchLink.EngineConfig) {
        if direct == nil {
            let client = LiveClient(clientId: ClientId.load(prefix: "watch"), metersHz: 10)
            client.onChange = { [weak self] m in self?.fromDirect(m) }
            direct = client
        }
        if direct?.engine?.endpoint != c.endpoint {
            direct?.connect(PairedEngine(id: "watch", name: c.name, endpoint: c.endpoint), token: c.token)
        }
        route = .direct
    }

    private func stopDirect() {
        direct?.disconnect()
        direct = nil
        if route == .direct { route = .none }
    }

    private func phoneLost() {
        phoneTimeout?.cancel()
        if route == .phone { route = .none }
        pickRoute()
    }

    // MARK: inbound

    private func apply(_ s: WatchLink.Snapshot) {
        if let p = s.position, let old = lastPosition, p != old { WKInterfaceDevice.current().play(.directionUp) }
        lastPosition = s.position
        snapshot = s
        if LiveWatchStore.save(s) { WidgetCenter.shared.reloadTimelines(ofKind: LiveWatchStore.complicationKind) }
    }

    private func fromPhone(_ s: WatchLink.Snapshot) {
        if route != .phone { stopDirect(); route = .phone }
        apply(s)
        phoneTimeout?.cancel()
        phoneTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled else { return }
            self?.phoneLost()
        }
    }

    /// Direct-LAN model → the same snapshot shape the phone sends.
    private func fromDirect(_ m: LiveModel) {
        guard route == .direct else { return }
        apply(WatchLink.Snapshot(model: m, engineName: config?.name ?? ""))
    }

    /// Smoothed input level while on the direct route (the phone route carries it in the snapshot).
    var level: Double {
        if route == .direct, let d = direct { return MeterLevels.fraction(d.model.levels.inDb) }
        return snapshot.inLevel
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard case .snapshot(let s) = WatchLink.decode(message) else { return }
        Task { @MainActor in self.fromPhone(s) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext ctx: [String: Any]) {
        guard case .config(let c, let s) = WatchLink.decode(ctx) else { return }
        Task { @MainActor in
            self.config = c
            if c == nil { self.stopDirect() }
            if self.route != .direct { self.apply(s) }
            self.pickRoute()
        }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let msg = WatchLink.decode(session.receivedApplicationContext)
        Task { @MainActor in
            if case .config(let c, let s) = msg {
                self.config = c
                self.apply(s)
            }
            self.pickRoute()
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in self.pickRoute() }
    }
}
