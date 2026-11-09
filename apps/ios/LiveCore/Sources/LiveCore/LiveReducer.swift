import Foundation

/// Connection lifecycle as the UI sees it.
public enum ConnectionPhase: Equatable, Sendable {
    case idle
    case connecting(attempt: Int)
    case connected
    /// Waiting before the next reconnect attempt.
    case waiting(attempt: Int, seconds: Double)
    /// Will not retry on its own (bad token, protocol too new).
    case failed(LiveFailure)
}

public enum LiveFailure: String, Equatable, Sendable {
    case unauthorized
    case protocolTooNew = "protocol_too_new"
    case unreachable
}

/// Everything a controller screen renders. Mutated only by `LiveReducer.reduce` (pure, unit tested).
public struct LiveModel: Equatable, Sendable {
    public var phase: ConnectionPhase = .idle
    public var hello: Hello?
    public var state: SessionState?
    public var meters: Meters?
    public var lastError: LiveError?
    /// Bumped each time the setlist position changes (haptics / teleprompter scroll).
    public var sceneChanges: Int = 0
    /// Smoothed meter levels for animation (dBFS, -60 floor).
    public var levels = MeterLevels()

    public init() {}

    public var role: Role { hello?.role ?? .viewer }
    public var connected: Bool { phase == .connected }
    public func can(_ c: ClientCommand) -> Bool { connected && role >= c.requiredRole }
}

public struct LiveError: Equatable, Sendable {
    public var code: String
    public var message: String
    public init(code: String, message: String) { self.code = code; self.message = message }

    /// Catalog key for the error code (`live.error.<code>`).
    public var key: String {
        let known = ["unauthorized", "forbidden", "bad_request", "unknown_insert", "unknown_param", "unknown_preset", "unknown_fx",
                     "chain_full", "no_setlist", "rate_limited"]
        return "live.error." + (known.contains(code) ? code : "generic")
    }
}

/// Peak-hold style meter smoothing: instant attack, ~20 dB/s release.
public struct MeterLevels: Equatable, Sendable {
    public var inDb: Float = -60
    public var outLDb: Float = -60
    public var outRDb: Float = -60

    public static let floor: Float = -60

    public static func db(_ lin: Float) -> Float {
        guard lin.isFinite, lin > 0 else { return floor }
        return Swift.max(floor, 20 * log10(lin))
    }

    /// 0..1 for drawing (-60 dB → 0, +6 dB → 1).
    public static func fraction(_ db: Float) -> Double { Double(Swift.min(1, Swift.max(0, (db - floor) / 66))) }

    public func next(_ m: Meters, dt: Float) -> MeterLevels {
        func step(_ old: Float, _ new: Float) -> Float { new >= old ? new : Swift.max(new, old - 20 * dt) }
        var n = self
        n.inDb = step(inDb, Self.db(m.inPeak))
        n.outLDb = step(outLDb, Self.db(m.outPeak.first ?? 0))
        n.outRDb = step(outRDb, Self.db(m.outPeak.count > 1 ? m.outPeak[1] : m.outPeak.first ?? 0))
        return n
    }
}

public enum LiveEvent: Equatable, Sendable {
    case connecting(attempt: Int)
    case opened
    case received(ServerMessage)
    /// The socket closed; `httpStatus` when the upgrade itself was refused.
    case closed(httpStatus: Int?)
    case waiting(attempt: Int, seconds: Double)
    case disconnectedByUser
    /// Optimistic local change before the engine echoes `state`.
    case optimisticMix(MixChange)
    case clearError
    case meterTick(dt: Float)
}

public enum LiveReducer {
    public static func reduce(_ m: inout LiveModel, _ e: LiveEvent) {
        switch e {
        case .connecting(let a):
            m.phase = .connecting(attempt: a)
        case .opened:
            // `connected` only after `hello` proves the protocol.
            break
        case .received(let msg):
            receive(&m, msg)
        case .closed(let status):
            if status == 401 { m.phase = .failed(.unauthorized) }
            else if case .failed = m.phase {} else { m.phase = .idle }
            m.meters = nil
            m.levels = MeterLevels()
        case .waiting(let a, let s):
            if case .failed = m.phase { return }
            m.phase = .waiting(attempt: a, seconds: s)
        case .disconnectedByUser:
            m = LiveModel()
        case .optimisticMix(let c):
            guard var st = m.state else { return }
            st.mix = c.applied(to: st.mix)
            m.state = st
        case .clearError:
            m.lastError = nil
        case .meterTick(let dt):
            if let meters = m.meters { m.levels = m.levels.next(meters, dt: dt) }
        }
    }

    private static func receive(_ m: inout LiveModel, _ msg: ServerMessage) {
        switch msg {
        case .hello(let h):
            m.hello = h
            m.phase = h.protocolVersion > LiveProtocol.version ? .failed(.protocolTooNew) : .connected
        case .state(let s):
            if let old = m.state, old.revision > s.revision, s.revision != 0 { return }
            let moved = m.state?.position != s.position && s.position != nil
            if moved && m.state != nil { m.sceneChanges &+= 1 }
            m.state = s
        case .meters(let meters):
            m.meters = meters
            m.levels = m.levels.next(meters, dt: 0)
        case .error(_, let code, let message):
            m.lastError = LiveError(code: code, message: message)
        case .ack, .pong, .unknown:
            break
        }
    }

    /// Reconnect delay: 0.5 s, 1, 2, 4, 8, capped at 10 s.
    public static func backoff(attempt: Int) -> Double {
        let a = Swift.max(0, Swift.min(attempt, 10))
        return Swift.min(10, 0.5 * pow(2, Double(a)))
    }

    /// Whether to retry after a close with this phase (not after unauthorized / protocol too new / user stop).
    public static func shouldRetry(_ phase: ConnectionPhase) -> Bool {
        if case .failed = phase { return false }
        return true
    }
}
