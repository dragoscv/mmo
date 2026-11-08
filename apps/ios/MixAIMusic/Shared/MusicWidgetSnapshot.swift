import Foundation

// Compiled into MixAI Music, its widget extension and its intents extension. The app writes, extensions read.

/// App Group of MixAI Music (portal id H579PJPC6H).
enum MusicAppGroup {
    static let id = "group.ro.mixai.music"
    static var container: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id) }
    static var snapshotFile: URL? { container?.appendingPathComponent("now-playing.json") }
    static var coverFile: URL? { container?.appendingPathComponent("now-playing-cover.jpg") }
    /// Commands from widget / control buttons when the app process is not running them in-process.
    static var defaults: UserDefaults? { UserDefaults(suiteName: id) }
}

enum MusicWidgetKinds {
    static let nowPlaying = "ro.mixai.music.nowplaying"
    static let control = "ro.mixai.music.control.playpause"
}

/// What the widget shows: current track + state; written on every track / state change.
struct MusicWidgetSnapshot: Codable, Equatable, Sendable {
    var title: String
    var artist: String?
    var album: String?
    var playing: Bool
    var hasCover: Bool
    var serverName: String?
    var updatedAt: Date

    static func load() -> MusicWidgetSnapshot? {
        guard let f = MusicAppGroup.snapshotFile, let d = try? Data(contentsOf: f) else { return nil }
        return try? JSONDecoder().decode(MusicWidgetSnapshot.self, from: d)
    }

    func save() {
        guard let f = MusicAppGroup.snapshotFile, let d = try? JSONEncoder().encode(self) else { return }
        try? d.write(to: f, options: .atomic)
    }
}
