import LiveCore
import SwiftUI

/// Chain: the inserts of the running preset. Controllers toggle inserts, edit key parameters (ranges and curves from
/// `GET /api/fx`), add / remove / reorder inserts and save the preset; performers and viewers see it read-only.
/// A long-press on an insert switch or a parameter arms MIDI learn for it (`docs/live/midi.md`).
struct ChainView: View {
    @Environment(LiveSession.self) private var session
    @State private var adding = false
    @State private var saving = false
    @State private var presetName = ""

    var body: some View {
        let m = session.model
        let editable = m.can(.setEnabled(insert: 0, on: true))
        List {
            if !editable {
                Section { Label("live.chain.read_only", systemImage: "lock.fill").foregroundStyle(LiveTheme.muted) }
            }
            if let st = m.state {
                Section {
                    ForEach(Array(st.chain.enumerated()), id: \.element.id) { i, ins in
                        InsertRow(insert: ins, spec: session.client.fxSpec(ins.fx), gr: gr(m, i), editable: editable)
                    }
                    .onMove { from, to in
                        guard editable, let f = from.first else { return }
                        let ins = st.chain[f]
                        session.client.send(.moveInsert(insert: ins.id, to: UInt32(to > f ? to - 1 : to)))
                    }
                    .onDelete { idx in
                        guard editable else { return }
                        idx.forEach { session.client.send(.removeInsert(insert: st.chain[$0].id)) }
                    }
                    .moveDisabled(!editable)
                    .deleteDisabled(!editable)
                } header: {
                    Text("live.chain.preset \(st.preset)")
                } footer: {
                    if editable && !st.chain.isEmpty { Text("live.midi.chain_hint") }
                }
            } else {
                Text("live.chain.empty").foregroundStyle(LiveTheme.muted)
            }
        }
        .scrollContentBackground(.hidden)
        .background(LiveTheme.background)
        .navigationTitle(Text("live.chain.title"))
        .toolbar {
            if editable {
                ToolbarItem(placement: .topBarLeading) { EditButton() }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { adding = true } label: { Label("live.chain.add", systemImage: "plus") }.disabled(session.client.fx.isEmpty)
                    Button { presetName = m.state?.preset ?? ""; saving = true } label: { Label("live.chain.save", systemImage: "square.and.arrow.down") }
                }
            }
        }
        .sheet(isPresented: $adding) { AddInsertSheet() }
        .alert("live.chain.save", isPresented: $saving) {
            TextField("live.chain.preset_name", text: $presetName)
            Button("common.cancel", role: .cancel) {}
            Button("live.chain.save_confirm") {
                let n = presetName.trimmingCharacters(in: .whitespaces)
                if !n.isEmpty { session.client.send(.savePreset(name: n)) }
            }
        }
        .overlay(alignment: .bottom) {
            VStack(spacing: 0) {
                MidiLearnBanner()
                ErrorBanner()
            }
        }
    }

    private func gr(_ m: LiveModel, _ i: Int) -> Float? {
        guard let g = m.meters?.gr, g.indices.contains(i), abs(g[i]) > 0.05 else { return nil }
        return g[i]
    }
}

/// Short display name of an effect id (catalog key `live.fx.<id>`, falls back to the id).
func fxName(_ id: String) -> String {
    let key = "live.fx." + id
    let s = Bundle.main.localizedString(forKey: key, value: id, table: nil)
    return s == key ? id : s
}

