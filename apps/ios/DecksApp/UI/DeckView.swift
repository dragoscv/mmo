import DecksFFI
import SwiftUI

/// One deck at a layout tier (WP19-34). Full: header (title, BPM, key, time), phase meter, jog, transport, hot
/// cues, loops, beat jump, tempo, key, sync / quantize / slip. Compact: no jog, no key / tempo column. Icon:
/// header + transport + sync only. This is still the Decks 1.4 content: it needs 460×560 (full) and 340×330
/// (compact) pt, more than the 1.5 `PANEL_SPECS` minimums (480×250, 340×190, 220×110), so `LayoutHost` passes the
/// tier `ContentTiers` found room for, not the solver's.
struct DeckView: View {
    let index: Int
    var tier: LayoutTier = .full
    @Environment(DecksStore.self) private var store
    @Environment(LibraryStore.self) private var library
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var editingGrid = false

    private var tint: Color { DecksTheme.deck(index) }
    private var d: DeckSnapshot? { store.deck(index) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            PhaseMeter(beat: d?.beat ?? 0, playing: d?.playing ?? false, tint: tint, reduceMotion: reduceMotion)
                .frame(height: 8)
            switch tier {
            case .full:
                HStack(alignment: .top, spacing: 12) {
                    VStack(spacing: 10) {
                        JogWheel(index: index, tint: tint, reduceMotion: reduceMotion)
                            .frame(width: 150, height: 150)
                        transport
                    }
                    .frame(width: 170)
                    VStack(spacing: 8) {
                        hotCues
                        loops
                        jumps
                        flags
                    }
                    tempo
                }
            case .compact:
                VStack(spacing: 8) {
                    transport
                    hotCues
                    loops
                    flags
                }
            case .icon:
                HStack(spacing: 6) {
                    transport
                    PadButton(title: "deck.sync", active: d?.syncLock == true, tint: tint) { store.syncTap(index) }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 14).fill(DecksTheme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(tint.opacity(0.35), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(index == 0 ? LocalizedStringKey("deck.a") : LocalizedStringKey("deck.b")))
    }

    // MARK: sections

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(index == 0 ? LocalizedStringKey("deck.a") : LocalizedStringKey("deck.b"))
                .font(.system(size: 13, weight: .heavy))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(tint))
                .foregroundStyle(DecksTheme.accentForeground)
            VStack(alignment: .leading, spacing: 2) {
                if store.isLoading(index) {
                    Text("deck.loading").font(.headline).foregroundStyle(DecksTheme.muted)
                } else if let title = d?.title, d?.loaded == true {
                    Text(verbatim: title).font(.headline).foregroundStyle(DecksTheme.foreground).lineLimit(1)
                } else {
                    Text("deck.empty").font(.headline).foregroundStyle(DecksTheme.muted)
                }
                HStack(spacing: 8) {
                    Text(verbatim: DecksFormat.time(d?.playheadSec ?? 0))
                    Text(verbatim: "−" + DecksFormat.time(max(0, (d?.durationSec ?? 0) - (d?.playheadSec ?? 0))))
                }
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(DecksTheme.muted)
            }
            Spacer()
            if let tid = library.loadedTrackIds[index], d?.loaded == true {
                Button { editingGrid = true } label: { Image(systemName: "metronome") }
                    .accessibilityLabel(Text("grid.title"))
                    .sheet(isPresented: $editingGrid) {
                        gridSheet(trackId: tid)
                    }
            }
            VStack(alignment: .trailing, spacing: 2) {
                Text(verbatim: DecksFormat.bpm(d?.effectiveBpm ?? d?.bpm))
                    .font(.system(size: 20, weight: .bold, design: .monospaced))
                    .foregroundStyle(DecksTheme.foreground)
                    .accessibilityLabel(Text("deck.bpm"))
                    .accessibilityValue(Text(verbatim: DecksFormat.bpm(d?.effectiveBpm ?? d?.bpm)))
                Text(verbatim: d?.effectiveKeyCamelot ?? d?.keyCamelot ?? "—")
                    .font(.system(size: 12, weight: .bold))
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(DecksTheme.key(d?.effectiveKeyCamelot ?? d?.keyCamelot)))
                    .foregroundStyle(DecksTheme.accentForeground)
                    .accessibilityLabel(Text("deck.key"))
            }
        }
    }

    private var transport: some View {
        HStack(spacing: 8) {
            MomentaryButton(title: "deck.cue", tint: DecksTheme.warning) { store.cue(index, pressed: $0) }
            PadButton(title: d?.playing == true ? "deck.pause" : "deck.play",
                      systemImage: d?.playing == true ? "pause.fill" : "play.fill",
                      active: d?.playing == true, tint: DecksTheme.success, height: 40) {
                store.togglePlay(index)
            }
        }
    }

    private var hotCues: some View {
        let cues = d?.hotCues ?? []
        return HStack(spacing: 6) {
            ForEach(0..<4, id: \.self) { slot in
                let set = slot < cues.count && cues[slot] != nil
                PadButton(title: hotCueTitle(slot), active: set, tint: DecksTheme.hotCues[slot]) {
                    store.hotCue(index, slot: slot)
                }
                .contextMenu {
                    Button(role: .destructive) { store.deleteHotCue(index, slot: slot) } label: {
                        Label("deck.hotcue.delete", systemImage: "trash")
                    }
                }
            }
        }
    }

    private func hotCueTitle(_ slot: Int) -> LocalizedStringKey {
        let keys: [LocalizedStringKey] = ["deck.hotcue.1", "deck.hotcue.2", "deck.hotcue.3", "deck.hotcue.4"]
        return keys[slot]
    }

    /// The beatgrid editor as a sheet. It brings its own navigation bar with a Done button, so the
    /// sheet can always be closed — macOS sheets have no swipe-to-dismiss.
    @ViewBuilder private func gridSheet(trackId: String) -> some View {
        let editor = GridEditorView(
            library: library.library, engine: store.engine, deck: index, trackId: trackId,
            playheadSec: d?.playheadSec ?? 0, fallbackBpm: d?.bpm ?? 120
        )
        #if os(macOS)
        editor.frame(minWidth: 460, minHeight: 520)
        #else
        editor
        #endif
    }

    private var loops: some View {
        HStack(spacing: 6) {
            PadButton(title: "deck.loop.halve", systemImage: "divide", width: 40) { store.loopHalve(index) }
                .accessibilityLabel(Text("deck.loop.halve"))
            PadButton(title: "deck.loop", active: d?.loopActive == true, tint: tint) { store.loopToggleAuto(index) }
                .overlay(alignment: .bottomTrailing) {
                    Text(verbatim: beatsLabel(store.loopBeats[index]))
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundStyle(DecksTheme.muted).padding(3)
                        .accessibilityHidden(true)
                }
                .accessibilityValue(Text(verbatim: beatsLabel(store.loopBeats[index])))
            PadButton(title: "deck.loop.double", systemImage: "multiply", width: 40) { store.loopDouble(index) }
                .accessibilityLabel(Text("deck.loop.double"))
        }
    }

    private var jumps: some View {
        HStack(spacing: 6) {
            PadButton(title: "deck.jump.back", systemImage: "backward.end.fill", width: 40) { store.beatJump(index, forward: false) }
                .accessibilityLabel(Text("deck.jump.back"))
            Menu {
                ForEach([1.0, 2, 4, 8, 16, 32], id: \.self) { b in
                    Button { store.jumpBeats[index] = b } label: { Text(verbatim: beatsLabel(b)) }
                }
            } label: {
                Text(verbatim: beatsLabel(store.jumpBeats[index]))
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .frame(maxWidth: .infinity, minHeight: 36)
                    .background(RoundedRectangle(cornerRadius: 8).fill(DecksTheme.raised))
                    .foregroundStyle(DecksTheme.foreground)
            }
            .accessibilityLabel(Text("deck.jump.size"))
            PadButton(title: "deck.jump.forward", systemImage: "forward.end.fill", width: 40) { store.beatJump(index, forward: true) }
                .accessibilityLabel(Text("deck.jump.forward"))
        }
    }

    private var flags: some View {
        HStack(spacing: 6) {
            PadButton(title: "deck.sync", tint: tint) { store.syncTap(index) }
                .onLongPressGesture { store.toggleSyncLock(index) }
            PadButton(title: "deck.sync.lock", active: d?.syncLock == true, tint: tint) { store.toggleSyncLock(index) }
            PadButton(title: "deck.quantize", active: d?.quantize == true, tint: DecksTheme.info) { store.toggleQuantize(index) }
            PadButton(title: "deck.slip", active: d?.slip == true, tint: DecksTheme.info) { store.toggleSlip(index) }
        }
    }

    private var tempo: some View {
        VStack(spacing: 6) {
            Text(verbatim: DecksFormat.percent(d?.tempo ?? 1))
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(DecksTheme.foreground)
            Fader(label: "deck.tempo",
                  value: Binding(get: { (store.tempoFader(index) + 1) / 2 }, set: { _ in }),
                  tint: tint, length: 110) { store.setTempoFader(index, $0 * 2 - 1) }
            PadButton(title: "deck.keylock", active: d?.keyLock == true, tint: tint, width: 56, height: 28) { store.toggleKeyLock(index) }
            HStack(spacing: 4) {
                PadButton(title: "deck.key.down", systemImage: "minus", width: 26, height: 26) { store.shiftKey(index, by: -1) }
                    .accessibilityLabel(Text("deck.key.down"))
                PadButton(title: "deck.key.up", systemImage: "plus", width: 26, height: 26) { store.shiftKey(index, by: 1) }
                    .accessibilityLabel(Text("deck.key.up"))
            }
            Text(verbatim: String(format: "%+.0f st", d?.keyShiftSemitones ?? 0))
                .font(.system(size: 10, design: .monospaced)).foregroundStyle(DecksTheme.muted)
            PadButton(title: "deck.key.match", width: 56, height: 26) { store.keyMatch(index) }
                .contextMenu { Button("deck.key.reset") { store.resetKey(index) } }
        }
        .frame(width: 64)
    }

    private func beatsLabel(_ b: Double) -> String {
        b < 1 ? "1/\(Int((1 / b).rounded()))" : "\(Int(b))"
    }
}

