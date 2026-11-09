import Foundation
import Observation

/// WebSocket client for one MixAI Live engine (protocol v1). Owns the socket, reconnects with backoff, throttles
/// slider traffic (30 ms per control) and exposes a `LiveModel` that only `LiveReducer` mutates.
@MainActor @Observable
public final class LiveClient {
    public private(set) var model = LiveModel()
    public private(set) var engine: PairedEngine?
    /// `GET /api/fx` catalogue (parameter ranges for the chain editor).
    public private(set) var fx: [FxSpec] = []

    /// Called after the setlist position moved (haptics, teleprompter).
    @ObservationIgnored public var onSceneChange: (@MainActor () -> Void)?
    /// Called after every applied event (watch mirror, widgets).
    @ObservationIgnored public var onChange: (@MainActor (LiveModel) -> Void)?

    @ObservationIgnored private let clientId: String
    @ObservationIgnored private let metersHz: Int?
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var task: URLSessionWebSocketTask?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var flusher: Task<Void, Never>?
    @ObservationIgnored private var throttle = Throttle<ClientCommand>(interval: 0.03)
    @ObservationIgnored private var nextId: UInt32 = 1
    @ObservationIgnored private var wantMeters = true
    @ObservationIgnored private var lastSceneChanges = 0

    /// - Parameters:
    ///   - clientId: stable `?c=` id (`ClientId.load`).
    ///   - metersHz: meter rate (watches ask 10 Hz; nil = engine default 30 Hz).
    public init(clientId: String, metersHz: Int? = nil) {
        self.clientId = clientId
        self.metersHz = metersHz
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 8
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg)
    }

    // MARK: connection

    public func connect(_ engine: PairedEngine, token: String) {
        disconnect()
        self.engine = engine
        self.token = token
        loop = Task { [weak self] in await self?.run() }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(33))
                self?.apply(.meterTick(dt: 0.033))
            }
        }
    }

    public func disconnect() {
        loop?.cancel(); loop = nil
        ticker?.cancel(); ticker = nil
        flusher?.cancel(); flusher = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        throttle.reset()
        engine = nil
        token = nil
        fx = []
        lastSceneChanges = 0
        apply(.disconnectedByUser)
    }

    /// Retry now (after a failure or while waiting).
    public func reconnect() {
        guard let engine, let token else { return }
        connect(engine, token: token)
    }

    /// Turn the meter stream on/off (save radio when the meters are not on screen).
    public func setMeters(_ on: Bool) {
        wantMeters = on
        if model.connected { transmit(.subscribe(meters: on, hz: metersHz)) }
    }

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            guard let engine, let token, let url = engine.endpoint.webSocketURL(token: token, clientId: clientId) else { return }
            apply(.connecting(attempt: attempt))
            let t = session.webSocketTask(with: url)
            t.maximumMessageSize = 1 << 20
            task = t
            t.resume()
            pingLoop(t)
            do {
                while !Task.isCancelled {
                    guard let text = try await Self.receiveText(t) else { continue }
                    guard let msg = ServerMessage.decode(text) else { continue }
                    if case .hello = msg {
                        attempt = 0
                        apply(.received(msg))
                        guard model.connected else {
                            // Protocol too new: stop here, the UI asks the user to update the app.
                            t.cancel(with: .normalClosure, reason: nil)
                            if task === t { task = nil }
                            return
                        }
                        transmit(.subscribe(meters: wantMeters, hz: metersHz))
                        loadFx(engine.endpoint)
                        continue
                    }
                    apply(.received(msg))
                }
            } catch {}
            let status = (t.response as? HTTPURLResponse)?.statusCode
            t.cancel(with: .goingAway, reason: nil)
            if task === t { task = nil }
            if Task.isCancelled { return }
            apply(.closed(httpStatus: status == 101 ? nil : status))
            guard LiveReducer.shouldRetry(model.phase) else { return }
            let delay = LiveReducer.backoff(attempt: attempt)
            attempt += 1
            apply(.waiting(attempt: attempt, seconds: delay))
            try? await Task.sleep(for: .seconds(delay))
        }
    }

    /// Keeps NAT / Wi-Fi power save from silently dropping an idle socket and detects dead links (no pong = close).
    private func pingLoop(_ t: URLSessionWebSocketTask) {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, self.task === t else { return }
                t.sendPing { error in if error != nil { t.cancel(with: .abnormalClosure, reason: nil) } }
            }
        }
    }

    nonisolated private static func receiveText(_ t: URLSessionWebSocketTask) async throws -> String? {
        switch try await t.receive() {
        case .string(let s): return s
        case .data(let d): return String(decoding: d, as: UTF8.self)
        @unknown default: return nil
        }
    }

    private func loadFx(_ endpoint: EngineEndpoint) {
        guard fx.isEmpty, let url = endpoint.httpBase?.appending(path: "api/fx") else { return }
        let session = self.session
        Task { [weak self] in
            let specs = await Self.fetchFx(session, url)
            if let self, !specs.isEmpty { self.fx = specs }
        }
    }

    nonisolated private static func fetchFx(_ session: URLSession, _ url: URL) async -> [FxSpec] {
        guard let (data, _) = try? await session.data(from: url) else { return [] }
        return (try? JSONDecoder().decode([FxSpec].self, from: data)) ?? []
    }

    // MARK: commands

    /// Send a command if this device's role allows it. Slider-type commands are throttled per control (30 ms,
    /// newest value wins) and mix changes are shown at once (optimistic) until the engine echoes `state`.
    @discardableResult
    public func send(_ cmd: ClientCommand) -> Bool {
        guard model.can(cmd) else { return false }
        if case .setMix(let c) = cmd { apply(.optimisticMix(c)) }
        if let key = cmd.coalesceKey {
            let now = ProcessInfo.processInfo.systemUptime
            if let out = throttle.offer(key: key, value: cmd, now: now, merge: Self.merge) { transmit(out) } else { scheduleFlush() }
        } else {
            transmit(cmd)
        }
        return true
    }

    public func fxSpec(_ id: String) -> FxSpec? { fx.first { $0.id == id } }

    public func clearError() { apply(.clearError) }

    private static func merge(_ a: ClientCommand, _ b: ClientCommand) -> ClientCommand {
        if case .setMix(let x) = a, case .setMix(let y) = b { return .setMix(x.merged(with: y)) }
        return b
    }

    private func scheduleFlush() {
        guard flusher == nil else { return }
        flusher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(10))
                guard let self else { return }
                for c in self.throttle.due(now: ProcessInfo.processInfo.systemUptime) { self.transmit(c) }
                if !self.throttle.hasPending { self.flusher = nil; return }
            }
        }
    }

    private func transmit(_ cmd: ClientCommand) {
        guard let task else { return }
        let id = nextId
        nextId = nextId == UInt32.max ? 1 : nextId + 1
        task.send(.string(cmd.json(id: id))) { _ in }
    }

    private func apply(_ e: LiveEvent) {
        // The 30 Hz animation tick must not invalidate observers when there is nothing to animate.
        if case .meterTick = e, model.meters == nil { return }
        LiveReducer.reduce(&model, e)
        if model.sceneChanges != lastSceneChanges {
            lastSceneChanges = model.sceneChanges
            onSceneChange?()
        }
        if case .meterTick = e { return }
        onChange?(model)
    }
}
