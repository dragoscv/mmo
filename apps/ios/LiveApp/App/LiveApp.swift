import LiveCore
import SwiftUI

/// MixAI Live for iPhone and iPad (WP21-09, ADR-0015): a pure controller of the MixAI Live engine over protocol v1
/// (WebSocket, `docs/live/remote-protocol.md`). No audio runs on the phone.
@main
struct MixAILiveApp: App {
    @State private var session = LiveSession.shared
    @Environment(\.scenePhase) private var phase

    init() {
        WatchBridge.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .preferredColorScheme(.dark)
                .tint(LiveTheme.accent)
                .onOpenURL { url in
                    if let link = PairingLink.parse(url.absoluteString) { session.pair(link) }
                }
                .task {
                    session.discovery.start()
                    session.autoConnect()
                }
        }
        .onChange(of: phase) { _, p in session.scene(active: p == .active) }
    }
}

struct RootView: View {
    @Environment(LiveSession.self) private var session
    @State private var tab: Tab = .connect

    enum Tab: Hashable { case perform, chain, midi, connect }

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { PerformView() }
                .tabItem { Label("live.tab.perform", systemImage: "music.mic") }
                .tag(Tab.perform)
            NavigationStack { ChainView() }
                .tabItem { Label("live.tab.chain", systemImage: "slider.horizontal.3") }
                .tag(Tab.chain)
            NavigationStack { MidiView() }
                .tabItem { Label("live.tab.midi", systemImage: "pianokeys") }
                .tag(Tab.midi)
            NavigationStack { ConnectView() }
                .tabItem { Label("live.tab.connect", systemImage: "antenna.radiowaves.left.and.right") }
                .tag(Tab.connect)
        }
        .onChange(of: session.model.connected) { was, now in
            // A new connection made from the Connect tab lands on Perform; reconnects never move the user.
            if now, !was, tab == .connect { tab = .perform }
        }
    }
}
