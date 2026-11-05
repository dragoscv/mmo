import Foundation

/// Watch Together room as seen by this member, reduced from hub `room:*` messages (server/src/hub/core.ts).
public struct RoomState: Sendable, Equatable {
    public struct Member: Sendable, Hashable, Identifiable {
        public let connId: String
        public let deviceId: String
        public let name: String
        public let ready: Bool
        public let guest: Bool
        public var id: String { connId }
    }

    public struct ChatLine: Sendable, Hashable, Identifiable {
        public enum Kind: Sendable, Hashable { case chat(String), reaction(String) }
        public let id: String
        public let fromConnId: String
        public let fromDeviceId: String
        public let name: String
        public let kind: Kind
        public let masked: Bool
        public let ts: Double
    }

    public var roomId: String?
    public var name: String = ""
    public var invite: String?
    public var phase: HubRoomPhase = .idle
    public var media: HubMedia?
    public var anchor: PlaybackAnchor?
    public var hostConnId: String?
    public var members: [Member] = []
    public var chat: [ChatLine] = []
    public var blockedDeviceIds: Set<String> = []
    public var reported: Set<String> = []
    public var kicked = false
    public var lastError: String?
    /// connId of THIS device (from hub `welcome`).
    public var me: String?

    public init() {}

    public var isHost: Bool { me != nil && me == hostConnId }
    public var inRoom: Bool { roomId != nil && !kicked }

    public static let maxChat = 200

    /// Applies one hub message (already JSON-decoded). Returns true when it was a room message.
    @discardableResult
    public mutating func apply(_ v: JSONValue) -> Bool {
        guard let type = v["type"]?.stringValue else { return false }
        switch type {
        case "welcome":
            me = v["you"]?["connId"]?.stringValue
            return false
        case "room:created":
            roomId = v["roomId"]?.stringValue
            invite = v["invite"]?.stringValue
        case "room:joined":
            roomId = v["roomId"]?.stringValue
            name = v["name"]?.stringValue ?? name
            if let inv = v["invite"]?.stringValue { invite = inv }
            kicked = false
            lastError = nil
        case "room:left":
            if v["roomId"]?.stringValue == roomId { self = RoomState.reset(keepingMe: me, blocked: blockedDeviceIds) }
        case "room:kicked":
            kicked = true
            phase = .idle
        case "room:state":
            phase = v["phase"]?.stringValue.flatMap(HubRoomPhase.init(rawValue:)) ?? .unknown
            if case .object? = v["media"], let data = try? JSON.encoder.encode(v["media"]!) {
                media = try? JSON.decoder.decode(HubMedia.self, from: data)
            } else {
                media = nil
            }
            if let a = v["anchor"] {
                anchor = PlaybackAnchor(playing: a["playing"]?.boolValue ?? false, positionSec: a["positionSec"]?.doubleValue ?? 0,
                                        atServerMs: a["atServerMs"]?.doubleValue ?? 0, rate: a["rate"]?.doubleValue)
            }
        case "room:members":
            hostConnId = v["hostConnId"]?.stringValue
            if case .array(let arr)? = v["members"] {
                members = arr.compactMap { m in
                    guard let c = m["connId"]?.stringValue else { return nil }
                    return Member(connId: c, deviceId: m["deviceId"]?.stringValue ?? c, name: m["name"]?.stringValue ?? "?",
                                  ready: m["ready"]?.boolValue ?? false, guest: m["guest"]?.boolValue ?? false)
                }
            }
        case "room:chat", "room:react":
            guard let id = v["id"]?.stringValue else { return true }
            let from = v["from"]
            let dev = from?["deviceId"]?.stringValue ?? ""
            if blockedDeviceIds.contains(dev) { return true }
            let kind: ChatLine.Kind = type == "room:chat" ? .chat(v["text"]?.stringValue ?? "") : .reaction(v["emoji"]?.stringValue ?? "")
            chat.append(ChatLine(id: id, fromConnId: from?["connId"]?.stringValue ?? "", fromDeviceId: dev, name: from?["name"]?.stringValue ?? "?",
                                 kind: kind, masked: v["masked"]?.boolValue ?? false, ts: v["ts"]?.doubleValue ?? 0))
            if chat.count > Self.maxChat { chat.removeFirst(chat.count - Self.maxChat) }
        case "report:ok":
            if let m = v["messageId"]?.stringValue { reported.insert(m) }
        case "block:ok":
            guard let d = v["deviceId"]?.stringValue else { return true }
            if v["blocked"]?.boolValue == false { blockedDeviceIds.remove(d) } else {
                blockedDeviceIds.insert(d)
                chat.removeAll { $0.fromDeviceId == d }
            }
        case "error":
            lastError = v["error"]?.stringValue
            return roomId != nil || lastError == "room_not_found" || lastError == "kicked"
        default:
            return false
        }
        return true
    }

