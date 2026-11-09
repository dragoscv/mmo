import SwiftUI
import WatchKit

/// Two vertical pages: Live (bezel key ring, key, BPM, tap tempo) → Controls (listen / haptics / clear tap).
struct WatchRoot: View {
    @Environment(WatchListen.self) private var m
    @State private var page = 0

    var body: some View {
        TabView(selection: $page) {
            WatchLive().tag(0)
            WatchControls().tag(1)
        }
        .tabViewStyle(.verticalPage)
        .background(Tokens.Dark.background)
        .onChange(of: m.shotPage) { _, p in page = p }
    }
}

private func ringColor(_ n: Int, minor: Bool) -> Color { minor ? Tokens.Key.minor[n - 1] : Tokens.Key.major[n - 1] }

struct WatchLive: View {
    @Environment(WatchListen.self) private var m
    @Environment(\.isLuminanceReduced) private var ambient

    var body: some View {
        ZStack {
            if !ambient {
                TimelineView(.animation(minimumInterval: 1 / 30, paused: !m.active && m.tapBpm == nil)) { _ in
                    Canvas { g, size in ring(g, size, pulse: m.clock.pulse(now: ProcessInfo.processInfo.systemUptime)) }
                }
                .ignoresSafeArea()
            }
            VStack(spacing: 2) {
                Text(m.keyIndex.map(Harmony.camelot) ?? "\u{2014}").font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundStyle(m.keyLocked || ambient ? .white : .secondary)
                Text(m.keyIndex.map(Harmony.keyName) ?? "\u{2014}").font(.footnote).foregroundStyle(.secondary)
                Text(m.shownBpm.map { String(format: "%.1f", $0) } ?? "\u{2014}").font(.system(size: 26, weight: .semibold, design: .rounded))
                    .monospacedDigit().foregroundStyle(m.tapBpm != nil ? Tokens.Brand.cyanDark : .white)
                Text(status).font(.caption2).foregroundStyle(.secondary)
                if m.source == .phone, let t = m.title { Text(t).font(.caption2).lineLimit(1) }
                if let k = m.keyChange {
                    Text("kb.watch.key_changed \(Harmony.camelot(k))").font(.caption2).foregroundStyle(Tokens.Dark.warning)
                        .onTapGesture { m.dismissKeyChange() }
                }
                if m.micFailed { Text("kb.watch.mic_failed").font(.caption2).foregroundStyle(Tokens.Dark.destructive) }
                if !m.active, !ambient {
                    Button("kb.listen") { Task { await m.startWatch() } }.buttonStyle(.borderedProminent).controlSize(.small)
                }
            }
        }
        .contentShape(.rect)
        .onTapGesture { m.tap() }
        .handGestureShortcut(.primaryAction)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("kb.watch.cd_live \(m.keyIndex.map(Harmony.keyName) ?? "\u{2014}") \(m.shownBpm.map { String(format: "%.0f", $0) } ?? "\u{2014}")"))
        .accessibilityAction(named: Text("kb.watch.tap_tempo")) { m.tap() }
    }

    private var status: LocalizedStringKey {
        if m.tapBpm != nil { return "kb.watch.bpm_tapped" }
        if m.source == .phone { return "kb.watch.from_phone" }
        if m.source == .watch { return m.levelLow ? LocalizedStringKey("kb.watch.level_low") : LocalizedStringKey("kb.bpm") }
        return "kb.watch.tap_hint"
    }

    private func ring(_ g: GraphicsContext, _ size: CGSize, pulse: Double) {
        let r = min(size.width, size.height) / 2 - 6
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        let minor = m.keyIndex.map(Harmony.isMinor) ?? true
        for n in 1...12 {
            let k = (0..<24).first { Harmony.camelotNumber($0) == n && Harmony.isMinor($0) == minor }!
            let on = k == m.keyIndex
            let alpha = on ? 1 : (m.keyIndex.map { Harmony.wheelDistance($0, k) <= 1 } == true ? 0.6 : (m.keyIndex == nil ? 0.35 : 0.15))
            let mid = Angle.degrees(Double(n) * 30 - 90)
            var p = Path()
            p.addArc(center: c, radius: r, startAngle: mid - .degrees(13), endAngle: mid + .degrees(13), clockwise: false)
            g.stroke(p, with: .color(ringColor(n, minor: minor).opacity(alpha)), lineWidth: on ? 7 * (1.4 + 0.5 * pulse) : 7)
        }
        let d = r * 0.12
        g.fill(Path(ellipseIn: CGRect(x: c.x - d, y: c.y + r * 0.72 - d, width: d * 2, height: d * 2)), with: .color(.white.opacity(0.06 + 0.25 * pulse)))
    }
}

struct WatchControls: View {
    @Environment(WatchListen.self) private var m

    var body: some View {
        @Bindable var m = m
        List {
            Text("kb.watch.app_short").font(.headline)
            if m.source == .watch {
                Button("kb.stop", role: .destructive) { m.stopWatch() }
            } else {
                Button("kb.watch.listen_watch") { Task { await m.startWatch() } }
            }
            Toggle(isOn: $m.haptics) {
                VStack(alignment: .leading) { Text("kb.watch.haptic"); Text("kb.watch.haptic_hint").font(.caption2).foregroundStyle(.secondary) }
            }
            if m.tapBpm != nil { Button("kb.watch.tap_clear") { m.clearTap() } }
            Text(m.phoneListening ? LocalizedStringKey("kb.watch.phone_listening") : LocalizedStringKey("kb.watch.phone_hint")).font(.caption2).foregroundStyle(.secondary)
        }
    }
}
