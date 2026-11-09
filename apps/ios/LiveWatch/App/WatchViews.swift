import LiveCore
import SwiftUI

struct WatchRoot: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        TabView {
            SceneScreen()
            ControlsScreen()
        }
        .tabViewStyle(.verticalPage)
        .tint(Tokens.Dark.primary)
    }
}

/// Current song / part around the input level ring, prev / next below.
struct SceneScreen: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        let s = model.snapshot
        VStack(spacing: 6) {
            ZStack {
                TimelineView(.animation(minimumInterval: 1 / 20, paused: model.route == .none)) { _ in
                    LevelRing(level: model.level)
                }
                VStack(spacing: 2) {
                    Text(verbatim: s.part ?? "\u{2014}").font(.headline).lineLimit(2).multilineTextAlignment(.center)
                    if let song = s.song { Text(verbatim: song).font(.caption2).foregroundStyle(Tokens.Dark.mutedForeground).lineLimit(1) }
                }
                .padding(.horizontal, 14)
            }
            .frame(maxHeight: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text("live.watch.cd_scene \(s.song ?? "") \(s.part ?? "")"))
            HStack(spacing: 8) {
                Button { model.send(.prev) } label: { Image(systemName: "backward.end.fill") }
                    .accessibilityLabel(Text("live.perform.prev"))
                Button { model.send(.next) } label: { Image(systemName: "forward.end.fill") }
                    .accessibilityLabel(Text("live.perform.next_button"))
            }
            .disabled(!model.canPerform)
            if let n = s.nextPart { Text("live.perform.next \(n)").font(.caption2).foregroundStyle(Tokens.Dark.mutedForeground).lineLimit(1) }
        }
        .navigationTitle(Text(verbatim: s.engineName.isEmpty ? String(localized: "live.watch.title") : s.engineName))
        .overlay(alignment: .top) { if !s.connected || model.route == .none { RouteHint() } }
    }
}

struct LevelRing: View {
    let level: Double

    var body: some View {
        ZStack {
            Circle().stroke(Tokens.Dark.secondary, lineWidth: 8)
            Circle().trim(from: 0, to: level)
                .stroke(level > 0.89 ? Tokens.Dark.destructive : level > 0.77 ? Tokens.Dark.warning : Tokens.Dark.success,
                        style: StrokeStyle(lineWidth: 8, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.1), value: level)
        }
        .padding(4)
        .accessibilityHidden(true)
    }
}

/// Mute toggle and PANIC (hold 1 s). Both need the performer role.
struct ControlsScreen: View {
    @Environment(WatchModel.self) private var model
    @State private var panicArmed = false

    var body: some View {
        let s = model.snapshot
        VStack(spacing: 10) {
            Button { model.send(s.mute ? .unmute : .mute) } label: {
                    Label(LocalizedStringKey(s.mute ? "live.watch.unmute" : "live.perform.mute"),
                        systemImage: s.mute ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    .frame(maxWidth: .infinity)
            }
            .tint(s.mute ? Tokens.Dark.warning : Tokens.Dark.secondary)
            Button { model.send(.tap) } label: { Label("live.perform.tap", systemImage: "hand.tap.fill").frame(maxWidth: .infinity) }
            Text("live.perform.panic")
                .font(.headline.weight(.heavy))
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(Tokens.Dark.destructiveForeground)
                .background(Tokens.Dark.destructive.opacity(panicArmed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: 12))
                .onLongPressGesture(minimumDuration: 1, perform: { panicArmed = false; model.send(.panic) },
                                    onPressingChanged: { panicArmed = $0 })
                .accessibilityAddTraits(.isButton)
                .accessibilityHint(Text("live.perform.panic_hint"))
                .accessibilityAction { model.send(.panic) }
        }
        .disabled(!model.canPerform)
        .opacity(model.canPerform ? 1 : 0.5)
        .overlay(alignment: .bottom) {
            if s.connected, s.role < .performer { Text("live.watch.viewer").font(.caption2).foregroundStyle(Tokens.Dark.mutedForeground) }
        }
    }
}

struct RouteHint: View {
    var body: some View {
        Text("live.watch.open_phone")
            .font(.caption2)
            .foregroundStyle(Tokens.Dark.mutedForeground)
            .multilineTextAlignment(.center)
            .padding(6)
            .background(Tokens.Dark.card, in: Capsule())
    }
}