    static func reset(keepingMe me: String?, blocked: Set<String>) -> RoomState {
        var s = RoomState()
        s.me = me
        s.blockedDeviceIds = blocked
        return s
    }
}

/// Outgoing hub messages for a room (shapes = server core.ts `onRoom`).
public enum RoomMessage {
    public static func create(name: String?) -> [String: JSONValue] { ["type": .string("room:create"), "name": .string(name ?? "")] }
    public static func join(_ roomId: String) -> [String: JSONValue] { ["type": .string("room:join"), "roomId": .string(roomId)] }
    public static let leave: [String: JSONValue] = ["type": .string("room:leave")]
    public static func load(_ media: HubMedia, at positionSec: Double) -> [String: JSONValue] {
        var m: [String: JSONValue] = ["type": .string("room:load"), "positionSec": .number(positionSec)]
        if let data = try? JSON.encoder.encode(media), let v = try? JSON.decoder.decode(JSONValue.self, from: data) { m["media"] = v }
        return m
    }
    public static func play(at positionSec: Double?) -> [String: JSONValue] { with("room:play", positionSec) }
    public static func pause(at positionSec: Double?) -> [String: JSONValue] { with("room:pause", positionSec) }
    public static func seek(_ positionSec: Double) -> [String: JSONValue] { with("room:seek", positionSec) }
    public static func ready(_ ready: Bool, positionSec: Double) -> [String: JSONValue] {
        ["type": .string("room:ready"), "ready": .bool(ready), "positionSec": .number(positionSec)]
    }
    public static func report(positionSec: Double, rttMs: Double) -> [String: JSONValue] {
        ["type": .string("room:report"), "positionSec": .number(positionSec), "rttMs": .number(rttMs)]
    }
    public static func chat(_ text: String) -> [String: JSONValue] { ["type": .string("room:chat"), "text": .string(String(text.prefix(500)))] }
    public static func react(_ emoji: String, mediaSec: Double) -> [String: JSONValue] {
        ["type": .string("room:react"), "emoji": .string(emoji), "mediaSec": .number(mediaSec)]
    }
    public static func reportMessage(_ messageId: String, reason: String, roomId: String?) -> [String: JSONValue] {
        var m: [String: JSONValue] = ["type": .string("report"), "messageId": .string(messageId), "reason": .string(reason)]
        if let roomId { m["roomId"] = .string(roomId) }
        return m
    }
    public static func block(memberConnId: String) -> [String: JSONValue] { ["type": .string("block"), "memberId": .string(memberConnId)] }
    public static func unblock(deviceId: String) -> [String: JSONValue] { ["type": .string("unblock"), "deviceId": .string(deviceId)] }
    public static func kick(memberConnId: String) -> [String: JSONValue] { ["type": .string("kick"), "memberId": .string(memberConnId)] }

    public static let reportReasons = ["spam", "harassment", "hate", "sexual", "violence", "other"]

    private static func with(_ type: String, _ pos: Double?) -> [String: JSONValue] {
        var m: [String: JSONValue] = ["type": .string(type)]
        if let pos { m["positionSec"] = .number(pos) }
        return m
    }
}
