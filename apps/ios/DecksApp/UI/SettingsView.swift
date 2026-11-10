import DecksFFI
import SwiftUI

/// Audio, tempo range, MIDI devices (+ Bluetooth MIDI on iOS) and library folders.
struct SettingsView: View {
    @Environment(DecksStore.self) private var store
    @Environment(LibraryStore.self) private var library
    @Environment(MidiManager.self) private var midi
    @Environment(\.dismiss) private var dismiss
    @State private var bluetooth = false
    @State private var importing = false

    var body: some View {
        @Bindable var store = store
        Form {
            Section {
                LabeledContent("settings.engine") {
                    Text(store.running ? LocalizedStringKey("status.engine_on") : LocalizedStringKey("status.engine_off"))
                }
                if let info = store.startInfo {
                    LabeledContent("settings.sample_rate") { Text(verbatim: "\(info.sampleRate) Hz") }
                    LabeledContent("settings.latency") { Text(verbatim: String(format: "%.1f ms", info.latencyMs)) }
                    ForEach(info.notes, id: \.self) { n in Text(verbatim: n).font(.caption).foregroundStyle(DecksTheme.muted) }
                }
                if let route = AudioSessionConfig.routeSummary() {
                    LabeledContent("settings.route") { Text(verbatim: route) }
                }
                if let r = store.rendererFailure {
                    LabeledContent("settings.renderer") { Text(verbatim: r).foregroundStyle(DecksTheme.warning) }
                }
            } header: {
                Text("settings.audio")
            }
            Section {
                Picker("settings.tempo_range", selection: $store.tempoRange) {
                    ForEach(DecksStore.tempoRanges, id: \.self) { r in
                        Text(verbatim: "±\(Int((r * 100).rounded())) %").tag(r)
                    }
                }
            } header: {
                Text("settings.decks")
            }
            Section {
                if !midi.available {
                    Text("settings.midi.unavailable").foregroundStyle(DecksTheme.warning)
                } else if midi.devices.isEmpty {
                    Text("settings.midi.none").foregroundStyle(DecksTheme.muted)
                }
                ForEach(midi.devices) { d in
                    LabeledContent { Text(verbatim: d.profile).foregroundStyle(DecksTheme.muted) } label: { Text(verbatim: d.name) }
                }
                if let m = midi.lastMessage {
                    LabeledContent("settings.midi.last") { Text(verbatim: m).font(.caption.monospaced()) }
                }
                Button("settings.midi.rescan") { midi.rescan() }
                #if os(iOS)
                Button("settings.midi.bluetooth") { bluetooth = true }
                #endif
            } header: {
                Text("settings.midi")
            }
            Section {
                if library.folders.isEmpty {
                    Text("settings.folders.none").foregroundStyle(DecksTheme.muted)
                }
                ForEach(library.folders, id: \.self) { u in
                    Text(verbatim: u.path).font(.caption).lineLimit(1).truncationMode(.middle)
                }
            } header: {
                Text("settings.folders")
            }
            Section {
                Button("import.title") { importing = true }
                    .disabled(library.library == nil)
            }
            AppearanceSettingsSection()
            SafetyView(library: library.library) { library.refresh() }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $importing) {
            NavigationStack {
                ImportView(library: library.library) { library.refresh() }
            }
        }
        .navigationTitle(Text("settings.title"))
        #if os(iOS)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("common.done") { dismiss() } }
        }
        .sheet(isPresented: $bluetooth) { BluetoothMidiPicker().ignoresSafeArea() }
        #endif
    }
}
