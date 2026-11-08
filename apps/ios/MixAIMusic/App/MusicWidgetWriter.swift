import Foundation
import MixaiCore
import MixaiUI
import WidgetKit

extension MusicWidgetSnapshot {
    /// Writes the App Group snapshot (+ cover copy) and reloads the widget / control when something changed.
    @MainActor
    static func write(player: MusicPlayer, store: MusicStore?, serverName: String?) async {
        guard MusicAppGroup.container != nil else { return }
        guard let t = player.current else { clear(); return }
        let old = load()
        var cover = false
        if let dest = MusicAppGroup.coverFile {
            let cached = MusicPlayer.coverCacheURL(albumId: t.albumId)
            if old?.album != t.album || old?.title != t.title || !FileManager.default.fileExists(atPath: dest.path) {
                var data = try? Data(contentsOf: cached)
                if data == nil, let u = store?.coverURL(t.coverUrlPath), let res = try? await URLSession.shared.data(from: u),
                   (res.1 as? HTTPURLResponse)?.statusCode == 200 {
                    data = res.0
                }
                if let data { try? data.write(to: dest, options: .atomic) }
            }
            cover = FileManager.default.fileExists(atPath: dest.path)
        }
        let snap = MusicWidgetSnapshot(title: t.title, artist: t.artist, album: t.album, playing: player.playing, hasCover: cover,
                                       serverName: serverName, updatedAt: old?.title == t.title && old?.playing == player.playing ? (old?.updatedAt ?? .now) : .now)
        guard snap != old else { return }
        snap.save()
        WidgetCenter.shared.reloadTimelines(ofKind: MusicWidgetKinds.nowPlaying)
        ControlCenter.shared.reloadControls(ofKind: MusicWidgetKinds.control)
    }

    @MainActor
    static func clear() {
        if let f = MusicAppGroup.snapshotFile, FileManager.default.fileExists(atPath: f.path) {
            try? FileManager.default.removeItem(at: f)
            WidgetCenter.shared.reloadTimelines(ofKind: MusicWidgetKinds.nowPlaying)
            ControlCenter.shared.reloadControls(ofKind: MusicWidgetKinds.control)
        }
    }
}
