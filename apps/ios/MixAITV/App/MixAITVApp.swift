import AVFoundation
import MixaiCore
import SwiftUI
import UIKit

@main
struct MixAITVApp: App {
    @State private var model = TVModel()

    init() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
        ClientIdentity.current = ClientIdentity(platform: "tvos", appVersion: version, deviceName: UIDevice.current.name, userAgentPrefix: "MixAI-tvOS")
        TVTheme.registerFonts()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    }

    var body: some Scene {
        WindowGroup {
            TVRootView()
                .environment(model)
                .preferredColorScheme(.dark)
                // No app-wide .tint: tvOS draws a tinted button's label in the tint colour on a tinted platter (invisible).
                .task { await model.boot() }
                .onOpenURL { url in
                    // mixai://title/<kind>/<id> (Top Shelf, Siri, shared links) opens the title page, like the iPhone app.
                    let parts = url.pathComponents.filter { $0 != "/" }
                    guard url.scheme == "mixai", url.host == "title", parts.count >= 2,
                          let k = MediaKind(rawValue: parts[0]), let id = Int(parts[1]) else { return }
                    model.pendingRoute = .title(kind: k, tmdbId: id)
                }
        }
    }
}

struct TVRootView: View {
    @Environment(TVModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            switch model.phase {
            case .launching:
                ZStack {
                    TVTheme.background.ignoresSafeArea()
                    BrandMarkView(.tv, animation: .intro).frame(width: 180, height: 180)
                }
            case .onboarding:
                TVOnboardingView()
            case .profiles:
                TVProfilePicker()
            case .ready:
                TVMainTabs()
            }
        }
        .animation(.smooth(duration: 0.35), value: model.phase)
        // Brand sound, once per cold start, together with the mark's intro (Settings › Sound turns it off).
        .onAppear { TVStartupSound.playOnce() }
        .fullScreenCover(item: $model.playing) { req in
            TVPlayerView(request: req).ignoresSafeArea()
        }
    }
}
