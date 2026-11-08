import MixaiCore
import SwiftUI

/// Navigation targets pushed on each tab's NavigationStack.
enum Route: Hashable {
    case title(kind: MediaKind, tmdbId: Int, posterPath: String?)
    case album(String)
    case artist(String)
    case settings
    case downloads
    case remote
    case together
    case family
    case plex
    case licenses
    case deleteAccount
}

/// Five tabs with the iOS 26 Liquid Glass tab bar and the mini-player as bottom accessory; on iPad (regular width)
/// the same tabs become a sidebar (`.sidebarAdaptable`).
struct MainTabs: View {
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        @Bindable var model = app
        @Bindable var player = app.player
        @Bindable var music = app.music
        styled(tabs($model.selectedTab))
            .fullScreenCover(isPresented: $player.presented) { PlayerView() }
            .sheet(isPresented: $music.showNowPlaying) { NowPlayingView().environment(app.musicEnv) }
            .sheet(isPresented: $model.showPlayOn) { PlayOnSheet(request: app.playOnRequest) }
            .overlay(alignment: .top) { ToastBanner() }
            .environment(app.musicEnv)
            .onAppear { RemoteCommands.install(app) }
    }

    private func tabs(_ selection: Binding<Int>) -> some View {
        TabView(selection: selection) {
            Tab("tab.home", systemImage: "house.fill", value: 0) { TabRoot(tab: 0) { HomeView(ns: $0) } }
            Tab("tab.search", systemImage: "magnifyingglass", value: 1, role: .search) { TabRoot(tab: 1) { SearchView(ns: $0) } }
            Tab("tab.library", systemImage: "square.grid.2x2.fill", value: 2) { TabRoot(tab: 2) { LibraryView(ns: $0) } }
            Tab("tab.music", systemImage: "music.note", value: 3) {
                TabRoot(tab: 3) { _ in
                    MusicHomeView(reloadKey: app.profileId).navigationTitle("tab.music").toolbar { ProfileToolbar() }
                }
            }
            Tab("tab.live", systemImage: "dot.radiowaves.left.and.right", value: 4) { TabRoot(tab: 4) { _ in LiveView() } }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory {
            if app.music.current != nil { MiniPlayer() } else { EmptyView() }
        }
    }

    @ViewBuilder
    private func styled(_ v: some View) -> some View {
        if sizeClass == .regular { v.tabViewStyle(.sidebarAdaptable) } else { v }
    }
}

/// One NavigationStack per tab with a namespace for the poster → title zoom morph.
/// Deep links / intents / toolbar actions set `app.pendingRoute`; the selected tab pushes it.
struct TabRoot<Content: View>: View {
    @Environment(AppModel.self) private var app
    @Namespace private var ns
    @State private var path: [Route] = []
    let tab: Int
    @ViewBuilder let content: (Namespace.ID) -> Content

    var body: some View {
        NavigationStack(path: $path) {
            content(ns)
                .navigationDestination(for: Route.self) { r in
                    switch r {
                    case .title(let kind, let id, _):
                        TitleView(kind: kind, tmdbId: id, ns: ns).navigationTransition(.zoom(sourceID: "\(kind.rawValue)-\(id)", in: ns))
                    case .album(let id): AlbumView(albumId: id)
                    case .artist(let id): ArtistView(artistId: id)
                    case .settings: SettingsView()
                    case .downloads: DownloadsView()
                    case .remote: RemoteView()
                    case .together: TogetherView()
                    case .family: FamilyStatsView()
                    case .plex: PlexImportView()
                    case .licenses: LicensesView()
                    case .deleteAccount: DeleteAccountView()
                    }
                }
                .musicDestinations()
        }
        .onChange(of: app.pendingRoute, initial: true) { consume() }
        .onChange(of: app.selectedTab) { consume() }
    }

    private func consume() {
        guard app.selectedTab == tab, let r = app.pendingRoute else { return }
        app.pendingRoute = nil
        if path.last != r { path.append(r) }
    }
}

/// Toolbar: downloads, remote / Watch Together / Play on, avatar → Settings (every tab).
struct ProfileToolbar: ToolbarContent {
    @Environment(AppModel.self) private var app
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            NavigationLink(value: Route.downloads) {
                Image(systemName: "arrow.down.circle")
            }
            .accessibilityLabel(Text("downloads.title"))
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button { app.pendingRoute = .remote } label: { Label("remote.title", systemImage: "appletvremote.gen4") }
                Button { app.pendingRoute = .together } label: { Label("together.title", systemImage: "person.2.wave.2") }
                Button {
                    app.playOnRequest = nil
                    app.showPlayOn = true
                } label: { Label("playon.title", systemImage: "tv") }
            } label: {
                Image(systemName: "appletvremote.gen4")
            }
            .accessibilityLabel(Text("remote.menu"))
        }
        ToolbarItem(placement: .topBarTrailing) {
            NavigationLink(value: Route.settings) {
                ProfileAvatar(profile: app.activeProfile, size: 30)
            }
            .accessibilityLabel(Text("settings.title"))
        }
    }
}

/// Transient banner (`app.toast`), auto-hides after 4 s.
struct ToastBanner: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let t = app.toast {
            Text(t)
                .font(Theme.body(14, weight: .semibold))
                .padding(.horizontal, 16).padding(.vertical, 10)
                .glassCard(cornerRadius: 18)
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
                .onTapGesture { app.toast = nil }
                .task(id: t) {
                    try? await Task.sleep(for: .seconds(4))
                    if app.toast == t { app.toast = nil }
                }
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}
