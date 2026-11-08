// CarPlay audio for MixAI Music (requested from Apple 2026-11-08 for ro.mixai.music). Compiled only with the
// `MIXAI_CARPLAY` flag: the flag, the `com.apple.developer.carplay-audio` entitlement and the scene manifest entry
// ship only after Apple grants the entitlement (project.yml comments). Tabs: Mix / Recent albums / Playlists /
// Downloads; lists respect the head unit's `CPListTemplate.maximumItemCount`.
#if MIXAI_CARPLAY
import CarPlay
import MixaiCore
import MixaiUI
import UIKit

@MainActor
final class MusicCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController
        let home = CPListTemplate(title: String(localized: "music.tab.home"), sections: [])
        home.tabImage = UIImage(systemName: "music.note.house")
        let playlists = CPListTemplate(title: String(localized: "music.playlists"), sections: [])
        playlists.tabImage = UIImage(systemName: "music.note.list")
        let offline = CPListTemplate(title: String(localized: "downloads.title"), sections: [])
        offline.tabImage = UIImage(systemName: "arrow.down.circle")
        interfaceController.setRootTemplate(CPTabBarTemplate(templates: [home, playlists, offline]), animated: false, completion: nil)
        Task { await load(home: home, playlists: playlists, offline: offline) }
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        self.interfaceController = nil
    }

    private var limit: Int { max(12, CPListTemplate.maximumItemCount) }

    private func load(home: CPListTemplate, playlists: CPListTemplate, offline: CPListTemplate) async {
        let app = MusicAppModel.shared
        let done = app.downloads.doneTracks
        offline.updateSections([CPListSection(items: trackItems(done))])
        guard await app.waitUntilBooted(), let store = app.env.store else { return }
        let mix = CPListItem(text: String(localized: "music.start_mix"), detailText: String(localized: "music.start_mix_hint"),
                             image: UIImage(systemName: "sparkles"))
        mix.handler = { [weak self] _, completion in
            Task { @MainActor in
                await app.player.startMix(store: store)
                self?.showNowPlaying()
            }
            completion()
        }
        if let h = try? await store.home() {
            let albums = (h.recent + h.newest).prefix(limit - 1).map { a -> CPListItem in
                let item = CPListItem(text: a.name, detailText: a.artist)
                item.handler = { [weak self] _, completion in
                    Task { @MainActor in
                        if let d = try? await store.album(a.id) { app.player.play(d.tracks, at: 0, store: store) }
                        self?.showNowPlaying()
                    }
                    completion()
                }
                return item
            }
            home.updateSections([CPListSection(items: [mix]), CPListSection(items: Array(albums), header: String(localized: "music.recent"), sectionIndexTitle: nil)])
            let lists = h.playlists.prefix(limit).map { p -> CPListItem in
                let item = CPListItem(text: p.name, detailText: String(localized: "music.tracks_count \(p.songCount)"))
                item.handler = { [weak self] _, completion in
                    Task { @MainActor in
                        if let t = try? await store.playlistTracks(p.id), !t.isEmpty { app.player.play(t, at: 0, store: store) }
                        self?.showNowPlaying()
                    }
                    completion()
                }
                return item
            }
            playlists.updateSections([CPListSection(items: Array(lists))])
        } else {
            home.updateSections([CPListSection(items: [mix])])
        }
    }

    private func trackItems(_ tracks: [TrackCard]) -> [CPListItem] {
        let app = MusicAppModel.shared
        return Array(tracks.prefix(limit)).enumerated().map { i, t in
            let item = CPListItem(text: t.title, detailText: t.artist)
            item.handler = { [weak self] _, completion in
                Task { @MainActor in
                    if let s = app.env.store { app.player.play(tracks, at: i, store: s) }
                    self?.showNowPlaying()
                }
                completion()
            }
            return item
        }
    }

    private func showNowPlaying() {
        interfaceController?.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
    }
}
#endif