struct InsertRow: View {
    @Environment(LiveSession.self) private var session
    let insert: InsertState
    let spec: FxSpec?
    let gr: Float?
    let editable: Bool
    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            ForEach(insert.params, id: \.id) { p in
                if let ps = spec?.param(p.id) {
                    ParamControl(insert: insert.id, fx: insert.fx, spec: ps, value: p.value, editable: editable)
                } else {
                    HStack { Text(verbatim: p.id); Spacer(); Text(verbatim: String(format: "%.2f", p.value)).monospacedDigit() }
                        .font(.subheadline).foregroundStyle(LiveTheme.muted)
                }
            }
        } label: {
            let target = MidiTarget.enable(fx: insert.fx)
            let bound = session.model.state?.midi.source(for: target)
            let learning = session.model.state?.midi.learning == target
            HStack {
                Toggle(isOn: Binding(get: { insert.enabled }, set: { session.client.send(.setEnabled(insert: insert.id, on: $0)) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(verbatim: fxName(insert.fx)).font(.headline)
                            if learning { ProgressView().controlSize(.small) } else if let bound { MidiBadge(source: bound) }
                        }
                        if let gr { Text("live.chain.gr \(String(format: "%.1f", abs(gr)))").font(.caption.monospacedDigit()).foregroundStyle(LiveTheme.warning) }
                    }
                }
                .disabled(!editable)
                .tint(LiveTheme.accent)
            }
            .midiLearnable(target)
        }
    }
}

struct ParamControl: View {
    @Environment(LiveSession.self) private var session
    let insert: UInt32
    let fx: String
    let spec: ParamSpec
    let value: Float
    let editable: Bool
    @State private var local: Float?

    var body: some View {
        let target = MidiTarget.param(fx: fx, param: spec.id)
        let midi = session.model.state?.midi
        VStack(alignment: .leading, spacing: 4) {
            control
            if midi?.learning == target {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("live.midi.waiting_short").font(.caption).foregroundStyle(LiveTheme.accent)
                }
            } else if let s = midi?.source(for: target) {
                MidiBadge(source: s)
            }
        }
        .midiLearnable(target)
    }

    @ViewBuilder private var control: some View {
        let label = paramName(spec.id)
        if spec.isToggle {
            Toggle(label, isOn: Binding(get: { value >= 0.5 }, set: { session.client.send(.setParam(insert: insert, param: spec.id, value: $0 ? 1 : 0)) }))
                .disabled(!editable)
        } else if spec.isChoice {
            Picker(label, selection: Binding(get: { Int(value.rounded()) }, set: { session.client.send(.setParam(insert: insert, param: spec.id, value: Float($0))) })) {
                ForEach(Array(spec.choices.enumerated()), id: \.offset) { i, c in Text(verbatim: c).tag(i) }
            }
            .disabled(!editable)
        } else {
            let shown = local ?? value
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(verbatim: label).font(.subheadline)
                    Spacer()
                    Text(verbatim: spec.format(shown)).font(.subheadline.monospacedDigit()).foregroundStyle(LiveTheme.muted)
                }
                // The slider moves in normalised travel so log parameters (Hz, ms) feel right.
                Slider(value: Binding(get: { Double(spec.norm(value: shown)) }, set: { n in
                    let v = spec.value(norm: Float(n))
                    local = v
                    session.client.send(.setParam(insert: insert, param: spec.id, value: v))
                }), in: 0...1, onEditingChanged: { if !$0 { local = nil } })
                .disabled(!editable)
                .accessibilityLabel(Text(verbatim: label))
                .accessibilityValue(Text(verbatim: spec.format(shown)))
            }
        }
    }
}

/// `threshold_db` → `Threshold db` when there is no catalog entry (`live.param.<id>`).
func paramName(_ id: String) -> String {
    let key = "live.param." + id
    let s = Bundle.main.localizedString(forKey: key, value: key, table: nil)
    if s != key { return s }
    let words = id.split(separator: "_").map(String.init)
    return words.enumerated().map { $0.offset == 0 ? $0.element.capitalized : $0.element }.joined(separator: " ")
}

struct AddInsertSheet: View {
    @Environment(LiveSession.self) private var session
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(session.client.fx) { fx in
                Button {
                    let at = UInt32(session.model.state?.chain.count ?? 0)
                    session.client.send(.addInsert(fx: fx.id, at: at))
                    dismiss()
                } label: {
                    Text(verbatim: fxName(fx.id))
                }
            }
            .navigationTitle(Text("live.chain.add"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("common.cancel") { dismiss() } } }
        }
    }
}
