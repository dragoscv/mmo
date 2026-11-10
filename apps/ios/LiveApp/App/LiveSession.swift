import LiveCore
import SwiftUI
import UIKit

/// App-wide state: paired engines, the one `LiveClient`, Bonjour discovery and the watch mirror.
@MainActor @Observable
final class LiveSession {
    static let shared = LiveSession()

    let store = EngineStore()
    let client: LiveClient
    let discovery = LiveDiscovery()
    /// Engine in use (kept while the app is in the background, when the socket is closed).
    private(set) var current: PairedEngine?
    /// The Perform screen is on screen (keeps the display awake while connected).
    var performing = false { didSet { updateIdleTimer() } }

    @ObservationIgnored private var active = true
    @ObservationIgnored private var touched: String?
    /// Controller token of the in-process engine (kept only in memory).
    @ObservationIgnored private var localToken: String?
    @ObservationIgnored private let impact = UIImpactFeedbackGenerator(style: .heavy)

    private init() {
        let prefix = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
        client = LiveClient(clientId: ClientId.load(prefix: prefix))
        client.onSceneChange = { [weak self] in self?.sceneChanged() }
        client.onChange = { [weak self] m in self?.changed(m) }
    }

    var model: LiveModel { client.model }

    // MARK: engines

    func pair(_ link: PairingLink) {
        connect(store.save(link))
    }

    func connect(_ e: PairedEngine) {
        guard let token = store.token(for: e) else { return }
        current = e
        touched = nil
        client.connect(e, token: token)
        WatchBridge.shared.publishConfig(engine: e, token: token, model: client.model)
    }

    /// Connect to the engine running on this phone (`LocalEngine`). Not stored: its token changes on every start.
    func connectLocal(endpoint: EngineEndpoint, token: String) {
        localToken = token
        let e = PairedEngine(id: Self.localId, name: String(localized: "live.local.name"), endpoint: endpoint, role: .controller)
        current = e
        touched = e.id
        client.connect(e, token: token)
        // The watch cannot reach the phone's loopback: hand it the LAN endpoint + performer token, or nothing.
        if let lan = LocalEngine.shared.lanPairing {
            WatchBridge.shared.publishConfig(engine: PairedEngine(id: Self.localId, name: e.name, endpoint: lan.endpoint, role: .performer),
                                             token: lan.token, model: client.model)
        } else {
            WatchBridge.shared.publishConfig(engine: nil, token: nil, model: client.model)
        }
    }

    /// The client is talking to the engine on this phone.
    var isLocal: Bool { current?.id == Self.localId }

    static let localId = "local-engine"

    /// Connect to the most recently used engine when nothing is connected.
    func autoConnect() {
        guard client.engine == nil else { return }
        if let e = current ?? store.engines.first, e.id != Self.localId { connect(e) }
    }

    func disconnect() {
        if isLocal { localToken = nil }
        current = nil
        client.disconnect()
        WatchBridge.shared.publishConfig(engine: nil, token: nil, model: client.model)
        updateIdleTimer()
    }

    func forget(_ e: PairedEngine) {
        if current?.id == e.id { disconnect() }
        store.remove(e)
    }

    /// iOS suspends sockets in the background: close cleanly and reconnect on return.
    func scene(active: Bool) {
        guard active != self.active else { return }
        self.active = active
        if active {
            if let e = current, client.engine == nil {
                if e.id == Self.localId, let ep = LocalEngine.shared.endpoint, let t = localToken {
                    connectLocal(endpoint: ep, token: t)
                } else {
                    connect(e)
                }
            }
            discovery.start()
        } else {
            let keep = current
            client.disconnect()
            current = keep
            discovery.stop()
        }
        updateIdleTimer()
    }

    // MARK: callbacks

    private func sceneChanged() {
        impact.impactOccurred()
        impact.prepare()
    }

    private func changed(_ m: LiveModel) {
        if m.connected, let e = current, touched != e.id {
            touched = e.id
            store.touch(e.id, role: m.role, name: m.hello?.engineName)
        }
        WatchBridge.shared.publish(m, engineName: current?.name ?? "")
        updateIdleTimer()
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = active && performing && client.model.connected
    }

    /// Send a watch command through the phone's socket.
    func relay(_ c: WatchLink.Command) {
        client.send(c.client)
    }
}
