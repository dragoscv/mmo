import AVFoundation
import MixaiCore
import SwiftUI
import UIKit

@main
struct MixAIApp: App {
    @State private var app = AppModel()

    init() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
        ClientIdentity.current = ClientIdentity(platform: "ios", appVersion: version, deviceName: UIDevice.current.name, userAgentPrefix: "MixAI-iOS")
        Theme.registerFonts()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, policy: .longFormVideo)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(\.locale, app.locale)
                .preferredColorScheme(.dark)
                .tint(Theme.primary)
                .task { await app.boot() }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                SplashView()
            case .onboarding:
                OnboardingFlow()
            case .profiles:
                ProfilePickerView()
            case .ready:
                MainTabs()
            }
        }
        .animation(.smooth(duration: 0.35), value: app.phase)
    }
}

struct SplashView: View {
    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            Image("BrandMark").resizable().scaledToFit().frame(width: 96)
                .accessibilityLabel("MixAI")
        }
    }
}
