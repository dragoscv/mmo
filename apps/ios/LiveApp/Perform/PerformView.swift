import LiveCore
import SwiftUI
import UIKit

/// Perform: everything a singer needs on stage. Meters, tuner, PANIC / MUTE / BYPASS, scene prev / next, tap tempo,
/// mix sliders (throttled 30 ms per control by `LiveClient`), presets, setlist and the lyrics teleprompter.
/// The display stays awake while this screen is shown and the engine is connected.
struct PerformView: View {
    @Environment(LiveSession.self) private var session
    @Environment(\.horizontalSizeClass) private var hSize

    var body: some View {
        let m = session.model
        ScrollView {
            if hSize == .regular {
                HStack(alignment: .top, spacing: 16) {
                    VStack(spacing: 16) { live(m) }.frame(maxWidth: .infinity)
                    VStack(spacing: 16) { show(m) }.frame(maxWidth: .infinity)
                }
                .padding()
            } else {
                VStack(spacing: 16) { live(m); show(m) }.padding()
            }
        }
        .background(LiveTheme.background)
        .navigationTitle(Text(verbatim: m.hello?.engineName ?? String(localized: "live.perform.title")))
        .toolbar { ToolbarItem(placement: .topBarTrailing) { StatusText(phase: m.phase, role: m.role) } }
        .onAppear { session.performing = true; session.client.setMeters(true) }
        .onDisappear { session.performing = false }
        .overlay(alignment: .bottom) { ErrorBanner() }
    }

    @ViewBuilder private func live(_ m: LiveModel) -> some View {
        SceneHeader(state: m.state)
        MetersView()
        if let t = m.meters?.tune { TunerView(tune: t) }
        StageButtons()
        MixSliders()
    }

    @ViewBuilder private func show(_ m: LiveModel) -> some View {
        if let st = m.state {
            PresetsCard(state: st)
            if let set = st.setlist { SetlistCard(setlist: set, position: st.position) }
            if let song = st.currentSong, let lyrics = song.lyrics, !lyrics.isEmpty {
                TeleprompterView(lyrics: lyrics, part: st.currentPart?.name)
            }
        }
    }
}

/// Current song / part, next part, key and tempo.
struct SceneHeader: View {
    let state: SessionState?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let st = state, let song = st.currentSong {
                Text(verbatim: song.title).font(.title2.weight(.bold)).lineLimit(2)
                HStack(spacing: 8) {
                    if let p = st.currentPart { Text(verbatim: p.name).font(.headline).foregroundStyle(LiveTheme.accent) }
                    if let k = song.key { Text(verbatim: k).font(.subheadline).foregroundStyle(LiveTheme.muted) }
                    if let b = st.bpm ?? song.bpm { Text("live.perform.bpm \(Int(b.rounded()))").font(.subheadline.monospacedDigit()).foregroundStyle(LiveTheme.muted) }
                }
                if let n = st.nextPart {
                    Text("live.perform.next \(n.part.name)").font(.caption).foregroundStyle(LiveTheme.muted)
                }
            } else {
                Text(verbatim: state.flatMap { $0.preset.isEmpty ? nil : $0.preset } ?? String(localized: "live.perform.no_setlist"))
                    .font(.title2.weight(.bold))
                if let b = state?.bpm { Text("live.perform.bpm \(Int(b.rounded()))").font(.subheadline.monospacedDigit()).foregroundStyle(LiveTheme.muted) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .liveCard()
        .accessibilityElement(children: .combine)
    }
}

struct StageButtons: View {
    @Environment(LiveSession.self) private var session

