import Charts
import MixaiCore
import MixaiUI
import SwiftUI

/// Practice tab: key card (scale / chords / capo), singer transpose (hum test), announce + background toggles, set
/// timeline + share image.
struct PracticeView: View {
    @Environment(ListenSession.self) private var s
    @State private var testing = false
    @State private var notes: [Int] = []
    @State private var centre: Int?
    @State private var share: ShareItem?

    private var songKey: Int? { s.reading?.keyIndex ?? s.log.entries.first?.keyIndex }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let k = songKey { keyCard(k) }
                singerCard
                Card {
                    Toggle(isOn: Binding(get: { s.prefs.announceKey }, set: { s.prefs.announceKey = $0 })) {
                        VStack(alignment: .leading) {
                            Text("kb.a11y.announce")
                            Text("kb.a11y.announce_hint").font(Theme.body(12)).foregroundStyle(KB.muted)
                        }
                    }
                    Toggle(isOn: Binding(get: { s.prefs.background }, set: { s.prefs.background = $0 })) {
                        VStack(alignment: .leading) {
                            Text("kb.background")
                            Text("kb.background_hint").font(Theme.body(12)).foregroundStyle(KB.muted)
                        }
                    }
                }
                timelineCard
            }
            .padding()
        }
        .background(KB.bg)
        .onChange(of: s.reading?.pitchMidi) { _, m in
            guard testing, let m, (36...84).contains(m), (s.reading?.pitchClarity ?? 0) > 0.85 else { return }
            notes.append(m)
        }
        .shareSheet($share)
    }

    private func keyCard(_ k: Int) -> some View {
        let capo = Harmony.capo(k)
        return Card {
            Text("\(Harmony.camelot(k)) \u{00B7} \(Harmony.keyName(k))").font(Theme.heading(24)).foregroundStyle(KB.keyColor(k))
            Text("kb.key_notes \(Harmony.scale(k).joined(separator: " "))")
            Text("kb.key_chords \(Harmony.chords(k).joined(separator: " "))")
            Text("kb.capo.title").font(Theme.body(13, weight: .semibold)).foregroundStyle(KB.muted)
            if capo.fret == 0 {
                Text("kb.capo.open \(Harmony.keyName(capo.shape))")
            } else {
                Text("kb.capo.result \(capo.fret) \(Harmony.keyName(capo.shape))")
            }
        }
    }

    private var singerCard: some View {
        Card {
            Text("kb.sing.title").font(Theme.body(16, weight: .semibold))
            Text("kb.sing.hint").font(Theme.body(13)).foregroundStyle(KB.muted)
            if testing {
                Button("kb.sing.stop \(notes.count)") {
                    testing = false
                    centre = Harmony.voiceCentre(notes)
                    s.stop()
                }
                .buttonStyle(.glassProminent)
            } else {
                Button("kb.sing.start") {
                    notes = []
                    centre = nil
                    testing = true
                    if !s.listening { Task { await s.start() } }
                }
                .buttonStyle(.glass)
            }
            if let c = centre {
                Text("kb.sing.centre \(Harmony.noteName(c) + String(c / 12 - 1))")
                if let k = songKey {
                    let t = Harmony.singerTranspose(songKey: k, voiceCentreMidi: c)
                    Text("kb.sing.result \(String(format: "%+d", t)) \(Harmony.keyName(Harmony.transpose(k, t)))").font(Theme.body(15, weight: .semibold))
                } else {
                    Text("kb.sing.need_key").foregroundStyle(KB.muted)
                }
            }
        }
    }

    private var points: [LogEntry] { Array(s.log.entries.sorted { $0.at < $1.at }.suffix(60)) }

    private var timelineCard: some View {
        Card {
            Text("kb.timeline.title").font(Theme.body(16, weight: .semibold))
            if points.count < 2 {
                Text("kb.timeline.empty").foregroundStyle(KB.muted)
            } else {
                TimelineChart(points: points).frame(height: 160)
                    .accessibilityLabel(Text(points.map { "\($0.camelot) \(Int($0.bpm.rounded()))" }.joined(separator: ", ")))
                Button("kb.timeline.share") { shareImage() }.buttonStyle(.glass)
            }
        }
    }

    private func shareImage() {
        let p = points
        guard let first = p.first, let last = p.last else { return }
        let card = VStack(alignment: .leading, spacing: 20) {
            Text("kb.timeline.title").font(.system(size: 64, weight: .bold))
            Text("\(first.camelot) \u{2192} \(last.camelot) \u{00B7} \(Int(first.bpm.rounded())) \u{2192} \(Int(last.bpm.rounded())) BPM \u{00B7} \(p.count)")
                .font(.system(size: 40)).opacity(0.75)
            TimelineChart(points: p).frame(height: 870)
            Spacer()
            Text(verbatim: "MixAI Key & BPM").font(.system(size: 32, weight: .semibold)).opacity(0.7)
        }
        .padding(60)
        .frame(width: 1080, height: 1350)
        .foregroundStyle(.white)
        .background(KB.bg)
        let r = ImageRenderer(content: card)
        r.scale = 1
        guard let img = r.uiImage, let data = img.pngData() else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("mixai-timeline-\(Date.now.formatted(.iso8601.year().month().day())).png")
        try? data.write(to: url)
        share = ShareItem(url: url)
    }
}

/// Key band (Camelot colours) + BPM line, Swift Charts.
struct TimelineChart: View {
    let points: [LogEntry]

    var body: some View {
        let lo = (points.map(\.bpm).min() ?? 0) - 2
        let hi = (points.map(\.bpm).max() ?? 0) + 2
        Chart {
            ForEach(Array(points.enumerated()), id: \.offset) { i, entry in
                let end = i + 1 < points.count ? points[i + 1].at : entry.at.addingTimeInterval(30)
                RectangleMark(xStart: .value("t", entry.at), xEnd: .value("t", end),
                              yStart: .value("bpm", lo), yEnd: .value("bpm", lo + (hi - lo) * 0.18))
                    .foregroundStyle(entry.keyIndex.map(KB.keyColor) ?? KB.muted)
                LineMark(x: .value("t", entry.at), y: .value("bpm", entry.bpm))
                    .foregroundStyle(.white)
                    .lineStyle(StrokeStyle(lineWidth: 3))
            }
        }
        .chartYScale(domain: lo...hi)
        .chartXAxis(.hidden)
    }
}
