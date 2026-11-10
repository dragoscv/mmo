import LiveCore
import SwiftUI

/// Connect: paired engines (auto-reconnect to the last one), engines found on the network (Bonjour), QR pairing and
/// manual address + token.
struct ConnectView: View {
    @Environment(LiveSession.self) private var session
    @State private var scanning = false
    @State private var manual: ManualSeed?
    @State private var invalidCode = false

    var body: some View {
        List {
            statusSection
            LocalEngineSection()
            if !session.store.engines.isEmpty {
                Section("live.connect.paired") {
                    ForEach(session.store.engines) { e in pairedRow(e) }
                        .onDelete { idx in idx.map { session.store.engines[$0] }.forEach(session.forget) }
                }
            }
            Section {
                ForEach(session.discovery.found) { f in
                    Button { pick(f) } label: {
                        Label { Text(verbatim: f.name) } icon: { Image(systemName: "dot.radiowaves.left.and.right") }
                    }
                }
                if session.discovery.found.isEmpty {
                    Text(LocalizedStringKey(session.discovery.denied ? "live.connect.local_network_off" : "live.connect.searching"))
                        .foregroundStyle(LiveTheme.muted)
                }
            } header: {
                Text("live.connect.nearby")
            } footer: {
                Text("live.connect.nearby_hint")
            }
            Section {
                Button { scanning = true } label: { Label("live.connect.scan", systemImage: "qrcode.viewfinder") }
                    .disabled(!QRScannerView.isAvailable)
                Button { manual = ManualSeed() } label: { Label("live.connect.manual", systemImage: "keyboard") }
            } footer: {
                Text("live.connect.scan_hint")
            }
        }
        .scrollContentBackground(.hidden)
        .background(LiveTheme.background)
        .navigationTitle(Text("live.connect.title"))
        .sheet(isPresented: $scanning) {
            NavigationStack {
                QRScannerView { code in
                    scanning = false
                    if let link = PairingLink.parse(code) { session.pair(link) } else { invalidCode = true }
                }
                .ignoresSafeArea()
                .navigationTitle(Text("live.connect.scan"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("common.cancel") { scanning = false } } }
            }
        }
        .sheet(item: $manual) { seed in ManualPairView(seed: seed) }
        .alert("live.connect.invalid_code", isPresented: $invalidCode) { Button("common.ok", role: .cancel) {} }
    }

    @ViewBuilder private var statusSection: some View {
        if let e = session.current {
            Section {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: session.model.hello?.engineName ?? e.name).font(.headline)
                        StatusText(phase: session.model.phase, role: session.model.role)
                    }
                    Spacer()
                    if case .failed = session.model.phase {
                        Button("live.connect.retry") { session.client.reconnect() }.buttonStyle(.bordered)
                    }
                    Button("live.connect.disconnect", role: .destructive) { session.disconnect() }.buttonStyle(.bordered)
                }
            }
        }
    }

    private func pairedRow(_ e: PairedEngine) -> some View {
        Button { session.connect(e) } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: e.name).foregroundStyle(LiveTheme.foreground)
                    Text(verbatim: e.endpoint.display).font(.caption.monospaced()).foregroundStyle(LiveTheme.muted)
                }
                Spacer()
                if let r = e.role { RoleBadge(role: r) }
                if session.current?.id == e.id { Image(systemName: "checkmark").foregroundStyle(LiveTheme.accent) }
            }
        }
        .accessibilityHint(Text("live.connect.connect_hint"))
    }

    /// A discovered engine needs a token: if it is already paired, connect; else open the manual form prefilled.
    private func pick(_ f: LiveDiscovery.Found) {
        Task {
            guard let ep = await LiveDiscovery.resolve(f) else { manual = ManualSeed(name: f.name); return }
            if let known = session.store.engines.first(where: { $0.endpoint == ep }) { session.connect(known) } else {
                manual = ManualSeed(address: ep.display, name: f.name)
            }
        }
    }
}

struct ManualSeed: Identifiable {
    let id = UUID()
    var address = ""
    var name: String?
}

/// Manual pairing: a pasted link (`mixai-live://pair?...` or `http://host:17920/?t=...`), or address + token.
struct ManualPairView: View {
    @Environment(LiveSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    let seed: ManualSeed
    @State private var address = ""
    @State private var token = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("live.manual.address", text: $address)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    SecureField("live.manual.token", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } footer: {
                    Text("live.manual.hint")
                }
                if let err = error { Section { Text(err).foregroundStyle(LiveTheme.danger) } }
            }
            .navigationTitle(Text("live.connect.manual"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("common.cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("live.manual.connect") { if let l = link { session.pair(l); dismiss() } }.disabled(link == nil)
                }
            }
            .onAppear { address = seed.address }
        }
    }

    private var link: PairingLink? {
        let a = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if let l = PairingLink.parse(a) { return l }
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard PairingLink.isToken(t), !a.isEmpty else { return nil }
        let raw = a.contains("://") ? a : "http://" + a
        guard var c = URLComponents(string: raw), let host = c.host, !host.isEmpty else { return nil }
        c.queryItems = nil
        return PairingLink(endpoint: EngineEndpoint(host: host, port: c.port ?? LiveProtocol.defaultPort), token: t, name: seed.name)
    }

    private var error: String? {
        guard !token.isEmpty, !PairingLink.isToken(token.trimmingCharacters(in: .whitespaces)) else { return nil }
        return String(localized: "live.manual.bad_token")
    }
}

struct StatusText: View {
    let phase: ConnectionPhase
    let role: Role

    var body: some View {
        Group {
            switch phase {
            case .idle: Text("live.status.idle")
            case .connecting: Text("live.status.connecting")
            case .connected: Text("live.status.connected \(roleName(role))")
            case .waiting(_, let s): Text("live.status.retrying \(Int(s.rounded(.up)))")
            case .failed(.unauthorized): Text("live.status.unauthorized")
            case .failed(.protocolTooNew): Text("live.status.update_app")
            case .failed(.unreachable): Text("live.status.unreachable")
            }
        }
        .font(.caption)
        .foregroundStyle(color)
    }

    private var color: Color {
        switch phase {
        case .connected: LiveTheme.success
        case .failed: LiveTheme.danger
        default: LiveTheme.warning
        }
    }
}

func roleName(_ r: Role) -> String {
    switch r {
    case .viewer: String(localized: "live.role.viewer")
    case .performer: String(localized: "live.role.performer")
    case .controller: String(localized: "live.role.controller")
    }
}

struct RoleBadge: View {
    let role: Role
    var body: some View {
        Text(verbatim: roleName(role)).font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(LiveTheme.raised, in: Capsule())
            .foregroundStyle(LiveTheme.muted)
    }
}
