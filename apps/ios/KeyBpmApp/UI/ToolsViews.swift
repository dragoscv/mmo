import CoreAudioKit
import MixaiCore
import MixaiUI
import SwiftUI

/// Tuner tab: note, cents needle, A4 reference 415…466 Hz.
struct TunerView: View {
    @Environment(ListenSession.self) private var s

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            let r = s.reading
            let inTune = abs(r?.pitchCents ?? 99) < 5 && r?.pitchNote != nil
            Text(r?.pitchNote ?? "\u{2014}").font(Theme.heading(72)).foregroundStyle(inTune ? KB.success : KB.primary)
            Text(r?.pitchNote == nil ? String(localized: "kb.tuner.hint") : String(format: "%+d \u{00A2} \u{00B7} %.1f Hz", Int((r?.pitchCents ?? 0).rounded()), r?.pitchHz ?? 0))
                .font(Theme.body(16)).foregroundStyle(KB.muted)
            Needle(cents: r?.pitchNote == nil ? 0 : (r?.pitchCents ?? 0)).frame(height: 90).padding(.horizontal, 24)
            HStack(spacing: 20) {
                Button { s.setA4(s.a4 - 1) } label: { Image(systemName: "minus") }.buttonStyle(.glass).accessibilityLabel(Text("kb.tuner.lower"))
                Text("kb.tuner.reference \(Int(s.a4))").monospacedDigit()
                Button { s.setA4(s.a4 + 1) } label: { Image(systemName: "plus") }.buttonStyle(.glass).accessibilityLabel(Text("kb.tuner.higher"))
            }
            Spacer()
            Button(s.listening ? LocalizedStringKey("kb.stop") : LocalizedStringKey("kb.listen")) { Task { s.listening ? s.stop() : await s.start() } }
                .buttonStyle(.glassProminent).controlSize(.large)
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(KB.bg)
    }
}

private struct Needle: View {
    let cents: Double
    var body: some View {
        Canvas { g, size in
            let mid = size.width / 2
            for c in stride(from: -50, through: 50, by: 10) {
                let x = mid + CGFloat(c) / 50 * (size.width / 2 - 8)
                let h = c == 0 ? size.height : size.height * 0.35
                var p = Path(); p.move(to: CGPoint(x: x, y: (size.height - h) / 2)); p.addLine(to: CGPoint(x: x, y: (size.height + h) / 2))
                g.stroke(p, with: .color(.white.opacity(c == 0 ? 0.9 : 0.35)), lineWidth: c == 0 ? 4 : 2)
            }
            let x = mid + CGFloat(min(50, max(-50, cents))) / 50 * (size.width / 2 - 8)
            var n = Path(); n.move(to: CGPoint(x: x, y: 4)); n.addLine(to: CGPoint(x: x, y: size.height - 4))
            g.stroke(n, with: .color(KB.primary), style: StrokeStyle(lineWidth: 10, lineCap: .round))
        }
        .animation(.easeOut(duration: 0.12), value: cents)
        .accessibilityHidden(true)
    }
}

/// Tempo tab: clock BPM (follow / ±0.1 / tap), 4-dot metronome, click, MIDI clock out, drift alarm.
struct TempoView: View {
    @Environment(ListenSession.self) private var s
    @State private var clock = MidiClock.shared
    @State private var follow = true
    @State private var taps: [TimeInterval] = []
    @State private var bleSheet = false

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Text("kb.tempo.title").font(Theme.heading(22)).frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 18) {
                    Button("-0.1") { follow = false; clock.bpm -= 0.1 }.buttonStyle(.glass)
                    VStack {
                        Text(String(format: "%.1f", clock.bpm)).font(Theme.heading(56)).monospacedDigit()
                        Text("kb.bpm").foregroundStyle(KB.muted)
                    }
                    Button("+0.1") { follow = false; clock.bpm += 0.1 }.buttonStyle(.glass)
                }
                HStack(spacing: 12) {
                    ForEach(0..<4, id: \.self) { i in
                        Circle().fill(clock.running && clock.beat % 4 == i ? KB.primary : KB.muted.opacity(0.3)).frame(width: 18, height: 18)
                    }
                }
                .accessibilityElement().accessibilityLabel(Text("kb.cd.beat"))
                Toggle("kb.tempo.follow", isOn: $follow).disabled(s.bpm == nil)
                Button { tap() } label: { Text("kb.tempo.tap").frame(maxWidth: .infinity).padding(.vertical, 18) }
                    .buttonStyle(.glassProminent)
                Toggle("kb.tempo.click", isOn: $clock.click)
                Card {
                    Text("kb.tempo.midi_out").font(Theme.body(16, weight: .semibold))
                    if clock.destinations.isEmpty { Text("kb.tempo.no_devices").font(Theme.body(13)).foregroundStyle(KB.muted) }
                    ForEach(clock.destinations, id: \.self) { Text($0).font(Theme.body(14)) }
                    Text("kb.tempo.virtual").font(Theme.body(12)).foregroundStyle(KB.muted)
                    HStack {
                        Button("kb.tempo.bluetooth") { bleSheet = true }.buttonStyle(.glass)
                        Button("kb.tempo.refresh") { clock.refresh() }.buttonStyle(.glass)
                    }
                    .controlSize(.small)
                }
                Button(clock.running ? LocalizedStringKey("kb.tempo.stop") : LocalizedStringKey("kb.tempo.start")) { clock.running ? clock.stop() : clock.start() }
                    .buttonStyle(.glassProminent).controlSize(.large)
                Text("kb.tempo.hint").font(Theme.body(12)).foregroundStyle(KB.muted)
                driftCard
            }
            .padding()
        }
        .background(KB.bg)
        .onChange(of: s.bpm) { _, b in if follow, let b { clock.bpm = (b * 10).rounded() / 10 } }
        .sheet(isPresented: $bleSheet, onDismiss: { clock.refresh() }) { BluetoothMidiSheet() }
    }

    private var driftCard: some View {
        Card {
            Toggle(isOn: Binding(get: { s.prefs.driftAlarm }, set: { s.setDriftAlarm($0) })) {
                VStack(alignment: .leading) {
                    Text("kb.drift.title")
                    Text("kb.drift.hint").font(Theme.body(12)).foregroundStyle(KB.muted)
                }
            }
            if s.prefs.driftAlarm {
                HStack {
                    Text(s.driftReference.map { String(localized: "kb.drift.reference \(String(format: "%.1f", $0))") } ?? "\u{2014}")
                    Spacer()
                    Button("kb.drift.set_ref") { s.useCurrentBpmAsReference() }.buttonStyle(.glass).disabled(s.bpm == nil)
                }
                if let d = s.drift {
                    Text("kb.drift.alert \(String(format: "%+.1f", d))").foregroundStyle(KB.warning).font(Theme.body(15, weight: .semibold))
                }
            }
        }
    }

    private func tap() {
        follow = false
        taps.append(ProcessInfo.processInfo.systemUptime)
        taps = Array(taps.suffix(16))
        if let b = Harmony.tapBpm(taps) { clock.bpm = (b * 10).rounded() / 10 }
    }
}

