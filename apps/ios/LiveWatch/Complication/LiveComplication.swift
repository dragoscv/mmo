import LiveCore
import SwiftUI
import WidgetKit

/// Watch complication: the current setlist part (and song), from the snapshot the watch app stores in the App Group.
@main
struct LiveComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LiveWatchStore.complicationKind, provider: Provider()) { e in ComplicationView(entry: e) }
            .configurationDisplayName("live.widget.part")
            .description("live.widget.part_desc")
            .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
    }

    struct Entry: TimelineEntry { let date: Date; let snapshot: WatchLink.Snapshot? }

    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> Entry {
            Entry(date: .now, snapshot: WatchLink.Snapshot(engineName: "MixAI Live", connected: true, song: "Song", part: "Chorus"))
        }
        func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
            completion(Entry(date: .now, snapshot: LiveWatchStore.load() ?? placeholder(in: context).snapshot))
        }
        func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
            completion(Timeline(entries: [Entry(date: .now, snapshot: LiveWatchStore.load())], policy: .never))
        }
    }
}

private struct ComplicationView: View {
    let entry: LiveComplication.Entry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let part = entry.snapshot?.part ?? "\u{2014}"
        let song = entry.snapshot?.song
        Group {
            switch family {
            case .accessoryInline:
                Text(verbatim: song.map { "\(part) \u{00B7} \($0)" } ?? part)
            case .accessoryCorner:
                Image(systemName: entry.snapshot?.mute == true ? "speaker.slash.fill" : "music.mic")
                    .widgetLabel { Text(verbatim: part) }
            case .accessoryRectangular:
                VStack(alignment: .leading) {
                    Text(verbatim: part).font(.headline).lineLimit(1)
                    Text(verbatim: song ?? String(localized: "live.widget.idle")).font(.caption).lineLimit(1)
                    if let n = entry.snapshot?.nextPart { Text("live.perform.next \(n)").font(.caption2).lineLimit(1) }
                }
            default:
                ZStack {
                    AccessoryWidgetBackground()
                    Text(verbatim: String(part.prefix(3))).font(.caption.weight(.bold))
                }
            }
        }
        .containerBackground(.clear, for: .widget)
        .accessibilityLabel(Text("live.watch.cd_scene \(song ?? "") \(part)"))
    }
}
