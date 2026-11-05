import Foundation
import MixaiCore
import WidgetKit

/// Writes the App Group snapshot the widgets read (Continue Watching for the active profile + Now Playing).
@MainActor
enum WidgetWriter {
    static func update(app: AppModel) async {
        guard AppGroup.container != nil else { return }
        let old = WidgetSnapshot.load()
        var snap = old
        snap.serverName = app.server?.name
        snap.activeProfileId = app.activeProfile?.id

        if let store = app.homeStore, let profile = app.activeProfile {
            let home = await store.cached(profile: profile.id)
            let cards = Array(home?.rows.first { $0.id == "continue" }?.items.prefix(6) ?? [])
            var items: [WidgetSnapshot.Item] = []
            for c in cards {
                let file = await cacheImage(app: app, name: "\(c.kind.rawValue)-\(c.tmdbId).jpg", path: c.posterPath)
                var subtitle: String?
                if let n = c.nextEpisode { subtitle = "S\(n.season) E\(n.episode)" }
                items.append(.init(kind: c.kind.rawValue, tmdbId: c.tmdbId, title: c.title, subtitle: subtitle, progress: c.progress, imageFile: file))
            }
            let row = WidgetSnapshot.ProfileRow(profileId: profile.id, profileName: profile.name, items: items)
            if let i = snap.profiles.firstIndex(where: { $0.profileId == profile.id }) { snap.profiles[i] = row } else { snap.profiles.append(row) }
        }

        if let r = app.player.request {
            let live: Bool
            if case .live = r.source { live = true } else { live = false }
            snap.nowPlaying = .init(title: r.title, subtitle: r.subtitle, playing: app.player.playing, source: live ? .live : .video, imageFile: nil,
                                    updatedAt: old.nowPlaying?.title == r.title && old.nowPlaying?.playing == app.player.playing ? (old.nowPlaying?.updatedAt ?? .now) : .now)
        } else if let t = app.music.current {
            let file = await cacheImage(app: app, name: "track-\(t.albumId).jpg", url: app.musicStore?.coverURL(t.coverUrlPath))
            snap.nowPlaying = .init(title: t.title, subtitle: t.artist, playing: app.music.playing, source: .music, imageFile: file,
                                    updatedAt: old.nowPlaying?.title == t.title && old.nowPlaying?.playing == app.music.playing ? (old.nowPlaying?.updatedAt ?? .now) : .now)
        } else {
            snap.nowPlaying = nil
        }

        var cmpOld = old, cmpNew = snap
        cmpOld.updatedAt = .distantPast
        cmpNew.updatedAt = .distantPast
        guard cmpOld != cmpNew else { return }
        snap.updatedAt = .now
        snap.save()
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.continueWatching)
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.nowPlaying)
    }

    private static func cacheImage(app: AppModel, name: String, path: String?) async -> String? {
        await cacheImage(app: app, name: name, url: app.client?.tmdbImageURL(size: "w342", path: path))
    }

    /// Downloads once into `AppGroup.imagesDir`; returns the file name when present.
    private static func cacheImage(app: AppModel, name: String, url: URL?) async -> String? {
        guard let dir = AppGroup.imagesDir else { return nil }
        let dest = dir.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: dest.path) { return name }
          guard let url, let result = try? await URLSession.shared.data(from: url) else { return nil }
          let data = result.0
          guard let http = result.1 as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard (try? data.write(to: dest, options: .atomic)) != nil else { return nil }
        return name
    }
}
