import MixaiCore
import Observation
import SwiftUI

/// What the shared music views need from the host app: the server store for the active profile, the player and
/// (MixAI Music only) offline downloads. Injected with `.environment(musicEnvironment)`.
@MainActor
@Observable
public final class MusicEnvironment {
    public var store: MusicStore? { didSet { player.setStore(store) } }
    public let player: MusicPlayer
    /// nil in the MixAI (video) app: download buttons and badges are hidden there.
    public let downloads: MusicDownloads?
    /// Shows "Play on…" (hub outputs) in Now Playing.
    public var showOutputs = true

    public init(player: MusicPlayer, downloads: MusicDownloads? = nil) {
        self.player = player
        self.downloads = downloads
    }

    public func play(_ list: [TrackCard], at i: Int, shuffle: Bool = false) {
        guard let store else { return }
        player.play(list, at: i, store: store, shuffle: shuffle)
    }

    public func cover(_ path: String?) -> URL? { store?.coverURL(path) }
}

/// Navigation targets of the shared music screens (each host adds `.musicDestinations()` to its stacks).
public enum MusicRoute: Hashable {
    case album(String)
    case artist(String)
    case playlist(id: String, name: String)
    case artists
    case albums
    case playlists
    case downloads
}

extension View {
    /// Destinations for `MusicRoute` values pushed by the shared music views.
    public func musicDestinations() -> some View {
        navigationDestination(for: MusicRoute.self) { r in
            switch r {
            case .album(let id): AlbumView(albumId: id)
            case .artist(let id): ArtistView(artistId: id)
            case .playlist(let id, let name): PlaylistView(playlistId: id, name: name)
            case .artists: ArtistsListView()
            case .albums: AlbumsGridView()
            case .playlists: PlaylistsListView()
            case .downloads: MusicDownloadsView()
            }
        }
    }
}
