import LiveCore
import SwiftUI

/// MIDI: the engine's open input ports and activity light, the binding map (unbind), the channel filter and
/// program-change recall, plus MIDI learn for actions and mix faders. Effect parameters are learned from a long-press
/// in Chain. Everything is stored by the engine (`midi.json`); controllers edit, performers and viewers read.
/// See `docs/live/midi.md`.
struct MidiView: View {
    @Environment(LiveSession.self) private var session

    var body: some View {
        let m = session.model
        let editable = m.can(.midiSettings())
        let midi = m.state?.midi ?? MidiState()
        List {
            if !editable {
                Section { Label("live.chain.read_only", systemImage: "lock.fill").foregroundStyle(LiveTheme.muted) }
            }
            Section {
                if midi.ports.isEmpty {
                    Text("live.midi.no_ports").foregroundStyle(LiveTheme.muted)
                }
                ForEach(midi.ports, id: \.self) { p in
                    Label { Text(verbatim: p) } icon: { Image(systemName: "cable.connector") }
                }
                MidiActivityRow(last: midi.last)
            } header: {
                Text("live.midi.ports")
            }
            Section {
                Picker("live.midi.channel", selection: Binding(get: { midi.map.settingsChannel }, set: { session.client.send(.midiSettings(channel: $0)) })) {
                    Text("live.midi.omni").tag(0)
                    ForEach(1...16, id: \.self) { c in Text("live.midi.channel_n \(c)").tag(c) }
                }
                Toggle("live.midi.program_change", isOn: Binding(get: { midi.map.programChange }, set: { session.client.send(.midiSettings(programChange: $0)) }))
                    .tint(LiveTheme.accent)
            } footer: {
                Text("live.midi.program_change_hint")
            }
            .disabled(!editable)
            Section {
                if midi.map.bindings.isEmpty {
                    Text("live.midi.no_bindings").foregroundStyle(LiveTheme.muted)
                }
                ForEach(Array(midi.map.bindings.enumerated()), id: \.offset) { i, b in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: midiTargetName(b.target))
                            Text(verbatim: midiSourceName(b.source)).font(.caption.monospaced()).foregroundStyle(LiveTheme.muted)
                        }
                        .accessibilityElement(children: .combine)
                        Spacer()
                        if editable {
                            Button(role: .destructive) { session.client.send(.midiUnbind(index: i)) } label: {
                                Image(systemName: "minus.circle.fill").foregroundStyle(LiveTheme.danger)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel(Text("live.midi.unbind"))
                        }
                    }
                }
                .onDelete { idx in
                    guard editable else { return }
                    // Highest index first so the remaining indices stay valid on the engine.
                    idx.sorted(by: >).forEach { session.client.send(.midiUnbind(index: $0)) }
                }
                .deleteDisabled(!editable)
            } header: {
                Text("live.midi.bindings")
            }
            Section {
                ForEach(MidiAction.allCases, id: \.self) { a in MidiLearnRow(target: .action(action: a), editable: editable) }
            } header: {
                Text("live.midi.actions")
            } footer: {
                Text("live.midi.learn_hint")
            }
            Section {
                ForEach(MixField.allCases, id: \.self) { f in MidiLearnRow(target: .mix(field: f), editable: editable) }
            } header: {
                Text("live.midi.faders")
            }
        }
        .scrollContentBackground(.hidden)
        .background(LiveTheme.background)
        .navigationTitle(Text("live.midi.title"))
        .overlay(alignment: .bottom) {
            VStack(spacing: 0) {
                MidiLearnBanner()
                ErrorBanner()
            }
        }
    }
}

/// A learnable target: tap arms MIDI learn, the trailing text shows what it is bound to (or that it is waiting).
struct MidiLearnRow: View {
    @Environment(LiveSession.self) private var session
    let target: MidiTarget
    let editable: Bool

    var body: some View {
        let midi = session.model.state?.midi ?? MidiState()
        Button { session.client.send(.midiLearn(target: target)) } label: {
            HStack {
                Text(verbatim: midiTargetName(target)).foregroundStyle(LiveTheme.foreground)
                Spacer()
                if midi.learning == target {
                    ProgressView()
                    Text("live.midi.waiting_short").font(.caption).foregroundStyle(LiveTheme.accent)
                } else if let s = midi.source(for: target) {
                    Text(verbatim: midiSourceName(s)).font(.caption.monospaced()).foregroundStyle(LiveTheme.muted)
                } else {
                    Text("live.midi.learn").font(.caption).foregroundStyle(LiveTheme.accent)
                }
            }
        }
        .disabled(!editable)
        .accessibilityHint(Text("live.midi.learn_hint"))
        .midiLearnable(target)
    }
}

/// Lights up briefly when the engine reports a new MIDI message.
struct MidiActivityRow: View {
    let last: String?
    @State private var flash = false