    var body: some View {
        let m = session.model
        let mix = m.state?.mix ?? MixState()
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                PanicButton(enabled: m.can(.panic)) { session.client.send(.panic) }
                StateToggle(title: "live.perform.mute", systemImage: mix.mute ? "speaker.slash.fill" : "speaker.wave.2.fill",
                            on: mix.mute, tint: LiveTheme.warning, enabled: m.can(.setMix(MixChange(mute: true)))) {
                    session.client.send(.setMix(MixChange(mute: !mix.mute)))
                }
                StateToggle(title: "live.perform.bypass", systemImage: "arrow.triangle.branch", on: mix.bypass, tint: LiveTheme.info,
                            enabled: m.can(.setMix(MixChange(bypass: true)))) {
                    session.client.send(.setMix(MixChange(bypass: !mix.bypass)))
                }
            }
            HStack(spacing: 10) {
                PadButton(title: "live.perform.prev", systemImage: "backward.end.fill", enabled: m.can(.prev) && m.state?.setlist != nil) {
                    session.client.send(.prev)
                }
                PadButton(title: "live.perform.tap", systemImage: "hand.tap.fill", enabled: m.can(.tapTempo)) {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    session.client.send(.tapTempo)
                }
                PadButton(title: "live.perform.next_button", systemImage: "forward.end.fill", enabled: m.can(.next) && m.state?.setlist != nil) {
                    session.client.send(.next)
                }
            }
        }
    }
}

struct MixSliders: View {
    @Environment(LiveSession.self) private var session

    var body: some View {
        let m = session.model
        let mix = m.state?.mix ?? MixState()
        let ok = m.can(.setMix(MixChange(inputDb: 0)))
        VStack(spacing: 12) {
            LiveSlider(title: "live.mix.input", value: mix.inputDb, range: -24...12, step: 0.5, format: LiveFormat.db, enabled: ok) {
                session.client.send(.setMix(MixChange(inputDb: $0)))
            }
            LiveSlider(title: "live.mix.main", value: mix.mainDb, range: -60...12, step: 0.5, format: LiveFormat.db, enabled: ok) {
                session.client.send(.setMix(MixChange(mainDb: $0)))
            }
            LiveSlider(title: "live.mix.monitor", value: mix.monitorDb, range: -60...12, step: 0.5, format: LiveFormat.db, enabled: ok) {
                session.client.send(.setMix(MixChange(monitorDb: $0)))
            }
            LiveSlider(title: "live.mix.monitor_dry", value: mix.monitorDry, range: 0...1, step: 0.01, format: LiveFormat.percent, enabled: ok) {
                session.client.send(.setMix(MixChange(monitorDry: $0)))
            }
        }
        .liveCard()
    }
}

struct PresetsCard: View {
    @Environment(LiveSession.self) private var session
    let state: SessionState
    @State private var removing: String?

