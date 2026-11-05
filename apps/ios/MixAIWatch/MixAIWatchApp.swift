import SwiftUI

@main
struct MixAIWatchApp: App {
    @State private var model = WatchModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(WatchPalette.accent)
                .task { model.start() }
        }
    }
}

/// MixAI colours on the watch (the iPhone Theme is app-target only). The watch is always dark.
enum WatchPalette {
    static let background = Color(red: 0.05, green: 0.04, blue: 0.09)
    static let accent = Color(red: 0.62, green: 0.42, blue: 1.0)
}

struct RootView: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        TabView {
            NavigationStack { NowPlayingView() }
            NavigationStack { RemoteView() }
        }
        .tabViewStyle(.verticalPage)
        .safeAreaInset(edge: .bottom) {
            if let error = model.lastError {
                Text(LocalizedStringKey(error))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .padding(.horizontal, 4)
            }
        }
        .containerBackground(WatchPalette.background.gradient, for: .tabView)
    }
}