/// Apple's Bluetooth LE MIDI picker (CABTMIDICentralViewController).
struct BluetoothMidiSheet: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UINavigationController { UINavigationController(rootViewController: CABTMIDICentralViewController()) }
    func updateUIViewController(_ vc: UINavigationController, context: Context) {}
}

/// Full-screen stage / booth display: black (or red night mode), huge key + BPM, set timer, key-change band 8 s.
struct StageView: View {
    @Environment(ListenSession.self) private var s
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let night = s.prefs.stageNight
        let ink: Color = night ? Color(red: 0.69, green: 0, blue: 0) : .white
        GeometryReader { geo in
            let landscape = geo.size.width > geo.size.height
            let size = landscape ? geo.size.height * 0.42 : geo.size.width * 0.30
            ZStack {
                (s.keyChange != nil ? KB.warning.opacity(0.25) : Color.black).ignoresSafeArea()
                    .animation(.easeInOut(duration: 0.3), value: s.keyChange)
                VStack {
                    HStack {
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            Text(s.startedAt.map { String(localized: "kb.stage.timer \(Self.elapsed(ctx.date.timeIntervalSince($0)))") } ?? String(localized: "kb.stage.idle"))
                        }
                        .foregroundStyle(ink.opacity(0.7))
                        Spacer()
                        Button { s.prefs.stageNight.toggle() } label: { Image(systemName: night ? "moon.fill" : "moon") }
                            .accessibilityLabel(Text("kb.stage.night"))
                        Button("kb.stage.exit") { dismiss() }
                    }
                    .font(Theme.body(16)).tint(ink).padding()
                    if let k = s.keyChange {
                        Text("kb.key_changed \(Harmony.camelot(k))").font(Theme.heading(28)).foregroundStyle(night ? ink : KB.warning)
                            .task(id: k) { try? await Task.sleep(for: .seconds(8)); s.dismissKeyChange() }
                    }
                    Spacer()
                    let layout = landscape ? AnyLayout(HStackLayout(spacing: 40)) : AnyLayout(VStackLayout(spacing: 24))
                    layout {
                        value("kb.key", s.reading?.keyIndex.map { s.notation.label($0) } ?? "\u{2014}", locked: s.reading?.keyLocked ?? false, size: size, ink: ink)
                        value("kb.bpm", KB.bpm(s.bpm), locked: s.reading?.tempoLocked ?? false, size: size, ink: ink)
                    }
                    Spacer()
                }
            }
            .contentShape(.rect)
            .onTapGesture { if s.bpm != nil { s.cycleTempo() } }
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = s.listening }
    }

    private func value(_ label: LocalizedStringKey, _ v: String, locked: Bool, size: CGFloat, ink: Color) -> some View {
        VStack(spacing: 4) {
            Text(label).font(Theme.body(18)).foregroundStyle(ink.opacity(0.6))
            Text(v).font(.system(size: size, weight: .black, design: .rounded)).foregroundStyle(ink.opacity(locked ? 1 : 0.55))
                .lineLimit(1).minimumScaleFactor(0.3).monospacedDigit()
        }
        .accessibilityElement(children: .combine)
    }

    static func elapsed(_ t: TimeInterval) -> String {
        let s = Int(t), h = s / 3600
        return h > 0 ? String(format: "%d:%02d:%02d", h, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }
}
