import AVFoundation
import Intents
import MixaiCore
import MixaiUI
import SwiftUI
import UIKit

@main
struct MixAIMusicApp: App {
    @UIApplicationDelegateAdaptor(MusicAppDelegate.self) private var delegate
    @State private var app = MusicAppModel.shared

    init() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
        ClientIdentity.current = ClientIdentity(platform: "ios-music", appVersion: version, deviceName: UIDevice.current.name, userAgentPrefix: "MixAI-Music-iOS")
        Theme.registerFonts()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, policy: .longFormAudio)
        MusicIntentHandler.shared = MusicAppModel.shared
    }

    var body: some Scene {
        WindowGroup {
            MusicRootView()
                .environment(app)
                .environment(app.env)
                .preferredColorScheme(.dark)
                .tint(Theme.primary)
                .task { await app.boot() }
                .onOpenURL { app.handle(url: $0) }
        }
    }
}

final class MusicAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == MusicDownloads.sessionId else { completionHandler(); return }
        MainActor.assumeIsolated { MusicAppModel.shared.downloads.backgroundEventsHandler = completionHandler }
    }

    /// Siri "Play <x> in MixAI Music" (INPlayMediaIntent): the Intents extension answers `.handleInApp`, the system
    /// launches the app in the background and hands the intent here.
    func application(_ application: UIApplication, handlerFor intent: INIntent) -> Any? {
        intent is INPlayMediaIntent ? PlayMediaInAppHandler() : nil
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        #if MIXAI_CARPLAY
        if connectingSceneSession.role == .carTemplateApplication {
            let c = UISceneConfiguration(name: "CarPlay", sessionRole: connectingSceneSession.role)
            c.delegateClass = MusicCarPlaySceneDelegate.self
            return c
        }
        #endif
        return UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
    }
}

/// Plays what the Intents extension resolved: `mediaItems[0].identifier` = `q:<INMediaItemType raw>:<name>` (search
/// the server: album → play it, artist → artist radio, song → track radio), `al_` / `ar_` / `tr_` ids, or "mix".
final class PlayMediaInAppHandler: NSObject, INPlayMediaIntentHandling {
    func handle(intent: INPlayMediaIntent) async -> INPlayMediaIntentResponse {
        let id = intent.mediaItems?.first?.identifier ?? "mix"
        let shuffle = intent.playShuffled ?? false
        let ok = await Self.play(id: id, shuffle: shuffle)
        return INPlayMediaIntentResponse(code: ok ? .success : .failure, userActivity: nil)
    }

    @MainActor
    private static func play(id: String, shuffle: Bool) async -> Bool {
        let app = MusicAppModel.shared
        guard await app.waitUntilBooted(), let store = app.env.store else { return false }
        var target = id
        if id.hasPrefix("q:") {
            let parts = id.split(separator: ":", maxSplits: 2).map(String.init)
            let type = parts.count > 1 ? Int(parts[1]).flatMap(INMediaItemType.init(rawValue:)) : nil
            let name = parts.count > 2 ? parts[2] : ""
            guard let r = try? await store.search(name) else { return false }
            switch type {
            case .artist: target = r.artists.first?.id ?? r.albums.first?.id ?? "mix"
            case .song: target = r.tracks.first?.id ?? "mix"
            case .album: target = r.albums.first?.id ?? "mix"
            default: target = r.albums.first?.id ?? r.artists.first?.id ?? r.tracks.first?.id ?? "mix"
            }
        }
        if target.hasPrefix("al_"), let d = try? await store.album(target), !d.tracks.isEmpty {
            app.player.play(d.tracks, at: 0, store: store, shuffle: shuffle)
        } else if target.hasPrefix("ar_") || target.hasPrefix("tr_") {
            await app.player.startMix(seed: target, store: store)
        } else {
            await app.player.startMix(store: store)
        }
        return app.player.current != nil
    }
}

struct MusicRootView: View {
    @Environment(MusicAppModel.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                ZStack {
                    Theme.background.ignoresSafeArea()
                    Image("BrandMark").resizable().scaledToFit().frame(width: 96).accessibilityLabel("MixAI Music")
                }
            case .onboarding:
                MusicOnboarding()
            case .profiles:
                ProfileGridView(title: "music.profiles.who", profiles: app.profiles) { p in
                    Task { await app.choose(p) }
                } unlock: { p, pin in
                    guard let ps = app.profileStore else { return .failed("") }
                    return await ps.unlock(p, pin: pin)
                } onUnlocked: { p in
                    app.unlocked(p)
                } reload: {
                    if let ps = app.profileStore { app.profiles = (try? await ps.refresh()) ?? [] }
                }
            case .ready:
                MusicTabs()
            }
        }
        .animation(.smooth(duration: 0.35), value: app.phase)
    }
}
