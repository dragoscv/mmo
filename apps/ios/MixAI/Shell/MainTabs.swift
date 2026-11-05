import MixaiCore
import SwiftUI

/// Navigation targets pushed on each tab's NavigationStack.
enum Route: Hashable {
    case title(kind: MediaKind, tmdbId: Int, posterPath: String?)
    case album(String)
    case artist(String)
    case settings
}

/// Five tabs with the iOS 26 Liquid Glass tab bar and the mini-player as bottom accessory.
struct MainTabs: View {
    @Environment(AppModel.self) private var app
    @State private var tab = 0

    var body: some View {
        @Bindable var player = app.player
        @Bindable var music = app.music
        TabView(selection: $tab) {
            Tab("tab.home", systemImage: "house.fill", value: 0) { TabRoot { HomeView(ns: $0) } }
            Tab("tab.search", systemImage: "magnifyingglass", value: 1, role: .search) { TabRoot { SearchView(ns: $0) } }
            Tab("tab.library", systemImage: "square.grid.2x2.fill", value: 2) { TabRoot { LibraryView(ns: $0) } }
            Tab("tab.music", systemImage: "music.note", value: 3) { TabRoot { _ in MusicHomeView() } }
            Tab("tab.live", systemImage: "dot.radiowaves.left.and.right", value: 4) { TabRoot { _ in LiveView() } }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory {
            if app.music.current != nil { MiniPlayer() } else { EmptyView() }
        }
        .fullScreenCover(isPresented: $player.presented) { PlayerView() }
        .sheet(isPresented: $music.showNowPlaying) { NowPlayingView() }
        .onAppear { RemoteCommands.install(app) }
    }
}

/// One NavigationStack per tab with a namespace for the poster → title zoom morph.
struct TabRoot<Content: View>: View {
    @Namespace private var ns
    @ViewBuilder let content: (Namespace.ID) -> Content

    var body: some View {
        NavigationStack {
            content(ns)
                .navigationDestination(for: Route.self) { r in
                    switch r {
                    case .title(let kind, let id, _):
                        TitleView(kind: kind, tmdbId: id, ns: ns).navigationTransition(.zoom(sourceID: "\(kind.rawValue)-\(id)", in: ns))
                    case .album(let id): AlbumView(albumId: id)
                    case .artist(let id): ArtistView(artistId: id)
                    case .settings: SettingsView()
                    }
                }
        }
    }
}

/// Toolbar avatar → Settings (every tab).
struct ProfileToolbar: ToolbarContent {
    @Environment(AppModel.self) private var app
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            NavigationLink(value: Route.settings) {
                ProfileAvatar(profile: app.activeProfile, size: 30)
            }
            .accessibilityLabel(Text("settings.title"))
        }
    }
}

struct MiniPlayer: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let m = app.music
        HStack(spacing: 10) {
            RemoteImage(url: app.musicStore?.coverURL(m.current?.coverUrlPath), aspect: 1).frame(width: 34, height: 34).clipShape(.rect(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 0) {
                Text(m.current?.title ?? "").font(Theme.body(14, weight: .semibold)).lineLimit(1)
                Text(m.current?.artist ?? "").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
            }
            Spacer(minLength: 4)
            Button { m.toggle() } label: { Image(systemName: m.playing ? "pause.fill" : "play.fill") }
                .accessibilityLabel(Text(m.playing ? "player.pause" : "player.play"))
            Button { m.next() } label: { Image(systemName: "forward.fill") }
                .accessibilityLabel(Text("music.next"))
        }
        .padding(.horizontal, 14)
        .contentShape(.rect)
        .onTapGesture { m.showNowPlaying = true }
    }
}
