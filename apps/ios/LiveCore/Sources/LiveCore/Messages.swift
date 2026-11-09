import Foundation

/// Server → client messages (one JSON object per WebSocket text frame).
public enum ServerMessage: Sendable, Equatable {
    case hello(Hello)
    case state(SessionState)
    case meters(Meters)
    case ack(id: UInt32?)
    case error(id: UInt32?, code: String, message: String)
    case pong
    /// Unknown `type`: ignored (forward compatible).
    case unknown(String)

    private struct Envelope: Decodable { let type: String }
    private struct StateEnvelope: Decodable { let state: SessionState }
    private struct AckEnvelope: Decodable { let id: UInt32? }
    private struct ErrorEnvelope: Decodable { let id: UInt32?; let code: String?; let message: String? }

    public static func decode(_ text: String) -> ServerMessage? {
        decode(Data(text.utf8))
    }

    public static func decode(_ data: Data) -> ServerMessage? {
        let d = JSONDecoder()
        guard let env = try? d.decode(Envelope.self, from: data) else { return nil }
        switch env.type {
        case "hello": return (try? d.decode(Hello.self, from: data)).map(ServerMessage.hello)
        case "state": return (try? d.decode(StateEnvelope.self, from: data)).map { .state($0.state) }
        case "meters": return (try? d.decode(Meters.self, from: data)).map(ServerMessage.meters)
        case "ack": return .ack(id: (try? d.decode(AckEnvelope.self, from: data))?.id)
        case "error":
            let e = try? d.decode(ErrorEnvelope.self, from: data)
            return .error(id: e?.id, code: e?.code ?? "bad_request", message: e?.message ?? "")
        case "pong": return .pong
        default: return .unknown(env.type)
        }
    }
}

/// Partial mix update (`set_mix`): only the fields that are set are sent.
public struct MixChange: Sendable, Equatable {
    public var inputDb: Float?
    public var mainDb: Float?
    public var monitorDb: Float?
    public var monitorDry: Float?
    public var bypass: Bool?
    public var mute: Bool?

    public init(inputDb: Float? = nil, mainDb: Float? = nil, monitorDb: Float? = nil, monitorDry: Float? = nil, bypass: Bool? = nil, mute: Bool? = nil) {
        self.inputDb = inputDb; self.mainDb = mainDb; self.monitorDb = monitorDb; self.monitorDry = monitorDry
        self.bypass = bypass; self.mute = mute
    }

    public func applied(to m: MixState) -> MixState {
        var m = m
        if let v = inputDb { m.inputDb = v }
        if let v = mainDb { m.mainDb = v }
        if let v = monitorDb { m.monitorDb = v }
        if let v = monitorDry { m.monitorDry = v }
        if let v = bypass { m.bypass = v }
        if let v = mute { m.mute = v }
        return m
    }

    /// Later values win (used to coalesce throttled slider moves).
    public func merged(with o: MixChange) -> MixChange {
        MixChange(inputDb: o.inputDb ?? inputDb, mainDb: o.mainDb ?? mainDb, monitorDb: o.monitorDb ?? monitorDb,
                  monitorDry: o.monitorDry ?? monitorDry, bypass: o.bypass ?? bypass, mute: o.mute ?? mute)
    }
}

/// Client → server commands.
public enum ClientCommand: Sendable, Equatable {
    case subscribe(meters: Bool, hz: Int? = nil)
    case setParam(insert: UInt32, param: String, value: Float)
    case setParamNorm(insert: UInt32, param: String, norm: Float)
    case setEnabled(insert: UInt32, on: Bool)
    case addInsert(fx: String, at: UInt32)
    case removeInsert(insert: UInt32)
    case moveInsert(insert: UInt32, to: UInt32)
    case loadPreset(name: String)
    case savePreset(name: String)
    case setMix(MixChange)
    case loadSetlist(Setlist)
    case goto(song: Int, part: Int)
    case next, prev, tapTempo, panic, latencyProbe
    case ping(t: Double)

    public var type: String {
        switch self {
        case .subscribe: "subscribe"
        case .setParam: "set_param"
        case .setParamNorm: "set_param_norm"
        case .setEnabled: "set_enabled"
        case .addInsert: "add_insert"
        case .removeInsert: "remove_insert"
        case .moveInsert: "move_insert"
        case .loadPreset: "load_preset"
        case .savePreset: "save_preset"
        case .setMix: "set_mix"
        case .loadSetlist: "load_setlist"
        case .goto: "goto"
        case .next: "next"
        case .prev: "prev"
        case .tapTempo: "tap_tempo"
        case .panic: "panic"
        case .latencyProbe: "latency_probe"
        case .ping: "ping"
        }
    }

    /// Lowest role the engine accepts this from (mirrors `Control::required_role`).
    public var requiredRole: Role {
        switch self {
        case .subscribe, .ping: .viewer
        case .loadPreset, .setMix, .goto, .next, .prev, .tapTempo, .panic: .performer
        default: .controller
        }
    }

    /// Throttle key: commands with the same key coalesce (sliders); nil = send immediately.
    public var coalesceKey: String? {
        switch self {
        case .setParam(let i, let p, _), .setParamNorm(let i, let p, _): "p:\(i):\(p)"
        case .setMix(let c) where c.bypass == nil && c.mute == nil: "mix"
        default: nil
        }
    }

    /// JSON text frame. `id` is echoed by the engine in `ack` / `error`.
    public func json(id: UInt32? = nil) -> String {
        var o: [String: Any] = ["type": type]
        if let id { o["id"] = id }
        switch self {
        case .subscribe(let m, let hz):
            o["meters"] = m
            if let hz { o["meters_hz"] = Swift.min(30, Swift.max(1, hz)) }
        case .setParam(let i, let p, let v): o["insert"] = i; o["param"] = p; o["value"] = Double(v)
        case .setParamNorm(let i, let p, let n): o["insert"] = i; o["param"] = p; o["norm"] = Double(Swift.min(1, Swift.max(0, n)))
        case .setEnabled(let i, let on): o["insert"] = i; o["on"] = on
        case .addInsert(let fx, let at): o["fx"] = fx; o["at"] = at
        case .removeInsert(let i): o["insert"] = i
        case .moveInsert(let i, let to): o["insert"] = i; o["to"] = to
        case .loadPreset(let n), .savePreset(let n): o["name"] = n
        case .setMix(let c):
            if let v = c.inputDb { o["input_db"] = Double(v) }
            if let v = c.mainDb { o["main_db"] = Double(v) }
            if let v = c.monitorDb { o["monitor_db"] = Double(v) }
            if let v = c.monitorDry { o["monitor_dry"] = Double(v) }
            if let v = c.bypass { o["bypass"] = v }
            if let v = c.mute { o["mute"] = v }
        case .loadSetlist(let s):
            if let data = try? JSONEncoder().encode(s), let obj = try? JSONSerialization.jsonObject(with: data) { o["setlist"] = obj }
        case .goto(let s, let p): o["song"] = s; o["part"] = p
        case .ping(let t): o["t"] = t
        case .next, .prev, .tapTempo, .panic, .latencyProbe: break
        }
        let data = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
