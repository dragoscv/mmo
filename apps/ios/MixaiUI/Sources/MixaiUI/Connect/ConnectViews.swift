import MixaiCore
import SwiftUI

// Connect + profile screens shared by MixAI and MixAI Music. Hosts own state and navigation; these views only call
// back (`onPick`, `onApproved`, …).

/// Servers on this network (Bonjour) + manual address.
public struct ServerListView: View {
    let onPick: (DiscoveredServer) -> Void
    @State private var servers: [DiscoveredServer] = []
    @State private var manual = ""
    @State private var checking = false
    @State private var manualError: String?
    private let discovery = Discovery()

    public init(onPick: @escaping (DiscoveredServer) -> Void) { self.onPick = onPick }

    public var body: some View {
        List {
            Section {
                if servers.isEmpty {
                    HStack(spacing: 12) { ProgressView(); Text("servers.searching").foregroundStyle(Theme.mutedForeground) }
                }
                ForEach(servers) { s in
                    Button { onPick(s) } label: {
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
                onPick(DiscoveredServer(name: info.name, baseURL: base, pairing: info.pairingSupported))
            } catch {
                manualError = String(localized: "servers.unreachable")
            }
        }
    }
}

/// Quick Connect: show a code, wait until it is approved on the server (or in another signed-in app).
public struct PairView: View {
    let server: DiscoveredServer
    let onApproved: (String) async -> Void
    @State private var state: PairState = .idle
    @State private var attempt = 0

    public init(server: DiscoveredServer, onApproved: @escaping (String) async -> Void) {
        self.server = server
        self.onApproved = onApproved
    }

    public var body: some View {
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
                if case .approved(let token, _) = s { await onApproved(token) }
            }
        }
    }

    private func spaced(_ c: String) -> String {
        c.count == 6 ? "\(c.prefix(3)) \(c.suffix(3))" : c
    }
}

/// MixAI account sign-in via the web device-code flow, then the first reachable server of the account.
public struct DeviceSignInView: View {
    let origin: String
    let onSession: (DeviceTokenOk) -> Void
    let onConnect: (CompanionServer, String) async -> Void
    @Environment(\.openURL) private var openURL
    @State private var code: DeviceCode?
    @State private var status: LocalizedStringKey?
    @State private var errorText: String?
    @State private var attempt = 0

    public init(origin: String, onSession: @escaping (DeviceTokenOk) -> Void, onConnect: @escaping (CompanionServer, String) async -> Void) {
        self.origin = origin
        self.onSession = onSession
        self.onConnect = onConnect
    }

    public var body: some View {
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
        let auth = DeviceAuth(origin: origin)
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
                    onSession(ok)
                    status = "signin.finding_server"
                    if let (c, base) = await auth.pickReachable(ok.companions ?? []) {
                        await onConnect(c, base)
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

/// "Who's watching / listening?" grid. PIN profiles open `PinPadView`.
public struct ProfileGridView: View {
    let title: LocalizedStringKey
    let profiles: [Profile]
    let onPick: (Profile) -> Void
    let unlock: (Profile, String) async -> UnlockResult
    let onUnlocked: (Profile) -> Void
    let reload: () async -> Void
    @State private var pinFor: Profile?

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 20)]

    public init(title: LocalizedStringKey = "profiles.who", profiles: [Profile], onPick: @escaping (Profile) -> Void,
                unlock: @escaping (Profile, String) async -> UnlockResult, onUnlocked: @escaping (Profile) -> Void, reload: @escaping () async -> Void) {
        self.title = title
        self.profiles = profiles
        self.onPick = onPick
        self.unlock = unlock
        self.onUnlocked = onUnlocked
        self.reload = reload
    }

    public var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 28) {
                Text(title).font(Theme.heading(30)).padding(.top, 48)
                if profiles.isEmpty {
                    StateView(kind: .loading)
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 24) {
                            ForEach(profiles, id: \.id) { p in
                                Button { if p.hasPin { pinFor = p } else { onPick(p) } } label: {
                                    VStack(spacing: 10) {
                                        ProfileAvatar(profile: p, size: 88)
                                        Text(p.name).font(Theme.body(16, weight: .medium)).lineLimit(1)
                                        if p.kind == .kid { Text("profiles.kid").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground) }
                                    }
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(Text(p.name))
                                .accessibilityHint(Text(p.hasPin ? "profiles.pin_hint" : "profiles.open_hint"))
                            }
                        }
                        .padding(24)
                    }
                }
            }
        }
        .sheet(item: $pinFor) { p in
            PinPadView(profile: p, unlock: { await unlock(p, $0) }, onUnlocked: onUnlocked).presentationDetents([.medium, .large])
        }
        .task { if profiles.isEmpty { await reload() } }
    }
}

public struct PinPadView: View {
    @Environment(\.dismiss) private var dismiss
    let profile: Profile
    let unlock: (String) async -> UnlockResult
    let onUnlocked: (Profile) -> Void
    @State private var pad = PinPad()
    @State private var message: String?
    @State private var busy = false

    public init(profile: Profile, unlock: @escaping (String) async -> UnlockResult, onUnlocked: @escaping (Profile) -> Void) {
        self.profile = profile
        self.unlock = unlock
        self.onUnlocked = onUnlocked
    }

    public var body: some View {
        VStack(spacing: 22) {
            ProfileAvatar(profile: profile, size: 64).padding(.top, 24)
            Text("pin.enter \(profile.name)").font(Theme.heading(20))
            HStack(spacing: 16) {
                ForEach(0..<PinPad.length, id: \.self) { i in
                    Circle().fill(i < pad.digits.count ? Theme.primary : Theme.muted).frame(width: 16, height: 16)
                }
            }
            .accessibilityElement()
            .accessibilityLabel(Text("pin.progress \(pad.digits.count)"))
            if let message { Text(message).font(Theme.body(14)).foregroundStyle(Theme.destructive) }
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(76), spacing: 18), count: 3), spacing: 14) {
                ForEach(1...9, id: \.self) { key($0) }
                Color.clear.frame(width: 72, height: 72)
                key(0)
                Button { pad.backspace() } label: { Image(systemName: "delete.left").font(.title2).frame(width: 72, height: 72) }
                    .accessibilityLabel(Text("pin.delete"))
            }
            .disabled(busy)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(Theme.background)
    }

    private func key(_ d: Int) -> some View {
        Button {
            if let pin = pad.press(d) { submit(pin) }
        } label: {
            Text("\(d)").font(Theme.heading(28, weight: .medium)).frame(width: 72, height: 72)
        }
        .buttonStyle(.glass)
        .clipShape(.circle)
    }

    private func submit(_ pin: String) {
        busy = true
        Task {
            defer { busy = false }
            switch await unlock(pin) {
            case .ok(let p):
                onUnlocked(p)
                dismiss()
            case .wrongPin(let left):
                pad.clear()
                message = left.map { String(localized: "pin.wrong_left \($0)") } ?? String(localized: "pin.wrong")
            case .locked(let ms):
                pad.clear()
                message = String(localized: "pin.locked \(max(1, ms / 60_000))")
            case .failed(let m):
                pad.clear()
                message = m
            }
        }
    }
}
