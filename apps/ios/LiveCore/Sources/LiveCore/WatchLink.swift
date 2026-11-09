import Foundation

/// Phone <-> Apple Watch link over WatchConnectivity (plist-safe dictionaries, versioned).
///
/// - `applicationContext` (phone → watch): the engine config (endpoint, token, name) so the watch can talk to the
///   engine itself, plus the latest `Snapshot`.
/// - `sendMessage` (phone → watch): live `Snapshot` updates while the watch app is reachable (throttled).
/// - `sendMessage` (watch → phone): `Command` relayed by the phone's `LiveClient` (watchOS restricts low-level
///   networking — TN3135 — so the phone relay is the default path; direct LAN is the fallback).
public enum WatchLink {
    public static let version = 1
    static let vKey = "v", kindKey = "k", payloadKey = "p"

    public struct EngineConfig: Codable, Equatable, Sendable {
        public var name: String
        public var endpoint: EngineEndpoint
        public var token: String
        public init(name: String, endpoint: EngineEndpoint, token: String) { self.name = name; self.endpoint = endpoint; self.token = token }
    }

    /// What the watch shows (and the complication). Small on purpose: sent up to 5×/s.
    public struct Snapshot: Codable, Equatable, Sendable {
        public var engineName: String
        public var connected: Bool
        public var role: Role
        public var song: String?
        public var part: String?
        public var nextPart: String?
        public var mute: Bool
        public var bypass: Bool
        /// Input level 0..1 (`MeterLevels.fraction`).
        public var inLevel: Double
        public var position: Position?

        public init(engineName: String = "", connected: Bool = false, role: Role = .viewer, song: String? = nil, part: String? = nil,
                    nextPart: String? = nil, mute: Bool = false, bypass: Bool = false, inLevel: Double = 0, position: Position? = nil) {
            self.engineName = engineName; self.connected = connected; self.role = role; self.song = song; self.part = part
            self.nextPart = nextPart; self.mute = mute; self.bypass = bypass; self.inLevel = inLevel; self.position = position
        }

        public init(model m: LiveModel, engineName: String) {
            let st = m.state
            let name = (m.hello?.engineName).flatMap { $0.isEmpty ? nil : $0 } ?? engineName
            self.init(engineName: name, connected: m.connected, role: m.role,
                      song: st?.currentSong?.title, part: st?.currentPart?.name ?? (st?.setlist == nil ? st?.preset : nil),
                      nextPart: st?.nextPart.map { $0.part.name }, mute: st?.mix.mute ?? false, bypass: st?.mix.bypass ?? false,
                      inLevel: MeterLevels.fraction(m.levels.inDb), position: st?.position)
        }

        /// Same content except the level (level changes alone are sent at a lower rate).
        public func sameContent(_ o: Snapshot) -> Bool {
            var a = self, b = o
            a.inLevel = 0; b.inLevel = 0
            return a == b
        }
    }

    public enum Command: String, Codable, Sendable, CaseIterable {
        case next, prev, mute, unmute, panic, tap

        public var client: ClientCommand {
            switch self {
            case .next: .next
            case .prev: .prev
            case .mute: .setMix(MixChange(mute: true))
            case .unmute: .setMix(MixChange(mute: false))
            case .panic: .panic
            case .tap: .tapTempo
            }
        }
    }

    public enum Message: Equatable, Sendable {
        case config(EngineConfig?, Snapshot)
        case snapshot(Snapshot)
        case command(Command)
    }

    public static func encode(_ m: Message) -> [String: Any] {
        let e = JSONEncoder()
        func pack<T: Encodable>(_ kind: String, _ v: T) -> [String: Any] {
            [vKey: version, kindKey: kind, payloadKey: (try? e.encode(v)) ?? Data()]
        }
        switch m {
        case .config(let c, let s): return pack("config", ConfigPayload(config: c, snapshot: s))
        case .snapshot(let s): return pack("snap", s)
        case .command(let c): return pack("cmd", c)
        }
    }

    public static func decode(_ d: [String: Any]) -> Message? {
        guard (d[vKey] as? Int) == version, let kind = d[kindKey] as? String, let data = d[payloadKey] as? Data else { return nil }
        let j = JSONDecoder()
        switch kind {
        case "config": return (try? j.decode(ConfigPayload.self, from: data)).map { .config($0.config, $0.snapshot) }
        case "snap": return (try? j.decode(Snapshot.self, from: data)).map(Message.snapshot)
        case "cmd": return (try? j.decode(Command.self, from: data)).map(Message.command)
        default: return nil
        }
    }

    struct ConfigPayload: Codable { var config: EngineConfig?; var snapshot: Snapshot }

    /// Send policy for live snapshots: content changes at most every 150 ms, level-only changes every 250 ms and only
    /// when the level moved by more than 3 %.
    public static func shouldSend(prev: Snapshot?, next: Snapshot, sinceLast: Double) -> Bool {
        guard let prev else { return true }
        if !prev.sameContent(next) { return sinceLast >= 0.15 }
        return sinceLast >= 0.25 && abs(prev.inLevel - next.inLevel) > 0.03
    }
}
