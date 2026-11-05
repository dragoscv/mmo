// CarPlay audio (tracker WP16 item 9). Compiled only with the `MIXAI_CARPLAY` flag: the flag, the entitlement
// `com.apple.developer.carplay-audio` and the `CPTemplateApplicationSceneSessionRoleApplication` scene manifest entry
// are added only after Apple grants the entitlement (request via developer.apple.com/contact/carplay).
#if MIXAI_CARPLAY
import CarPlay
import MixaiCore
import UIKit

@MainActor
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController
        let recent = CPListTemplate(title: String(localized: "carplay.recent"), sections: [])
        recent.tabImage = UIImage(systemName: "clock")
        let albums = CPListTemplate(title: String(localized: "music.albums"), sections: [])
        albums.tabImage = UIImage(systemName: "square.stack")
        let tabs = CPTabBarTemplate(templates: [recent, albums])
        interfaceController.setRootTemplate(tabs, animated: false, completion: nil)
        Task { await load(recent: recent, albums: albums) }
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        self.interfaceController = nil
    }

    private func load(recent: CPListTemplate, albums: CPListTemplate) async {
        let app = IntentBridge.current
        _ = await app.waitUntilBooted()
        guard let store = app.musicStore, let home = try? await store.home() else { return }
        let tracks = home.mostPlayed
        let trackItems = tracks.enumerated().map { i, t -> CPListItem in
            let item = CPListItem(text: t.title, detailText: t.artist)
            item.handler = { [weak self] _, completion in
                MainActor.assumeIsolated {
                    app.music.play(tracks, at: i, store: store, video: app.player)
                    self?.showNowPlaying()
                }
                completion()
            }
            return item
        }
        recent.updateSections([CPListSection(items: trackItems)])
        let albumItems = (home.recent + home.newest).prefix(40).map { a -> CPListItem in
            let item = CPListItem(text: a.name, detailText: a.artist)
            item.handler = { [weak self] _, completion in
                MainActor.assumeIsolated { self?.openAlbum(a.id, store: store) }
                completion()
            }
            return item
        }
        albums.updateSections([CPListSection(items: Array(albumItems))])
    }

    private func openAlbum(_ id: String, store: MusicStore) {
        Task {
            let app = IntentBridge.current
            guard let detail = try? await store.album(id) else { return }
            app.music.play(detail.tracks, at: 0, store: store, video: app.player)
            showNowPlaying()
        }
    }

    private func showNowPlaying() {
        interfaceController?.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
    }
}
#endif
