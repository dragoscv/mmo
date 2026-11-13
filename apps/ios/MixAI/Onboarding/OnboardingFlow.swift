import MixaiCore
import SwiftUI

/// Welcome → sign in (device code) | connect on this network → server list → Quick Connect code.
struct OnboardingFlow: View {
    @Environment(AppModel.self) private var app
    enum Step: Hashable { case servers, signIn, pair(DiscoveredServer) }
    @State private var path: [Step] = []

    var body: some View {
        NavigationStack(path: $path) {
            WelcomeView(path: $path)
                .navigationDestination(for: Step.self) { s in
                    switch s {
                    case .servers:
                        ServerListView { path.append(.pair($0)) }
                    case .signIn:
                        DeviceSignInView(origin: app.origin) { app.accountStore.adopt($0, app: app) } onConnect: { c, base in
                            await app.connect(ServerConnection(name: c.name ?? "MixAI Server", baseURL: base), token: c.token)
                        }
                    case .pair(let server):
                        PairView(server: server) { token in
                            await app.connect(ServerConnection(name: server.name, baseURL: server.baseURL), token: token)
                        }
                    }
                }
        }
        .task {
            #if DEBUG
            // Simulator screenshots / UI checks: SIMCTL_CHILD_MIXAI_AUTOPAIR=https://demo.mixai.ro opens Quick Connect
            // for that server without input (the demo server approves every code).
            guard path.isEmpty, let auto = ProcessInfo.processInfo.environment["MIXAI_AUTOPAIR"] else { return }
            let base = MmoClient.normalise(auto)
            if let info = try? await MmoClient(baseURL: base, token: "").pairInfo() {
                path.append(.pair(DiscoveredServer(name: info.name, baseURL: base, pairing: info.pairingSupported)))
            }
            #endif
        }
    }
}

struct WelcomeView: View {
    @Environment(AppModel.self) private var app
    @Binding var path: [OnboardingFlow.Step]

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            RadialGradient(colors: [Tokens.Brand.violetDark.opacity(0.45), .clear], center: .top, startRadius: 0, endRadius: 520).ignoresSafeArea()
            VStack(spacing: 20) {
                Spacer()
                BrandMarkView(.tv, animation: .intro).frame(width: 112, height: 112)
                Text("welcome.title").font(Theme.heading(34)).multilineTextAlignment(.center)
                Text("welcome.subtitle").font(Theme.body(17)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center).padding(.horizontal, 24)
                Spacer()
                VStack(spacing: 12) {
                    if app.accountStore.signedIn {
                        Label("welcome.signed_in \(app.accountStore.user?.name ?? "")", systemImage: "checkmark.seal.fill")
                            .font(Theme.body(14)).foregroundStyle(Theme.success)
                    } else {
                        AppleSignInButton()
                        if let e = app.accountStore.error { Text(e).font(Theme.body(13)).foregroundStyle(Theme.destructive) }
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
}
