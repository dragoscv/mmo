import LiveCore
import SwiftUI

/// "This phone as the engine" (WP21-06): start the Rust engine on the device, connect to it, measure latency.
struct LocalEngineSection: View {
    @Environment(LiveSession.self) private var session
    @State private var local = LocalEngine.shared
    @State private var lan = false

    var body: some View {
        Section {
            switch local.status {
            case .stopped, .failed:
                Toggle("live.local.lan", isOn: $lan)
                Button {
                    Task { await local.start(lan: lan, session: session) }
                } label: {
                    Label("live.local.start", systemImage: "iphone.gen3.radiowaves.left.and.right")
                }
                .disabled(!LocalEngine.available)
                if case let .failed(reason) = local.status {
                    Text(verbatim: String(format: String(localized: "live.local.failed %@"), reason))
                        .font(.footnote).foregroundStyle(LiveTheme.danger)
                }
            case .starting:
                HStack { ProgressView(); Text("live.local.starting") }
            case let .running(input, rate, buffer, lanHost, port):
                Text(verbatim: String(format: String(localized: "live.local.running %@ %lld %lld"), input, rate, buffer))
                    .font(.footnote).foregroundStyle(LiveTheme.success)
                if let lanHost {
                    Text(verbatim: String(format: String(localized: "live.local.lan_at %@ %lld"), lanHost, port))
                        .font(.footnote).foregroundStyle(LiveTheme.muted)
                }
                HStack {
                    Button("live.local.latency") { Task { await local.measureLatency() } }
                        .buttonStyle(.bordered).disabled(local.measuring)
                    Spacer()
                    Button("live.local.stop", role: .destructive) { local.stop(session: session) }
                        .buttonStyle(.bordered)
                }
                if let l = local.latency {
                    Text(verbatim: l).font(.footnote)
                }
            }
        } header: {
            Text("live.local.title")
        } footer: {
            Text(LocalizedStringKey(LocalEngine.available ? "live.local.hint" : "live.local.unavailable"))
        }
    }
}
