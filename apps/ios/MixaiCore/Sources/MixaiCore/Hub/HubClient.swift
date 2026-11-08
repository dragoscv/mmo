import Foundation

/// Remote command from the hub (`cmd {from, action, args, seq}`).
public struct HubCommand: Sendable {
    public let action: String
    public let args: [String: JSONValue]
    public let seq: String
    public let fromName: String
}

public enum HubStatus: Sendable { case disconnected, connecting, connected }

/// WebSocket client for the MMO Server hub (`WS /hub?t=<token>`, port of tv-android `HubClient`).
/// Registers this iPhone (`hello`, platform "ios"), keeps a clock offset (`time` pings → ClockEstimator),
/// receives remote commands and other devices. Reconnects with backoff 1 s → 30 s.
public actor HubClient {
    public static let caps = ["play", "pause", "seek", "stop", "next", "previous", "text", "navigate", "playback"]
    /// MixAI Music: a music output for other devices (hub queue handoff, D53) — no video playback.
    public static let musicCaps = ["play", "pause", "seek", "stop", "next", "previous", "music"]

    private let client: MmoClient
    private let deviceId: String
    private let deviceName: String
    private let caps: [String]
    private var profileId: String?
    private var task: URLSessionWebSocketTask?
    private var loop: Task<Void, Never>?
    private var pings: Task<Void, Never>?
    public private(set) var clock = ClockEstimator()
    public private(set) var status: HubStatus = .disconnected
    public private(set) var devices: [HubDevice] = []
    public private(set) var connId: String?

    private var commandHandlers: [@Sendable (HubCommand) -> Void] = []
    private var statusHandlers: [@Sendable (HubStatus) -> Void] = []
    private var messageHandlers: [@Sendable (JSONValue) -> Void] = []
    private var deviceHandlers: [@Sendable ([HubDevice]) -> Void] = []

    public init(client: MmoClient, deviceId: String, deviceName: String, profileId: String?, caps: [String] = HubClient.caps) {
        self.client = client
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.profileId = profileId
        self.caps = caps
    }

    public func onCommand(_ h: @escaping @Sendable (HubCommand) -> Void) { commandHandlers.append(h) }
    public func onStatus(_ h: @escaping @Sendable (HubStatus) -> Void) { statusHandlers.append(h) }
    /// Every decoded message (Watch Together `room:*`, `report:ok`, `block:ok`, `error`, `welcome`).
    public func onMessage(_ h: @escaping @Sendable (JSONValue) -> Void) { messageHandlers.append(h) }
    public func onDevices(_ h: @escaping @Sendable ([HubDevice]) -> Void) { deviceHandlers.append(h) }

    /// Send a raw message (room protocol). Dropped while disconnected.
    public func sendRaw(_ o: [String: JSONValue]) { send(o) }

    /// Remote-control a device through the hub socket (ack arrives as an `ack` message).
    public func command(target: String, action: String, args: [String: JSONValue] = [:]) {
        send(["type": .string("cmd"), "target": .string(target), "action": .string(action), "args": .object(args), "seq": .string(UUID().uuidString)])
    }

    public func serverNowMs() -> Double { Date().timeIntervalSince1970 * 1000 + clock.offsetMs }

    public func start() {
        guard loop == nil else { return }
        loop = Task { await self.connectLoop() }
    }

    public func stop() {
        loop?.cancel(); loop = nil
        pings?.cancel(); pings = nil
        task?.cancel(with: .normalClosure, reason: nil); task = nil
        setStatus(.disconnected)
    }

    public func setProfile(_ id: String?) {
        profileId = id
        sendHello()
    }

    private func setStatus(_ s: HubStatus) {
        status = s
        for h in statusHandlers { h(s) }
    }

    private func connectLoop() async {
        var backoff: Double = 1
        while !Task.isCancelled {
            guard let url = URL(string: client.hubURL()) else { return }
            setStatus(.connecting)
            let ws = URLSession.shared.webSocketTask(with: url)
            task = ws
            ws.resume()
            var opened = false
            sendHello()
            startPings()
            do {
                while !Task.isCancelled {
                    let msg = try await ws.receive()
                    if !opened { opened = true; setStatus(.connected) }
                    if case .string(let s) = msg { handle(s) }
                }
            } catch {}
            pings?.cancel()
            if task === ws { task = nil }
            setStatus(.disconnected)
            if Task.isCancelled { break }
            backoff = opened ? 1 : min(30, backoff * 2)
            try? await Task.sleep(for: .seconds(backoff))
        }
    }

    private func startPings() {
        pings?.cancel()
        pings = Task {
            for _ in 0..<3 { self.ping(); try? await Task.sleep(for: .seconds(1)) }
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(30)); self.ping() }
        }
    }

    private func ping() { send(["type": .string("time"), "t0": .number(Date().timeIntervalSince1970 * 1000)]) }

    private func sendHello() {
        var o: [String: JSONValue] = [
            "type": .string("hello"),
            "deviceId": .string(deviceId),
            "name": .string(deviceName),
            "platform": .string(ClientIdentity.current.platform),
            "caps": .array(caps.map { .string($0) }),
            "app": .string(ClientIdentity.current.appTag),
        ]
        if let p = profileId { o["profileId"] = .string(p) }
        send(o)
    }

    func handle(_ text: String) {
        guard let v = try? JSON.decoder.decode(JSONValue.self, from: Data(text.utf8)) else { return }
        for h in messageHandlers { h(v) }
        switch v["type"]?.stringValue {
        case "welcome":
            connId = v["you"]?["connId"]?.stringValue
        case "time":
            let t3 = Date().timeIntervalSince1970 * 1000
            guard let t0 = v["t0"]?.doubleValue, let t1 = v["t1"]?.doubleValue, let t2 = v["t2"]?.doubleValue else { return }
            clock.add(sampleFrom(t0: t0, t1: t1, t2: t2, t3: t3))
        case "cmd":
            guard let action = v["action"]?.stringValue else { return }
            var args: [String: JSONValue] = [:]
            if case .object(let o)? = v["args"] { args = o }
            let cmd = HubCommand(action: action, args: args, seq: v["seq"]?.stringValue ?? "", fromName: v["from"]?["name"]?.stringValue ?? "")
            for h in commandHandlers { h(cmd) }
        case "devices":
            if case .array(let arr)? = v["devices"], let data = try? JSON.encoder.encode(arr) {
                devices = (try? JSON.decoder.decode([HubDevice].self, from: data)) ?? []
                let list = devices
                for h in deviceHandlers { h(list) }
            }
        default:
            break
        }
    }

    /// Acknowledge a command.
    public func ack(seq: String, ok: Bool, error: String? = nil) {
        guard !seq.isEmpty else { return }
        var o: [String: JSONValue] = ["type": .string("ack"), "seq": .string(seq), "ok": .bool(ok)]
        if let error { o["error"] = .string(error) }
        send(o)
    }

    public func reportState(playing: Bool, positionSec: Double, durationSec: Double?, media: HubMedia?) {
        var o: [String: JSONValue] = ["type": .string("state"), "playing": .bool(playing), "positionSec": .number(positionSec)]
        if let durationSec { o["durationSec"] = .number(durationSec) }
        if let media, let data = try? JSON.encoder.encode(media), let mv = try? JSON.decoder.decode(JSONValue.self, from: data) { o["media"] = mv }
        send(o)
    }

    public func reportIdle() { send(["type": .string("state"), "idle": .bool(true)]) }

    private func send(_ o: [String: JSONValue]) {
        guard let task, let data = try? JSON.encoder.encode(JSONValue.object(o)) else { return }
        task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
    }
}
