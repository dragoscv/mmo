import SwiftUI
import WidgetKit

/// Watch complications (accessory widgets): last key + BPM, from the watch's own listening or the iPhone context.
@main
struct KeyBpmComplications: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "keybpm.watch.last", provider: Provider()) { e in ComplicationView(entry: e) }
            .configurationDisplayName("kb.widget.last")
            .description("kb.widget.last_desc")
            .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
    }

    struct Entry: TimelineEntry { let date: Date; let reading: LastReading? }

    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> Entry { Entry(date: .now, reading: LastReading(keyIndex: 21, bpm: 124, at: .now)) }
        func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: .now, reading: LastReading.load() ?? placeholder(in: context).reading)) }
        func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
            completion(Timeline(entries: [Entry(date: .now, reading: LastReading.load())], policy: .never))
        }
    }
}

private struct ComplicationView: View {
    let entry: KeyBpmComplications.Entry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let key = entry.reading?.keyIndex.map(Harmony.camelot) ?? "\u{2014}"
        let bpm = entry.reading?.bpm
        let bpmText = bpm.map { String(format: "%.0f", $0) } ?? "\u{2014}"
        Group {
            switch family {
            case .accessoryInline: Text("\(key) \u{00B7} \(bpmText) BPM")
            case .accessoryCorner:
                Text(key).font(.title3.weight(.bold))
                    .widgetLabel { Gauge(value: min(200, max(60, bpm ?? 60)), in: 60...200) { Text("BPM") } currentValueLabel: { Text(bpmText) } }
            case .accessoryRectangular:
                VStack(alignment: .leading) {
                    Text("\(key) \u{00B7} \(bpmText) BPM").font(.headline)
                    Text(entry.reading?.title ?? entry.reading?.keyIndex.map(Harmony.longName) ?? String(localized: "kb.watch.tile_empty")).font(.caption).lineLimit(1)
                }
            default:
                Gauge(value: min(200, max(60, bpm ?? 60)), in: 60...200) { Text("BPM") } currentValueLabel: { Text(key).font(.caption.weight(.bold)) }
                    .gaugeStyle(.accessoryCircular)
            }
        }
        .containerBackground(.clear, for: .widget)
        .accessibilityLabel(Text("kb.watch.cd_complication \(key) \(bpmText)"))
    }
}
