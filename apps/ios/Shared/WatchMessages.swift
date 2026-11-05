import Foundation

// WatchConnectivity contract between the iPhone app and MixAIWatch (compiled into both targets).
// Phone → watch: `updateApplicationContext(WatchContext.dictionary)` whenever playback or TV list changes.
// Watch → phone: `sendMessage(WatchCommand.dictionary, replyHandler:)`; the reply carries `["ok": Bool]`.

struct WatchContext: Codable, Sendable, Equatable {
    struct Tv: Codable, Sendable, Hashable, Identifiable {
        var id: String
        var name: String
        var nowPlaying: String?
        var playing: Bool
    }

    var title: String?
    var subtitle: String?
    var playing: Bool
    var positionSec: Double
    var durationSec: Double
    /// "music" | "video" | "live" | "none"
    var source: String
    var tvs: [Tv]
    var serverName: String?
    var updatedAt: Date

    static let key = "ctx"

    var dictionary: [String: Any] {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        guard let data = try? e.encode(self) else { return [:] }
        return [Self.key: data]
    }

    init(title: String? = nil, subtitle: String? = nil, playing: Bool = false, positionSec: Double = 0, durationSec: Double = 0,
         source: String = "none", tvs: [Tv] = [], serverName: String? = nil, updatedAt: Date = .now) {
        self.title = title
        self.subtitle = subtitle
        self.playing = playing
        self.positionSec = positionSec
        self.durationSec = durationSec
        self.source = source
        self.tvs = tvs
        self.serverName = serverName
        self.updatedAt = updatedAt
    }

    init?(dictionary: [String: Any]) {
        guard let data = dictionary[Self.key] as? Data else { return nil }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        guard let v = try? d.decode(WatchContext.self, from: data) else { return nil }
        self = v
    }
}

struct WatchCommand: Codable, Sendable, Equatable {
    enum Action: String, Codable, Sendable {
        case toggle, play, pause, next, previous
        case skipForward, skipBack
        case volumeUp, volumeDown
        case navigateHome
    }

    var action: Action
    /// nil = whatever plays on the phone; else a hub deviceId (a TV).
    var target: String?

    static let key = "cmd"

    var dictionary: [String: Any] {
        guard let data = try? JSONEncoder().encode(self) else { return [:] }
        return [Self.key: data]
    }

    init(action: Action, target: String? = nil) {
        self.action = action
        self.target = target
    }

    init?(dictionary: [String: Any]) {
        guard let data = dictionary[Self.key] as? Data, let v = try? JSONDecoder().decode(WatchCommand.self, from: data) else { return nil }
        self = v
    }
}
