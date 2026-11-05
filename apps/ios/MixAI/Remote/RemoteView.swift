import MixaiCore
import SwiftUI

/// Phone as a remote for a MixAI TV: touchpad (tap = play/pause, ←/→ = −10/+30 s, ↑/↓ = volume), sections, text.
struct RemoteView: View {
    @Environment(AppModel.self) private var app
    @State private var targetId: String?
    @State private var search = ""
    @State private var lastError: String?

    private struct NavTarget: Identifiable {
        let id: String
        let label: LocalizedStringKey
        let icon: String
    }

    private static var sections: [NavTarget] { [
        NavTarget(id: "home", label: "remote.nav.home", icon: "house"), NavTarget(id: "movies", label: "remote.nav.movies", icon: "film"),
        NavTarget(id: "shows", label: "remote.nav.shows", icon: "tv"), NavTarget(id: "music", label: "remote.nav.music", icon: "music.note"),
        NavTarget(id: "livetv", label: "remote.nav.live", icon: "dot.radiowaves.left.and.right"),
        NavTarget(id: "search", label: "remote.nav.search", icon: "magnifyingglass"), NavTarget(id: "settings", label: "remote.nav.settings", icon: "gearshape"),
    ] }

    private var target: HubDevice? {
        app.playbackTargets.first { $0.deviceId == targetId } ?? app.playbackTargets.first
    }

    var body: some View {
        Group {
            if let t = target { remote(t) } else { StateView(kind: .empty("remote.none", "remote.none_hint")) }
        }
        .background(Theme.background)
        .navigationTitle("remote.title")
        .toolbar {
            if app.playbackTargets.count > 1 {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        ForEach(app.playbackTargets, id: \.deviceId) { d in
                            Button(d.name) { targetId = d.deviceId }
                        }
                    } label: { Image(systemName: "tv") }
                    .accessibilityLabel(Text("remote.pick_tv"))
                }
            }
        }
    }

    private func remote(_ t: HubDevice) -> some View {
        ScrollView {
            VStack(spacing: 18) {
                VStack(spacing: 4) {
                    Text(t.name).font(Theme.heading(20))
                    if let np = t.nowPlaying, let title = np.media?.title {
                        Text(title).font(Theme.body(14)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        Text(verbatim: "\(formatClock(AppModel.livePosition(np))) / \(formatClock(np.durationSec ?? 0))")
                            .font(Theme.body(12).monospacedDigit()).foregroundStyle(Theme.mutedForeground)
                    } else {
                        Text("remote.idle").font(Theme.body(14)).foregroundStyle(Theme.mutedForeground)
                    }
                }
                touchpad(t)
                HStack(spacing: 16) {
                    control("backward.end.fill", "music.previous") { send(t, "previous") }
                    control("gobackward.10", "player.back10") { seek(t, by: -10) }
                    control((t.nowPlaying?.playing ?? false) ? "pause.fill" : "play.fill", "remote.toggle") { toggle(t) }
                    control("goforward.30", "player.fwd30") { seek(t, by: 30) }
                    control("forward.end.fill", "music.next") { send(t, "next") }
                }
                HStack(spacing: 16) {
                    control("speaker.minus.fill", "remote.volume_down") { volume(t, -10) }
                    Text(verbatim: "\(app.remoteVolume)").font(Theme.body(14).monospacedDigit()).frame(width: 44)
                        .accessibilityLabel(Text("remote.volume \(app.remoteVolume)"))
                    control("speaker.plus.fill", "remote.volume_up") { volume(t, 10) }
                    control("stop.fill", "remote.stop") { send(t, "stop") }
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 10)], spacing: 10) {
                    ForEach(Self.sections) { s in
                        Button { send(t, "navigate", ["to": .string(s.id)]) } label: {
                            Label(s.label, systemImage: s.icon).font(Theme.body(13)).frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .buttonStyle(.glass)
                    }
                }
                HStack {
                    TextField("remote.text_placeholder", text: $search)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { sendText(t) }
                    Button("remote.send") { sendText(t) }.buttonStyle(.glassProminent).disabled(search.isEmpty)
                }
                if let lastError { Text(lastError).font(Theme.body(12)).foregroundStyle(Theme.destructive) }
            }
            .padding(20)
        }
    }

    private func touchpad(_ t: HubDevice) -> some View {
        RoundedRectangle(cornerRadius: 24)
            .fill(Theme.card)
            .frame(height: 240)
            .overlay(Text("remote.touchpad_hint").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center).padding())
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 24).onEnded { v in
                    let dx = v.translation.width, dy = v.translation.height
                    if abs(dx) > abs(dy) { seek(t, by: dx < 0 ? -10 : 30) } else { volume(t, dy < 0 ? 10 : -10) }
                }
            )
            .simultaneousGesture(TapGesture().onEnded { toggle(t) })
            .accessibilityElement()
            .accessibilityLabel(Text("remote.touchpad"))
            .accessibilityHint(Text("remote.touchpad_hint"))
            .accessibilityAddTraits(.allowsDirectInteraction)
    }

    private func control(_ icon: String, _ label: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).font(.title3).frame(width: 44, height: 44) }
            .buttonStyle(.glass)
            .accessibilityLabel(Text(label))
    }

    private func toggle(_ t: HubDevice) { send(t, (t.nowPlaying?.playing ?? false) ? "pause" : "resume") }

    private func seek(_ t: HubDevice, by delta: Double) {
        let pos = t.nowPlaying.map(AppModel.livePosition) ?? 0
        send(t, "seek", ["positionSec": .number(max(0, pos + delta))])
    }

    private func volume(_ t: HubDevice, _ delta: Int) {
        app.remoteVolume = max(0, min(100, app.remoteVolume + delta))
        send(t, "volume", ["level": .number(Double(app.remoteVolume))])
    }

    private func sendText(_ t: HubDevice) {
        guard !search.isEmpty else { return }
        send(t, "text", ["value": .string(search)])
        search = ""
    }

    private func send(_ t: HubDevice, _ action: String, _ args: [String: JSONValue] = [:]) {
        guard let phone = app.phone else { return }
        let id = t.deviceId
        Task {
            do {
                let ack = try await phone.command(target: id, action: action, args: args)
                lastError = ack.ok ? nil : (ack.error ?? String(localized: "playon.failed"))
            } catch {
                lastError = error.localizedDescription
            }
        }
    }
}
