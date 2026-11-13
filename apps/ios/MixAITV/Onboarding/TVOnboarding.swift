import MixaiCore
import SwiftUI

/// Welcome → servers on this network (Bonjour) or a typed address → Quick Connect code shown on the TV, approved from
/// the server / phone. The 10-foot layout: brand on the left, focusable list on the right.
struct TVOnboardingView: View {
    enum Step: Hashable { case pair(DiscoveredServer) }
    @State private var path: [Step] = []

    var body: some View {
        NavigationStack(path: $path) {
            TVServerPicker(path: $path)
                .navigationDestination(for: Step.self) { s in
                    switch s {
                    case .pair(let server): TVPairView(server: server)
                    }
                }
        }
    }
}

struct TVServerPicker: View {
    @Binding var path: [TVOnboardingView.Step]
    @State private var servers: [DiscoveredServer] = []
    @State private var manual = ""
    @State private var checking = false
    @State private var manualError: String?
    private let discovery = Discovery()

    var body: some View {
        HStack(alignment: .top, spacing: 80) {
            VStack(alignment: .leading, spacing: 28) {
                BrandMarkView(.tv, animation: .intro).frame(width: 140, height: 140)
                Text("welcome.title").font(TVTheme.heading(64))
                Text("welcome.subtitle").font(TVTheme.body(30)).foregroundStyle(TVTheme.mutedForeground)
                Text("servers.hint").font(TVTheme.body(24)).foregroundStyle(TVTheme.mutedForeground)
            }
            .frame(maxWidth: 700, alignment: .leading)
            .padding(.top, 40)

            VStack(alignment: .leading, spacing: 24) {
                Text("servers.found").font(TVTheme.heading(34))
                if servers.isEmpty {
                    HStack(spacing: 16) { ProgressView(); Text("servers.searching").foregroundStyle(TVTheme.mutedForeground) }
                        .padding(.vertical, 12)
                }
                ForEach(servers) { s in
                    Button { path.append(.pair(s)) } label: {
                        HStack(spacing: 20) {
                            Image(systemName: "server.rack").font(.system(size: 34))
                            VStack(alignment: .leading, spacing: 4) {
                                Text(s.name).font(TVTheme.body(30, weight: .semibold))
                                Text(s.baseURL).font(TVTheme.body(22)).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .padding(.vertical, 8)
                    }
                }
                Text("servers.manual").font(TVTheme.heading(30)).padding(.top, 24)
                TextField("servers.manual_placeholder", text: $manual)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit(checkManual)
                if let manualError { Text(manualError).foregroundStyle(TVTheme.destructive).font(TVTheme.body(24)) }
                Button(action: checkManual) {
                    if checking { ProgressView() } else { Text("action.continue").frame(minWidth: 240) }
                }
                .disabled(manual.trimmingCharacters(in: .whitespaces).isEmpty || checking)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(80)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            ZStack {
                TVTheme.background
                RadialGradient(colors: [Tokens.Brand.violetDark.opacity(0.35), .clear], center: .topLeading, startRadius: 0, endRadius: 1100)
            }
            .ignoresSafeArea()
        }
        .task { for await list in discovery.browse() { servers = list } }
        .task {
            #if DEBUG
            // Simulator screenshots / UI checks: SIMCTL_CHILD_MIXAI_AUTOPAIR=https://demo.mixai.ro pairs without input.
            if let auto = ProcessInfo.processInfo.environment["MIXAI_AUTOPAIR"], path.isEmpty {
                manual = auto
                checkManual()
            }
            #endif
        }
    }

    private func checkManual() {
        var raw = manual.trimmingCharacters(in: .whitespaces)
        // A bare host means a LAN server on the default port; https URLs keep 443 (demo / tunnels).
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

struct TVPairView: View {
    @Environment(TVModel.self) private var model
    let server: DiscoveredServer
    @State private var state: PairState = .idle
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: 36) {
            Spacer()
            switch state {
            case .idle, .requesting:
                ProgressView()
            case .waiting(let code, _):
                Text("pair.enter_code").font(TVTheme.body(34)).foregroundStyle(TVTheme.mutedForeground).multilineTextAlignment(.center)
                Text(code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code)
                    .font(.system(size: 120, weight: .bold, design: .monospaced))
                    .kerning(10)
                    .padding(.horizontal, 60).padding(.vertical, 30)
                    .background(TVTheme.card, in: .rect(cornerRadius: 36))
                    .accessibilityLabel(Text(code.map(String.init).joined(separator: " ")))
                Text("pair.where \(server.name)").font(TVTheme.body(28)).foregroundStyle(TVTheme.mutedForeground)
                ProgressView()
            case .approved:
                Image(systemName: "checkmark.seal.fill").font(.system(size: 110)).foregroundStyle(TVTheme.success)
                Text("pair.done").font(TVTheme.heading(44))
            case .expired:
                Text("pair.expired").font(TVTheme.heading(44))
                Button("action.retry") { attempt += 1 }
            case .failed(let msg):
                Text("state.error").font(TVTheme.heading(44))
                Text(msg).font(TVTheme.body(26)).foregroundStyle(TVTheme.mutedForeground)
                Button("action.retry") { attempt += 1 }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(TVTheme.background.ignoresSafeArea())
        .navigationTitle(server.name)
        .task(id: attempt) {
            for await s in QuickConnect(baseURL: server.baseURL).run(deviceName: ClientIdentity.current.deviceName) {
                state = s
                if case .approved(let token, _) = s {
                    await model.connect(TVServer(name: server.name, baseURL: server.baseURL), token: token)
                }
            }
        }
    }
}
