import AppIntents
import MixaiCore
import MixaiUI
import SwiftUI

/// MixAI Key & BPM for iPhone (WP18-05): live key + BPM from the microphone on the Rust engine (mixai-listen over
/// UniFFI), Song ID via ShazamKit, set log + exports, tuner, tempo/MIDI clock, practice, optional MMO library.
@main
struct KeyBpmApp: App {
    @State private var session = ListenSession.shared
    @Environment(\.scenePhase) private var phase

    init() {
        Theme.registerFonts()
        WatchBridge.shared.activate()
        ListenSession.shared.onPublish = { WatchBridge.shared.publish($0) }
        KeyBpmShortcuts.updateAppShortcutParameters()
        ListenSession.shared.applyScreenshotHook()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .preferredColorScheme(.dark)
                .tint(KB.primary)
                .onOpenURL { url in Task { await DeepLink.handle(url, session: session) } }
        }
        .onChange(of: phase) { _, p in
            // Background listening is opt-in (owner decision): without it, leaving the app stops the mic.
            if p == .background, session.listening, !session.prefs.background { session.stop() }
            UIApplication.shared.isIdleTimerDisabled = p == .active && session.listening
        }
    }
}

/// `mixai-keybpm://listen | identify | stage | what-key` (widgets, Live Activity buttons, shortcuts).
enum DeepLink {
    @MainActor static func handle(_ url: URL, session s: ListenSession) async {
        guard url.scheme == "mixai-keybpm" else { return }
        switch url.host() {
        case "listen": if !s.listening { await s.start() }
        case "identify": if !s.listening { await s.start() }; s.identify()
        case "stage": Nav.shared.stage = true
        case "what-key": await s.requestWhatKey()
        case "stop": s.stop()
        default: break
        }
    }
}

/// Global navigation state (deep links / intents switch tabs or open stage).
@MainActor @Observable
final class Nav {
    static let shared = Nav()
    var tab = 0
    var stage = false
}

struct RootView: View {
    @Environment(ListenSession.self) private var s
    @State private var nav = Nav.shared
    @Environment(\.openURL) private var openURL

    var body: some View {
        TabView(selection: $nav.tab) {
            Tab("kb.tab.live", systemImage: "waveform", value: 0) { LiveView(stage: $nav.stage) }
            Tab("kb.tab.tuner", systemImage: "tuningfork", value: 1) { TunerView() }
            Tab("kb.tab.tempo", systemImage: "metronome", value: 2) { TempoView() }
            Tab("kb.tab.setlog", systemImage: "list.bullet.rectangle", value: 3) { SetLogView() }
            Tab("kb.tab.practice", systemImage: "music.note", value: 4) { PracticeView() }
            Tab("kb.tab.library", systemImage: "music.note.house", value: 5) { LibraryView() }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .fullScreenCover(isPresented: $nav.stage) { StageView() }
        .alert("kb.mic.denied", isPresented: Binding(get: { s.micDenied }, set: { _ in })) {
            Button("kb.open_settings") { if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) } }
            Button("kb.cancel", role: .cancel) {}
        }
        .modifier(BoothMode())
    }
}

/// StandBy-style booth display: charging + landscape + listening → stage mode opens by itself (once per plug-in).
private struct BoothMode: ViewModifier {
    @Environment(ListenSession.self) private var s
    @State private var charging = false
    @State private var shown = false

    func body(content: Content) -> some View {
        GeometryReader { geo in
            content
                .onChange(of: geo.size.width > geo.size.height && charging && s.listening) { _, booth in
                    if booth, !shown { shown = true; Nav.shared.stage = true }
                    if !charging { shown = false }
                }
        }
        .onAppear {
            UIDevice.current.isBatteryMonitoringEnabled = true
            charging = [.charging, .full].contains(UIDevice.current.batteryState)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIDevice.batteryStateDidChangeNotification)) { _ in
            charging = [.charging, .full].contains(UIDevice.current.batteryState)
        }
    }
}