    var body: some View {
        let ok = session.model.can(.loadPreset(name: ""))
        let manage = session.model.can(.deletePreset(name: ""))
        VStack(alignment: .leading, spacing: 10) {
            Text("live.perform.presets").font(.caption.weight(.semibold)).foregroundStyle(LiveTheme.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(state.presets, id: \.self) { p in
                        let on = p == state.preset
                        Button { session.client.send(.loadPreset(name: p)) } label: {
                            Text(verbatim: p).font(.subheadline.weight(on ? .bold : .regular))
                                .padding(.horizontal, 14).padding(.vertical, 10)
                                .foregroundStyle(on ? LiveTheme.accentForeground : LiveTheme.foreground)
                                .background(on ? LiveTheme.accent : LiveTheme.raised, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(!ok)
                        .accessibilityAddTraits(on ? .isSelected : [])
                        .contextMenu {
                            if manage && state.isRemovable(p) {
                                // Factory presets are reverted (the engine refuses an unmodified one), user presets deleted.
                                Button(role: .destructive) { removing = p } label: {
                                    if state.isFactory(p) {
                                        Label("live.preset.revert", systemImage: "arrow.uturn.backward")
                                    } else {
                                        Label("live.preset.delete", systemImage: "trash")
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if manage { Text("live.preset.manage_hint").font(.caption2).foregroundStyle(LiveTheme.muted) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .liveCard()
        .confirmationDialog(Text(verbatim: removing ?? ""), isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { name in
            if state.isFactory(name) {
                Button("live.preset.revert_confirm", role: .destructive) { session.client.send(.deletePreset(name: name)) }
            } else {
                Button("live.preset.delete_confirm", role: .destructive) { session.client.send(.deletePreset(name: name)) }
            }
            Button("common.cancel", role: .cancel) {}
        } message: { name in
            Text(LocalizedStringKey(state.isFactory(name) ? "live.preset.revert_message" : "live.preset.delete_message"))
        }
    }
}

struct SetlistCard: View {
    @Environment(LiveSession.self) private var session
    let setlist: Setlist
    let position: Position?

    var body: some View {
        let ok = session.model.can(.goto(song: 0, part: 0))
        VStack(alignment: .leading, spacing: 8) {
            Text("live.perform.setlist \(setlist.name)").font(.caption.weight(.semibold)).foregroundStyle(LiveTheme.muted)
            ForEach(Array(setlist.songs.enumerated()), id: \.offset) { si, song in
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: song.artist.isEmpty ? song.title : "\(song.title) \u{00B7} \(song.artist)")
                        .font(.subheadline.weight(position?.song == si ? .bold : .regular))
                        .foregroundStyle(position?.song == si ? LiveTheme.foreground : LiveTheme.muted)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(Array(song.parts.enumerated()), id: \.offset) { pi, part in
                                let on = position == Position(song: si, part: pi)
                                Button { session.client.send(.goto(song: si, part: pi)) } label: {
                                    Text(verbatim: part.name).font(.caption.weight(.semibold))
                                        .padding(.horizontal, 10).padding(.vertical, 6)
                                        .foregroundStyle(on ? LiveTheme.accentForeground : LiveTheme.foreground)
                                        .background(on ? LiveTheme.accent : LiveTheme.raised, in: Capsule())
                                }
                                .buttonStyle(.plain)
                                .disabled(!ok)
                                .accessibilityAddTraits(on ? .isSelected : [])
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .liveCard()
    }
}

/// Lyrics teleprompter: large text, the section of the current part scrolls to the top on every scene change.
struct TeleprompterView: View {
    let lyrics: String
    let part: String?
    @AppStorage("liveTeleprompterSize") private var size: Double = 22

    var body: some View {
        let sections = Teleprompter.sections(lyrics)
        let current = Teleprompter.section(for: part, in: sections)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("live.perform.lyrics").font(.caption.weight(.semibold)).foregroundStyle(LiveTheme.muted)
                Spacer()
                Button { size = max(14, size - 2) } label: { Image(systemName: "textformat.size.smaller") }
                    .accessibilityLabel(Text("live.perform.text_smaller"))
                Button { size = min(48, size + 2) } label: { Image(systemName: "textformat.size.larger") }
                    .accessibilityLabel(Text("live.perform.text_larger"))
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(sections) { s in
                            VStack(alignment: .leading, spacing: 4) {
                                if let t = s.title { Text(verbatim: t).font(.caption.weight(.bold)).foregroundStyle(LiveTheme.accent) }
                                Text(verbatim: s.lines.joined(separator: "\n"))
                                    .font(.system(size: size, weight: s.id == current ? .semibold : .regular))
                                    .foregroundStyle(s.id == current || current == nil ? LiveTheme.foreground : LiveTheme.muted)
                            }
                            .id(s.id)
                        }
                    }
                }
                .frame(minHeight: 220, maxHeight: 420)
                .onChange(of: current, initial: true) { _, c in
                    guard let c else { return }
                    withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(c, anchor: .top) }
                }
            }
        }
        .liveCard()
    }
}

struct ErrorBanner: View {
    @Environment(LiveSession.self) private var session

    var body: some View {
        if let e = session.model.lastError {
            Text(LocalizedStringKey(e.key))
                .font(.subheadline)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .foregroundStyle(LiveTheme.dangerForeground)
                .background(LiveTheme.danger, in: Capsule())
                .padding(.bottom, 12)
                .onTapGesture { session.client.clearError() }
                .task(id: e) {
                    try? await Task.sleep(for: .seconds(3))
                    session.client.clearError()
                }
                .accessibilityAddTraits(.isStaticText)
        }
    }
}
