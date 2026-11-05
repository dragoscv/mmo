import Foundation

// Compiled into the app AND the MixAIWidgets extension (project.yml `Shared/`). The app writes, widgets read.

/// App Group shared by the app and its extensions (portal id NKWP24X8HR).
enum AppGroup {
    static let id = "group.ro.mixai.app"

    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
    }

    /// Poster / cover thumbnails the app copies for widgets (widgets never hit the MMO Server).
    static var imagesDir: URL? { container?.appendingPathComponent("widget-img", isDirectory: true) }

    static func imageURL(_ file: String?) -> URL? {
        guard let file, !file.isEmpty else { return nil }
        return imagesDir?.appendingPathComponent(file)
    }
}

/// Deep links handled by `MixAIApp.onOpenURL` (scheme `mixai`).
enum DeepLink {
    static func title(kind: String, tmdbId: Int) -> URL { URL(string: "mixai://title/\(kind)/\(tmdbId)")! }
    static let nowPlaying = URL(string: "mixai://nowplaying")!
    static let live = URL(string: "mixai://live")!
    static let downloads = URL(string: "mixai://downloads")!
    static let remote = URL(string: "mixai://remote")!
}

/// What the widgets show: Continue Watching per profile + the current Now Playing item.
struct WidgetSnapshot: Codable, Sendable, Equatable {
    struct Item: Codable, Sendable, Hashable, Identifiable {
        var kind: String
        var tmdbId: Int
        var title: String
        var subtitle: String?
        /// Watched fraction 0...1.
        var progress: Double?
        /// File name inside `AppGroup.imagesDir`.
        var imageFile: String?
        var id: String { "\(kind)-\(tmdbId)" }
    }

    struct ProfileRow: Codable, Sendable, Equatable, Identifiable {
        var profileId: String
        var profileName: String
        var items: [Item]
        var id: String { profileId }
    }

    struct NowPlaying: Codable, Sendable, Equatable {
        enum Source: String, Codable, Sendable { case music, video, live }
        var title: String
        var subtitle: String?
        var playing: Bool
        var source: Source
        var imageFile: String?
        var updatedAt: Date
    }

    var profiles: [ProfileRow] = []
    var activeProfileId: String?
    var nowPlaying: NowPlaying?
    var serverName: String?
    var updatedAt: Date = .distantPast

    static let fileName = "widget-snapshot.json"

    static var fileURL: URL? { AppGroup.container?.appendingPathComponent(fileName) }

    static func load() -> WidgetSnapshot {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return WidgetSnapshot() }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return (try? d.decode(WidgetSnapshot.self, from: data)) ?? WidgetSnapshot()
    }

    func save() {
        guard let url = Self.fileURL else { return }
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        if let data = try? e.encode(self) { try? data.write(to: url, options: .atomic) }
    }

    func row(for profileId: String?) -> ProfileRow? {
        let id = profileId ?? activeProfileId
        return profiles.first { $0.profileId == id } ?? profiles.first
    }
}

/// WidgetKit kinds (reload targets).
enum WidgetKinds {
    static let continueWatching = "ro.mixai.widget.continue"
    static let nowPlaying = "ro.mixai.widget.nowplaying"
}
