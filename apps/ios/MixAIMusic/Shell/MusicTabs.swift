import MixaiCore
import MixaiUI
import SwiftUI

/// Home · Search · Downloads · Settings with the Liquid Glass tab bar and the mini player as bottom accessory.
struct MusicTabs: View {
    @Environment(MusicAppModel.self) private var app

    var body: some View {
        @Bindable var model = app
        @Bindable var player = app.player
        TabView(selection: $model.selectedTab) {
            Tab("music.tab.home", systemImage: "music.note.house.fill", value: 0) {
                MusicStack(tab: 0) { MusicHomeView(reloadKey: app.profileId).navigationTitle("MixAI Music").toolbar { AccountToolbar() } }
            }
            Tab("music.tab.library", systemImage: "square.stack.fill", value: 1) {
                MusicStack(tab: 1) { LibraryHub().navigationTitle("music.tab.library").toolbar { AccountToolbar() } }
            }
            Tab("downloads.title", systemImage: "arrow.down.circle.fill", value: 2) {
                MusicStack(tab: 2) { MusicDownloadsView().toolbar { AccountToolbar() } }
            }
            Tab("tab.search", systemImage: "magnifyingglass", value: 3, role: .search) {
                MusicStack(tab: 3) { MusicSearchView().navigationTitle("tab.search") }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory {
            if app.player.current != nil { MiniPlayer() } else { EmptyView() }
        }
        .sheet(isPresented: $player.showNowPlaying) { NowPlayingView().environment(app.env) }
        .overlay(alignment: .top) { MusicToast() }
        .alert("state.error", isPresented: Binding(get: { app.player.lastError != nil && !app.player.playing }, set: { _ in })) {
            Button("action.ok", role: .cancel) {}
        } message: { Text(app.player.lastError ?? "") }
    }
}

/// One NavigationStack per tab; deep links set `app.pendingRoute`, the selected tab pushes it.
struct MusicStack<Content: View>: View {
    @Environment(MusicAppModel.self) private var app
    @State private var path: [MusicRoute] = []
    let tab: Int
    @ViewBuilder let content: () -> Content

    var body: some View {
        NavigationStack(path: $path) {
            content()
                .musicDestinations()
                .navigationDestination(for: SettingsRoute.self) { r in
                    switch r {
                    case .settings: MusicSettingsView()
                    case .signIn: MusicSignInView()
                    }
                }
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

enum SettingsRoute: Hashable { case settings, signIn }

/// Library: artists, albums, playlists, genres-free browse hub.
struct LibraryHub: View {
    @Environment(MusicEnvironment.self) private var env

    var body: some View {
        List {
            NavigationLink(value: MusicRoute.artists) { Label("music.artists", systemImage: "music.mic") }
            NavigationLink(value: MusicRoute.albums) { Label("music.albums", systemImage: "square.stack") }
            NavigationLink(value: MusicRoute.playlists) { Label("music.playlists", systemImage: "music.note.list") }
            NavigationLink(value: MusicRoute.downloads) { Label("downloads.title", systemImage: "arrow.down.circle") }
            Section {
                Button {
                    if let s = env.store { Task { await env.player.startMix(store: s) } }
                } label: { Label("music.start_mix", systemImage: "sparkles") }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
    }
}

struct AccountToolbar: ToolbarContent {
    @Environment(MusicAppModel.self) private var app
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            NavigationLink(value: SettingsRoute.settings) { ProfileAvatar(profile: app.activeProfile, size: 30) }
                .accessibilityLabel(Text("settings.title"))
        }
    }
}

struct MusicToast: View {
    @Environment(MusicAppModel.self) private var app
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
        }
    }
}