    var body: some View {
        HStack {
            Circle().fill(flash ? LiveTheme.success : LiveTheme.raised).frame(width: 10, height: 10)
                .accessibilityHidden(true)
            Text("live.midi.activity")
            Spacer()
            if let last {
                Text(verbatim: last).font(.caption.monospaced()).foregroundStyle(LiveTheme.muted)
            } else {
                Text("live.midi.no_activity").font(.caption).foregroundStyle(LiveTheme.muted)
            }
        }
        .accessibilityElement(children: .combine)
        .task(id: last) {
            guard last != nil else { return }
            flash = true
            try? await Task.sleep(for: .milliseconds(200))
            flash = false
        }
    }
}

/// Shown while the engine waits for a pedal / switch (`state.midi.learning` set); cancel sends `target: null`.
struct MidiLearnBanner: View {
    @Environment(LiveSession.self) private var session

    var body: some View {
        if let t = session.model.state?.midi.learning {
            HStack(spacing: 12) {
                ProgressView().tint(LiveTheme.accentForeground)
                VStack(alignment: .leading, spacing: 2) {
                    Text("live.midi.waiting \(midiTargetName(t))").font(.subheadline.weight(.semibold))
                    Text("live.midi.waiting_hint").font(.caption)
                }
                Spacer(minLength: 8)
                Button("common.cancel") { session.client.send(.midiLearn(target: nil)) }
                    .buttonStyle(.bordered)
                    .tint(LiveTheme.accentForeground)
                    .disabled(!session.model.can(.midiLearn(target: nil)))
            }
            .foregroundStyle(LiveTheme.accentForeground)
            .padding(14)
            .background(LiveTheme.accent, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .padding(.horizontal)
            .padding(.bottom, 12)
            .accessibilityElement(children: .contain)
        }
    }
}

/// Long-press menu on a control: MIDI learn, and remove the bindings that drive it (controllers only).
struct MidiLearnMenu: ViewModifier {
    @Environment(LiveSession.self) private var session
    let target: MidiTarget

    @ViewBuilder
    func body(content: Content) -> some View {
        if session.model.can(.midiLearn(target: nil)) {
            content.contextMenu {
                Button { session.client.send(.midiLearn(target: target)) } label: {
                    Label("live.midi.learn", systemImage: "pianokeys")
                }
                let bindings = session.model.state?.midi.map.bindings ?? []
                let bound = bindings.indices.filter { bindings[$0].target == target }
                if !bound.isEmpty {
                    Button(role: .destructive) {
                        bound.sorted(by: >).forEach { session.client.send(.midiUnbind(index: $0)) }
                    } label: {
                        Label("live.midi.unbind", systemImage: "xmark.circle")
                    }
                }
            }
        } else {
            content
        }
    }
}

extension View {
    func midiLearnable(_ target: MidiTarget) -> some View { modifier(MidiLearnMenu(target: target)) }
}

/// Small capsule with the MIDI source bound to a control (`CC 4 · ch 1`).
struct MidiBadge: View {
    let source: MidiSource

    var body: some View {
        Text(verbatim: midiSourceName(source))
            .font(.caption2.monospaced())
            .padding(.horizontal, 6).padding(.vertical, 2)
            .foregroundStyle(LiveTheme.accent)
            .background(LiveTheme.raised, in: Capsule())
            .accessibilityLabel(Text("live.midi.bound \(midiSourceName(source))"))
    }
}

func midiTargetName(_ t: MidiTarget) -> String {
    switch t {
    case .param(let fx, let param): "\(fxName(fx)) \u{00B7} \(paramName(param))"
    case .enable(let fx): String(localized: "live.midi.target.enable \(fxName(fx))")
    case .mix(let f): mixFieldName(f)
    case .action(let a): midiActionName(a)
    case .unknown: String(localized: "live.midi.target.unknown")
    }
}

func mixFieldName(_ f: MixField) -> String {
    switch f {
    case .inputDb: String(localized: "live.mix.input")
    case .mainDb: String(localized: "live.mix.main")
    case .monitorDb: String(localized: "live.mix.monitor")
    case .monitorDry: String(localized: "live.mix.monitor_dry")
    }
}

func midiActionName(_ a: MidiAction) -> String {
    switch a {
    case .next: String(localized: "live.midi.action.next")
    case .prev: String(localized: "live.midi.action.prev")
    case .tapTempo: String(localized: "live.midi.action.tap_tempo")
    case .panic: String(localized: "live.midi.action.panic")
    case .toggleBypass: String(localized: "live.midi.action.toggle_bypass")
    case .toggleMute: String(localized: "live.midi.action.toggle_mute")
    }
}

/// `CC 80 · ch 1`, `Note 36 · any channel` (channels are shown 1 based).
func midiSourceName(_ s: MidiSource) -> String {
    let n = Int(s.number)
    let what = s.kind == .cc ? String(localized: "live.midi.cc \(n)") : String(localized: "live.midi.note \(n)")
    let ch = s.displayChannel.map { String(localized: "live.midi.ch \($0)") } ?? String(localized: "live.midi.any_channel")
    return "\(what) \u{00B7} \(ch)"
}
