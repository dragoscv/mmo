import LiveCore
import SwiftUI

/// Input + stereo output meters drawn in a Canvas inside a TimelineView, so the bars animate at display rate from the
/// client's smoothed levels (instant attack, 20 dB/s release) instead of jumping at the 30 Hz meter rate.
struct MetersView: View {
    @Environment(LiveSession.self) private var session

    var body: some View {
        let m = session.model
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("live.perform.meters").font(.caption.weight(.semibold)).foregroundStyle(LiveTheme.muted)
                Spacer()
                if m.meters?.clipped == true {
                    Text("live.perform.clip").font(.caption2.weight(.bold)).foregroundStyle(LiveTheme.dangerForeground)
                        .padding(.horizontal, 6).padding(.vertical, 2).background(LiveTheme.danger, in: Capsule())
                }
                if let d = m.meters { Text("live.perform.dsp \(d.dspPercent)").font(.caption2.monospacedDigit()).foregroundStyle(LiveTheme.muted) }
            }
            TimelineView(.animation(minimumInterval: 1 / 60, paused: m.meters == nil)) { _ in
                let lv = session.model.levels
                Canvas { ctx, size in
                    let rows: [Float] = [lv.inDb, lv.outLDb, lv.outRDb]
                    let gap: CGFloat = 6
                    let h = (size.height - gap * 2) / 3
                    for (i, db) in rows.enumerated() {
                        let y = CGFloat(i) * (h + gap)
                        let track = Path(roundedRect: CGRect(x: 0, y: y, width: size.width, height: h), cornerRadius: h / 2)
                        ctx.fill(track, with: .color(LiveTheme.raised))
                        let w = size.width * MeterLevels.fraction(db)
                        if w > 0 {
                            let bar = Path(roundedRect: CGRect(x: 0, y: y, width: max(h, w), height: h), cornerRadius: h / 2)
                            ctx.fill(bar, with: .color(LiveTheme.meter(db)))
                        }
                    }
                }
            }
            .frame(height: 44)
            .accessibilityElement()
            .accessibilityLabel(Text("live.perform.meters"))
            .accessibilityValue(Text("live.perform.meters_value \(LiveFormat.db(m.levels.inDb)) \(LiveFormat.db(max(m.levels.outLDb, m.levels.outRDb)))"))
            HStack {
                Text("live.perform.in").frame(maxWidth: .infinity, alignment: .leading)
                Text("live.perform.out").frame(maxWidth: .infinity, alignment: .trailing)
            }
            .font(.caption2).foregroundStyle(LiveTheme.muted)
        }
        .liveCard()
    }
}

/// Tuner: note name (correction target when pitch correction is active), needle -50…+50 cents, frequency.
struct TunerView: View {
    let tune: Tune

    var body: some View {
        let cents = max(-50, min(50, tune.cents))
        HStack(spacing: 16) {
            Text(verbatim: tune.noteName ?? "\u{2014}")
                .font(.system(size: 40, weight: .bold, design: .rounded)).monospacedDigit()
                .foregroundStyle(LiveTheme.tune(cents))
                .frame(minWidth: 72)
            VStack(alignment: .leading, spacing: 6) {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(LiveTheme.raised).frame(height: 6)
                        Rectangle().fill(LiveTheme.muted).frame(width: 2, height: 14).offset(x: g.size.width / 2 - 1)
                        Circle().fill(LiveTheme.tune(cents)).frame(width: 14, height: 14)
                            .offset(x: g.size.width * CGFloat((cents + 50) / 100) - 7)
                            .animation(.easeOut(duration: 0.08), value: cents)
                    }
                    .frame(maxHeight: .infinity)
                }
                .frame(height: 16)
                Text("live.perform.tuner_meta \(LiveFormat.cents(cents)) \(LiveFormat.cents(tune.correctionCents)) \(Int(tune.freq.rounded()))")
                    .font(.caption.monospacedDigit()).foregroundStyle(LiveTheme.muted)
            }
        }
        .liveCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("live.perform.tuner"))
    }
}