/// 4-beat phase meter: the current beat of the bar lights; animated only when Reduce Motion is off.
struct PhaseMeter: View {
    let beat: Double
    let playing: Bool
    let tint: Color
    let reduceMotion: Bool

    var body: some View {
        let current = Int(floor(beat)).quotient4
        let frac = beat - floor(beat)
        HStack(spacing: 3) {
            ForEach(0..<4, id: \.self) { i in
                RoundedRectangle(cornerRadius: 2)
                    .fill(i == current ? tint : DecksTheme.raised)
                    .opacity(i == current && playing && !reduceMotion ? 1 - frac * 0.6 : 1)
            }
        }
        .animation(reduceMotion ? nil : .linear(duration: 0.05), value: current)
        .accessibilityElement()
        .accessibilityLabel(Text("deck.phase"))
        .accessibilityValue(Text(verbatim: "\(current + 1) / 4"))
    }
}

private extension Int {
    var quotient4: Int { ((self % 4) + 4) % 4 }
}

/// Jog wheel: drag around to scrub (paused) or bend (playing). The platter rotates with the playhead
/// (33⅓ rpm); with Reduce Motion the rotation is replaced by a static position marker.
struct JogWheel: View {
    let index: Int
    let tint: Color
    let reduceMotion: Bool
    @Environment(DecksStore.self) private var store
    @State private var lastAngle: Double?

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: reduceMotion || store.deck(index)?.playing != true)) { _ in
            let pos = store.deck(index)?.playheadSec ?? 0
            let angle = reduceMotion ? 0 : (pos * 33.333 / 60).truncatingRemainder(dividingBy: 1) * 360
            GeometryReader { g in
                let r = min(g.size.width, g.size.height) / 2
                ZStack {
                    Circle().fill(DecksTheme.raised)
                    Circle().stroke(tint.opacity(0.6), lineWidth: 3)
                    Circle().stroke(DecksTheme.border, lineWidth: 1).padding(r * 0.28)
                    Capsule().fill(tint).frame(width: 4, height: r * 0.35)
                        .offset(y: -r * 0.72)
                        .rotationEffect(.degrees(angle))
                    if let d = store.deck(index), d.durationSec > 0 {
                        Circle().trim(from: 0, to: min(1, d.playheadSec / d.durationSec))
                            .stroke(tint.opacity(0.35), style: StrokeStyle(lineWidth: 2))
                            .rotationEffect(.degrees(-90))
                            .padding(6)
                    }
                }
                .contentShape(Circle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { v in
                            let c = CGPoint(x: g.size.width / 2, y: g.size.height / 2)
                            let a = Double(atan2(v.location.y - c.y, v.location.x - c.x)) * 180 / .pi
                            if let l = lastAngle {
                                var delta = a - l
                                if delta > 180 { delta -= 360 }
                                if delta < -180 { delta += 360 }
                                store.jog(index, delta: delta, touching: true)
                            }
                            lastAngle = a
                        }
                        .onEnded { _ in
                            lastAngle = nil
                            store.jog(index, delta: 0, touching: false)
                        }
                )
            }
        }
        .accessibilityElement()
        .accessibilityLabel(Text("deck.jog"))
        .accessibilityHint(Text("deck.jog.hint"))
        .accessibilityAdjustableAction { dir in
            store.beatJump(index, forward: dir == .increment)
        }
    }
}
