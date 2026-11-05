import MixaiCore
import SwiftUI

/// Welcome → sign in (device code) | connect on this network → server list → Quick Connect code.
struct OnboardingFlow: View {
    enum Step: Hashable { case servers, signIn, pair(DiscoveredServer) }
    @State private var path: [Step] = []

    var body: some View {
        NavigationStack(path: $path) {
            WelcomeView(path: $path)
                .navigationDestination(for: Step.self) { s in
                    switch s {
                    case .servers: ServerListView(path: $path)
                    case .signIn: SignInView()
                    case .pair(let server): PairView(server: server)
                    }
                }
        }
    }
}

struct WelcomeView: View {
    @Binding var path: [OnboardingFlow.Step]

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            RadialGradient(colors: [Tokens.Brand.violetDark.opacity(0.45), .clear], center: .top, startRadius: 0, endRadius: 520).ignoresSafeArea()
            VStack(spacing: 20) {
                Spacer()
                Image("BrandMark").resizable().scaledToFit().frame(width: 112).accessibilityLabel("MixAI")
                Text("welcome.title").font(Theme.heading(34)).multilineTextAlignment(.center)
                Text("welcome.subtitle").font(Theme.body(17)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center).padding(.horizontal, 24)
                Spacer()
                VStack(spacing: 12) {
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

struct ServerListView: View {
    @Binding var path: [OnboardingFlow.Step]
    @State private var servers: [DiscoveredServer] = []
    @State private var manual = ""
    @State private var checking = false
    @State private var manualError: String?
    private let discovery = Discovery()

    var body: some View {
        List {
            Section {
                if servers.isEmpty {
                    HStack(spacing: 12) { ProgressView(); Text("servers.searching").foregroundStyle(Theme.mutedForeground) }
                }
                ForEach(servers) { s in
                    Button { path.append(.pair(s)) } label: {
                        HStack {
                            Image(systemName: "server.rack").foregroundStyle(Theme.primary)
                            VStack(alignment: .leading) {
                                Text(s.name).font(Theme.body(16, weight: .semibold))
                                Text(s.baseURL).font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                            }
                        }
                    }
                }
            } header: { Text("servers.found") } footer: { Text("servers.hint") }
            Section("servers.manual") {
                TextField("servers.manual_placeholder", text: $manual)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit(checkManual)
                if let manualError { Text(manualError).foregroundStyle(Theme.destructive).font(Theme.body(13)) }
                Button(action: checkManual) { if checking { ProgressView() } else { Text("action.continue") } }
                    .disabled(manual.trimmingCharacters(in: .whitespaces).isEmpty || checking)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("servers.title")
        .task {
            for await list in discovery.browse() { servers = list }
        }
    }

    private func checkManual() {
        var raw = manual.trimmingCharacters(in: .whitespaces)
        if !raw.contains(":"), !raw.contains("://") { raw += ":17899" }
        let base = MmoClient.normalise(raw)
        checking = true
        manualError = nil
        Task {
            defer { checking = false }
            do {
                let info = try await MmoClient(baseURL: base, token: "").pairInfo()
                path.append(.pair(DiscoveredServer(name: info.name, baseURL: base, pairing: info.pairingSupported)))
            } catch {
                manualError = String(localized: "servers.unreachable")
            }
        }
    }
}

struct PairView: View {
    @Environment(AppModel.self) private var app
    let server: DiscoveredServer
    @State private var state: PairState = .idle
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            switch state {
            case .idle, .requesting:
                ProgressView().controlSize(.large)
            case .waiting(let code, _):
                Text("pair.enter_code").font(Theme.body(17)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
                Text(spaced(code))
                    .font(.system(size: 48, weight: .bold, design: .monospaced))
                    .kerning(4)
                    .padding(.horizontal, 24).padding(.vertical, 16)
                    .glassCard(cornerRadius: 20)
                    .accessibilityLabel(Text(code.map(String.init).joined(separator: " ")))
                Text("pair.where \(server.name)").font(Theme.body(15)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center).padding(.horizontal, 32)
                ProgressView()
            case .approved:
                Image(systemName: "checkmark.seal.fill").font(.system(size: 56)).foregroundStyle(Theme.success)
                Text("pair.done").font(Theme.heading(22))
            case .expired:
                Text("pair.expired").font(Theme.heading(20))
                Button("action.retry") { attempt += 1 }.buttonStyle(.glassProminent)
            case .failed(let msg):
                Text("state.error").font(Theme.heading(20))
                Text(msg).font(Theme.body(14)).foregroundStyle(Theme.mutedForeground)
                Button("action.retry") { attempt += 1 }.buttonStyle(.glassProminent)
            }
            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(Theme.background)
        .navigationTitle(server.name)
        .task(id: attempt) {
            for await s in QuickConnect(baseURL: server.baseURL).run(deviceName: ClientIdentity.current.deviceName) {
                state = s
                if case .approved(let token, _) = s {
                    await app.connect(ServerConnection(name: server.name, baseURL: server.baseURL), token: token)
                }
            }
        }
    }

    private func spaced(_ c: String) -> String {
        c.count == 6 ? "\(c.prefix(3)) \(c.suffix(3))" : c
    }
}

/// MixAI account sign-in via the device-code flow on the web origin; then the first reachable companion.
struct SignInView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var code: DeviceCode?
    @State private var status: LocalizedStringKey?
    @State private var errorText: String?
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            if let code {
                Text("signin.open_and_enter").font(Theme.body(17)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
                Text(code.user_code).font(.system(size: 40, weight: .bold, design: .monospaced)).padding(16).glassCard(cornerRadius: 20)
                if let link = URL(string: code.verification_uri_complete ?? code.verification_uri ?? "") {
                    Button { openURL(link) } label: { Label("signin.open_browser", systemImage: "safari") }.buttonStyle(.glassProminent)
                    Text(link.host ?? "").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                }
                if let status { Text(status).font(Theme.body(14)).foregroundStyle(Theme.mutedForeground) }
                ProgressView()
            } else if let errorText {
                Text("state.error").font(Theme.heading(20))
                Text(errorText).font(Theme.body(14)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
                Button("action.retry") { attempt += 1 }.buttonStyle(.glassProminent)
            } else {
                ProgressView().controlSize(.large)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .background(Theme.background)
        .navigationTitle("signin.title")
        .task(id: attempt) { await run() }
    }

    private func run() async {
        let auth = DeviceAuth(origin: app.origin)
        code = nil
        errorText = nil
        do {
            let c = try await auth.requestCode(deviceName: ClientIdentity.current.deviceName)
            code = c
            var interval = max(2, c.interval ?? 5)
            let deadline = Date().addingTimeInterval(TimeInterval(c.expires_in ?? 900))
            while !Task.isCancelled && Date() < deadline {
                try await Task.sleep(for: .seconds(interval))
                switch try await auth.pollToken(deviceCode: c.device_code) {
                case .pending: continue
                case .slowDown: interval += 5
                case .accessDenied: errorText = String(localized: "signin.denied"); code = nil; return
                case .expired: errorText = String(localized: "pair.expired"); code = nil; return
                case .ok(let ok):
                    app.account = ok.user
                    status = "signin.finding_server"
                    if let (c, base) = await auth.pickReachable(ok.companions ?? []) {
                        await app.connect(ServerConnection(name: c.name ?? "MMO Server", baseURL: base), token: c.token)
                    } else {
                        errorText = String(localized: "signin.no_server")
                        code = nil
                    }
                    return
                }
            }
        } catch is CancellationError {
        } catch let e as DeviceAuthError {
            errorText = e.kind == .network ? String(localized: "signin.network \(e.host)") : String(localized: "signin.status \(e.status)")
        } catch {
            errorText = error.localizedDescription
        }
    }
}
