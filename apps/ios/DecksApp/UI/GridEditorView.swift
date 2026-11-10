import DecksFFI
import SwiftUI

/// Flexible beatgrid editor (WP19-37): fixed-grid toggle, tempo-marker list, add at the playhead,
/// nudge / retune / delete. Every change is written to the library (`grid*` FFI functions) and handed
/// to the loaded deck (`gridApplyToDeck`).
///
/// UNVERIFIED: Swift cannot be built on the Windows workstation; names follow the UniFFI Swift
/// bindings of `crates/decks-ffi/src/grid.rs` (camelCase functions with argument labels,
/// `GridState` / `GridMarker` records, `UInt8` / `UInt32` for `u8` / `u32`).
struct GridEditorView: View {
    let library: DecksLibrary?
    let engine: DecksEngine?
    let deck: Int
    let trackId: String
    /// Where "add marker" puts the new tempo change.
    let playheadSec: Double
    var fallbackBpm: Double = 120
    var fallbackFirstBeatSec: Double = 0

    @Environment(\.dismiss) private var dismiss
    @State private var grid: GridState?
    @State private var error: String?

    static let nudgeSec = 0.005
    static let bpmStep = 0.1

    var body: some View {
        NavigationStack {
            editor
                .navigationTitle(Text("grid.title"))
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("common.done") { dismiss() }
                            .accessibilityLabel(Text("grid.close"))
                    }
                }
        }
    }

    private var editor: some View {
        Form {
            Section {
                Toggle(isOn: Binding(get: { current.fixed }, set: { setFixed($0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("grid.fixed")
                        Text(current.fixed ? LocalizedStringKey("grid.fixedHint") : LocalizedStringKey("grid.flexHint"))
                            .font(.caption)
                            .foregroundStyle(DecksTheme.muted)
                    }
                }
                Text(verbatim: "\(Self.bpm(GridMath.bpmAt(current, playheadSec))) BPM")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(DecksTheme.muted)
            } header: {
                Text("grid.title")
            }
            Section {
                if current.markers.isEmpty {
                    Text("grid.markerEmpty").foregroundStyle(DecksTheme.muted)
                }
                ForEach(Array(current.markers.enumerated()), id: \.offset) { i, m in
                    HStack(spacing: 8) {
                        Text(verbatim: "\(Self.time(m.sec)) · \(Self.bpm(m.bpm)) BPM")
                            .font(.body.monospacedDigit())
                        Spacer()
                        Button { nudge(i, -Self.nudgeSec) } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel(Text("grid.markerEarlier"))
                        Button { nudge(i, Self.nudgeSec) } label: { Image(systemName: "chevron.right") }
                            .accessibilityLabel(Text("grid.markerLater"))
                        Button { retune(i, -Self.bpmStep) } label: { Image(systemName: "minus") }
                            .accessibilityLabel(Text("grid.tempoDown"))
                        Button { retune(i, Self.bpmStep) } label: { Image(systemName: "plus") }
                            .accessibilityLabel(Text("grid.tempoUp"))
                        Button(role: .destructive) { remove(i) } label: { Image(systemName: "trash") }
                            .accessibilityLabel(Text("grid.markerRemove"))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityElement(children: .contain)
                }
                .onDelete { idx in idx.forEach(remove) }
                Button { addAtPlayhead() } label: { Label("grid.markerAdd", systemImage: "plus.circle") }
            } header: {
                Text("grid.markers")
            }
            if let error {
                Text(verbatim: error).font(.caption).foregroundStyle(DecksTheme.danger)
            }
        }
        .onAppear(perform: load)
    }

    // MARK: - state

    private var current: GridState {
        grid ?? GridState(
            trackId: trackId,
            bpm: fallbackBpm,
            firstBeatSec: fallbackFirstBeatSec,
            downbeatOffset: 0,
            fixed: false,
            markers: []
        )
    }

    private func load() {
        guard let library else { return }
        grid = try? trackGrid(library: library, trackId: trackId)
    }

    private func commit(_ f: (DecksLibrary) throws -> GridState) {
        guard let library else { return }
        do {
            let next = try f(library)
            grid = next
            error = nil
            if let engine { try? gridApplyToDeck(engine: engine, deck: UInt8(deck), grid: next) }
            // Let the waveform overlay re-read the grid of a track that is already loaded.
            GridRevision.shared.bump()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func setFixed(_ on: Bool) {
        commit { try gridSetFixed(library: $0, trackId: trackId, fixed: on) }
    }

    /// New marker on the nearest beat, one step above the running tempo (a marker at the same
    /// tempo is not a change and would be merged away).
    private func addAtPlayhead() {
        let g = current
        let sec = GridMath.timeAt(g, (GridMath.beatAt(g, playheadSec)).rounded())
        let bpm = min(400, GridMath.bpmAt(g, playheadSec) + Self.bpmStep)
        commit { try gridAddMarker(library: $0, trackId: trackId, sec: sec, bpm: bpm) }
    }

    private func nudge(_ i: Int, _ delta: Double) {
        guard current.markers.indices.contains(i) else { return }
        let m = current.markers[i]
        commit {
            try gridMoveMarker(library: $0, trackId: trackId, atSec: m.sec, newSec: max(0, m.sec + delta), newBpm: nil, toleranceSec: 0.25)
        }
    }

    private func retune(_ i: Int, _ delta: Double) {
        guard current.markers.indices.contains(i) else { return }
        let m = current.markers[i]
        let bpm = min(400, max(20, m.bpm + delta))
        commit {
            try gridMoveMarker(library: $0, trackId: trackId, atSec: m.sec, newSec: m.sec, newBpm: bpm, toleranceSec: 0.25)
        }
    }

    private func remove(_ i: Int) {
        guard current.markers.indices.contains(i) else { return }
        let m = current.markers[i]
        commit { try gridRemoveMarker(library: $0, trackId: trackId, atSec: m.sec, toleranceSec: 0.25) }
    }

    // MARK: - formatting (locale-free, matches Kotlin / TS)

    static func time(_ sec: Double) -> String {
        let s = sec.isFinite ? max(0, sec) : 0
        let m = Int(s / 60)
        let rest = s - Double(m * 60)
        return String(format: "%d:%05.2f", m, rest)
    }

    static func bpm(_ v: Double) -> String { String(format: "%.2f", v) }
}

/// Grid maths shared by the editor and the waveform overlay (same rules as Rust
/// `mixai_core::beatgrid` and `src/grid/markers.ts`).
enum GridMath {
    static func bpmAt(_ g: GridState, _ sec: Double) -> Double {
        if g.fixed { return g.bpm }
        var cur = g.bpm
        for m in g.markers {
            if m.sec > sec { break }
            cur = m.bpm
        }
        return cur
    }

    static func beatAt(_ g: GridState, _ sec: Double) -> Double {
        if g.fixed || g.markers.isEmpty { return (sec - g.firstBeatSec) * g.bpm / 60 }
        var t = g.firstBeatSec, beat = 0.0, cur = g.bpm
        for m in g.markers {
            if m.sec >= sec { break }
            beat += (m.sec - t) * cur / 60
            t = m.sec
            cur = m.bpm
        }
        return beat + (sec - t) * cur / 60
    }

    static func timeAt(_ g: GridState, _ beat: Double) -> Double {
        if g.fixed || g.markers.isEmpty { return g.firstBeatSec + beat * 60 / g.bpm }
        var t = g.firstBeatSec, b = 0.0, cur = g.bpm
        for m in g.markers {
            let next = b + (m.sec - t) * cur / 60
            if next >= beat { break }
            b = next
            t = m.sec
            cur = m.bpm
        }
        return t + (beat - b) * 60 / cur
    }

    /// Beat times in `[from, to]` with a downbeat flag; at most `limit` lines.
    static func beatLines(_ g: GridState, from: Double, to: Double, beatsPerBar: Int = 4, limit: Int = 4096) -> [(sec: Double, downbeat: Bool)] {
        guard g.bpm > 0, to > from else { return [] }
        let bar = max(1, beatsPerBar)
        var out: [(sec: Double, downbeat: Bool)] = []
        var k = Int((beatAt(g, from) - 1e-9).rounded(.up))
        while out.count < limit {
            let t = timeAt(g, Double(k))
            if t > to { break }
            if t >= from { out.append((t, ((k % bar) + bar) % bar == 0)) }
            k += 1
        }
        return out
    }
}
