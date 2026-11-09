import MixaiCore
import MixaiUI
import SwiftUI

/// Key & BPM look on top of the shared MixAI theme (generated tokens only: hex gate).
enum KB {
    static let bg = Theme.background
    static let fg = Theme.foreground
    static let muted = Theme.mutedForeground
    static let primary = Theme.primary
    static let warning = Tokens.Dark.warning
    static let success = Theme.success
    static let error = Theme.destructive
    static let accent2 = Tokens.Brand.cyanDark

    static func keyColor(_ key: Int) -> Color {
        let n = Harmony.camelotNumber(key) - 1
        return Harmony.isMinor(key) ? Tokens.Key.minor[n] : Tokens.Key.major[n]
    }

    static func bpm(_ v: Double?) -> String { v.map { String(format: "%.1f", $0) } ?? "\u{2014}" }
}

/// Camelot wheel (outer ring = B / major, inner = A / minor, 12 at the top). The detected key is full colour and
/// thicker, compatible keys 0.9, the rest 0.18. The beat pulse is drawn in a TimelineView canvas so it never
/// re-renders the screen around it (the Android jank lesson).
struct CamelotWheel: View {
    let keyIndex: Int?
    var pulse: (TimeInterval) -> Double = { _ in 0 }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let compatible = Set(keyIndex.map { Harmony.compatibleKeys($0).map(\.key) } ?? [])
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || keyIndex == nil)) { ctx in
            Canvas { g, size in
                draw(g, size: size, compatible: compatible, pulse: reduceMotion ? 0 : pulse(ProcessInfo.processInfo.systemUptime))
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement()
        .accessibilityLabel(Text("kb.cd.wheel \(keyIndex.map(Harmony.camelot) ?? "\u{2014}")"))
    }

    private func draw(_ g: GraphicsContext, size: CGSize, compatible: Set<Int>, pulse: Double) {
        let r = min(size.width, size.height) / 2
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        let w = r * 0.3
        for minor in [false, true] {
            let outer = minor ? r * 0.68 : r
            let radius = outer - w / 2
            for n in 1...12 {
                let k = (0..<24).first { Harmony.camelotNumber($0) == n && Harmony.isMinor($0) == minor }!
                let on = k == keyIndex
                let alpha = on ? 1 : (compatible.contains(k) ? 0.9 : (keyIndex == nil ? 0.55 : 0.18))
                let mid = Angle.degrees(Double(n) * 30 - 90)
                var p = Path()
                p.addArc(center: c, radius: radius, startAngle: mid - .degrees(13.5), endAngle: mid + .degrees(13.5), clockwise: false)
                g.stroke(p, with: .color(KB.keyColor(k).opacity(alpha)), lineWidth: on ? w * (1.12 + 0.06 * pulse) : w)
                let pos = CGPoint(x: c.x + radius * cos(mid.radians), y: c.y + radius * sin(mid.radians))
                g.draw(Text("\(n)\(minor ? "A" : "B")").font(.system(size: max(9, r * 0.075), weight: .semibold))
                    .foregroundStyle(on ? Color.black : Color.white.opacity(0.85)), at: pos)
            }
        }
        let dot = r * (0.12 + 0.04 * pulse)
        g.fill(Path(ellipseIn: CGRect(x: c.x - dot, y: c.y - dot, width: dot * 2, height: dot * 2)), with: .color(.white.opacity(0.1 + 0.5 * pulse)))
    }
}

/// 12 chroma bars (C first) with note names.
struct ChromaBars: View {
    let chroma: [Float]
    var body: some View {
        HStack(alignment: .bottom, spacing: 3) {
            ForEach(0..<12, id: \.self) { i in
                VStack(spacing: 2) {
                    GeometryReader { geo in
                        let v = CGFloat(min(1, max(0, i < chroma.count ? chroma[i] : 0)))
                        VStack { Spacer(minLength: 0); RoundedRectangle(cornerRadius: 2).fill(KB.primary).frame(height: max(4, geo.size.height * v)) }
                    }
                    .frame(height: 36)
                    Text(Harmony.notes[i]).font(.system(size: 10)).foregroundStyle(KB.muted)
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// Label + value row used on Live.
struct InfoRow: View {
    let label: LocalizedStringKey
    let value: String
    var body: some View {
        HStack { Text(label).foregroundStyle(KB.muted); Spacer(); Text(value).monospacedDigit() }
            .font(Theme.body(15))
            .accessibilityElement(children: .combine)
    }
}

/// Big readout (key or BPM) with its detail lines.
struct Readout: View {
    let label: LocalizedStringKey
    let value: String
    let detail: String
    var sub: String?
    var color: Color = KB.fg
    var body: some View {
        VStack(spacing: 4) {
            Text(label).font(Theme.body(13, weight: .medium)).foregroundStyle(KB.muted)
            Text(value).font(Theme.heading(44)).foregroundStyle(color).monospacedDigit().minimumScaleFactor(0.5).lineLimit(1)
                .contentTransition(.numericText())
            Text(detail).font(Theme.body(12)).foregroundStyle(KB.muted)
            if let sub { Text(sub).font(Theme.body(12)).foregroundStyle(KB.muted).multilineTextAlignment(.center) }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// Section card.
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard(cornerRadius: 20)
    }
}

/// Share sheet for exports.
struct ShareItem: Identifiable { let id = UUID(); let url: URL }

extension View {
    func shareSheet(_ item: Binding<ShareItem?>) -> some View {
        sheet(item: item) { s in ActivityView(items: [s.url]).presentationDetents([.medium, .large]) }
    }
}

struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
