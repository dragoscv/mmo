import MixaiCore
import MixaiUI
import SwiftUI

/// Welcome → connect on this network (server list → Quick Connect) | MixAI account sign-in (device code).
struct MusicOnboarding: View {
    @Environment(MusicAppModel.self) private var app
    enum Step: Hashable { case servers, signIn, pair(DiscoveredServer) }
    @State private var path: [Step] = []

    var body: some View {
        NavigationStack(path: $path) {
            welcome
                .navigationDestination(for: Step.self) { s in
                    switch s {
                    case .servers:
                        ServerListView { path.append(.pair($0)) }
                    case .signIn:
                        DeviceSignInView(origin: app.origin) { app.adoptAccount($0) } onConnect: { c, base in
                            await app.connect(MusicServer(name: c.name ?? "MixAI Server", baseURL: base), token: c.token)
                        }
                    case .pair(let server):
                        PairView(server: server) { token in
                            await app.connect(MusicServer(name: server.name, baseURL: server.baseURL), token: token)
                        }
                    }
                }
        }
    }

    private var welcome: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            RadialGradient(colors: [Tokens.Brand.violetDark.opacity(0.45), .clear], center: .top, startRadius: 0, endRadius: 520).ignoresSafeArea()
            VStack(spacing: 20) {
                Spacer()
                Image("BrandMark").resizable().scaledToFit().frame(width: 112).accessibilityLabel("MixAI Music")
                Text("music.welcome.title").font(Theme.heading(34)).multilineTextAlignment(.center)
                Text("music.welcome.subtitle").font(Theme.body(17)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center).padding(.horizontal, 24)
                VStack(alignment: .leading, spacing: 10) {
                    feature("waveform", "music.welcome.f1")
                    feature("arrow.down.circle", "music.welcome.f2")
                    feature("tv", "music.welcome.f3")
                }
                .padding(.horizontal, 36)
                Spacer()
                VStack(spacing: 12) {
                    if let u = app.account {
                        Label("welcome.signed_in \(u.name ?? "")", systemImage: "checkmark.seal.fill").font(Theme.body(14)).foregroundStyle(Theme.success)
                    }
                    Button { path.append(.servers) } label: {
                        Label("welcome.connect_lan", systemImage: "wifi").frame(maxWidth: .infinity).padding(.vertical, 6)
                    }
                    .buttonStyle(.glassProminent)
                    Button { path.append(.signIn) } label: {
                        Label("welcome.sign_in", systemImage: "person.crop.circle").frame(maxWidth: .infinity).padding(.vertical, 6)
                    }
                    .buttonStyle(.glass)
                }
                .controlSize(.large)
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
        }
    }

    private func feature(_ symbol: String, _ text: LocalizedStringKey) -> some View {
        Label { Text(text).font(Theme.body(15)) } icon: { Image(systemName: symbol).foregroundStyle(Theme.primary) }
    }
}

/// Settings → MixAI account (device code) after onboarding.
struct MusicSignInView: View {
    @Environment(MusicAppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        DeviceSignInView(origin: app.origin) { ok in
            app.adoptAccount(ok)
        } onConnect: { _, _ in
            dismiss()
        }
    }
}
