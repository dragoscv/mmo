import SwiftUI
import WidgetKit

struct NowPlayingEntry: TimelineEntry {
    let date: Date
    let nowPlaying: WidgetSnapshot.NowPlaying?
}

struct NowPlayingProvider: TimelineProvider {
    func placeholder(in context: Context) -> NowPlayingEntry {
        NowPlayingEntry(
            date: .now,
            nowPlaying: WidgetSnapshot.NowPlaying(title: "MixAI TV", subtitle: nil, playing: true, source: .music, imageFile: nil, updatedAt: .now))
    }

    func getSnapshot(in context: Context, completion: @escaping (NowPlayingEntry) -> Void) {
        completion(NowPlayingEntry(date: .now, nowPlaying: WidgetSnapshot.load().nowPlaying))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NowPlayingEntry>) -> Void) {
        // The app reloads this kind whenever playback changes; the policy is only a fallback.
        let entry = NowPlayingEntry(date: .now, nowPlaying: WidgetSnapshot.load().nowPlaying)
        completion(Timeline(entries: [entry], policy: .after(Date.now.addingTimeInterval(30 * 60))))
    }
}

extension WidgetSnapshot.NowPlaying.Source {
    var symbol: String {
        switch self {
        case .music: "music.note"
        case .video: "film"
        case .live: "dot.radiowaves.left.and.right"
        }
    }
}

struct NowPlayingView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NowPlayingEntry

    private var isAccessory: Bool {
        family == .accessoryRectangular || family == .accessoryCircular
    }

    var body: some View {
        content
            .widgetURL(DeepLink.nowPlaying)
            .containerBackground(for: .widget) {
                if isAccessory { Color.clear } else { WidgetPalette.background }
            }
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryCircular: circular
        case .accessoryRectangular: rectangular
        case .systemMedium: medium
        default: small
        }
    }

    private func stateIcon(_ np: WidgetSnapshot.NowPlaying) -> some View {
        Image(systemName: np.playing ? "pause.circle.fill" : "play.circle.fill")
            .foregroundStyle(WidgetPalette.accent)
            .accessibilityHidden(true)
    }

    @ViewBuilder private var small: some View {
        if let np = entry.nowPlaying {
            VStack(alignment: .leading, spacing: 4) {
                WidgetArtwork(file: np.imageFile, symbol: np.source.symbol)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                HStack(spacing: 4) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(verbatim: np.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        if let subtitle = np.subtitle {
                            Text(verbatim: subtitle)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 2)
                    stateIcon(np).font(.title3)
                }
            }
            .accessibilityElement(children: .combine)
        } else {
            empty
        }
    }

    @ViewBuilder private var medium: some View {
        if let np = entry.nowPlaying {
            HStack(spacing: 12) {
                WidgetArtwork(file: np.imageFile, symbol: np.source.symbol)
                    .frame(width: 110, height: 110)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text("widget.nowplaying.title")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(verbatim: np.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(2)
                    if let subtitle = np.subtitle {
                        Text(verbatim: subtitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    stateIcon(np).font(.title)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        } else {
            empty
        }
    }

    @ViewBuilder private var rectangular: some View {
        if let np = entry.nowPlaying {
            HStack(spacing: 6) {
                Image(systemName: np.playing ? "pause.fill" : "play.fill")
                    .font(.title3)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: np.title).font(.headline).lineLimit(1)
                    if let subtitle = np.subtitle {
                        Text(verbatim: subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        } else {
            Text("widget.nowplaying.empty")
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let np = entry.nowPlaying {
                Image(systemName: np.playing ? "pause.fill" : "play.fill")
                    .font(.title2)
                    .accessibilityLabel(Text(verbatim: np.title))
            } else {
                Image(systemName: "music.note")
                    .font(.title2)
                    .accessibilityLabel(Text("widget.nowplaying.empty"))
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 6) {
            Image(systemName: "music.note.tv")
                .font(.title2)
                .foregroundStyle(WidgetPalette.accent)
                .accessibilityHidden(true)
            Text("widget.nowplaying.empty")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct NowPlayingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetKinds.nowPlaying, provider: NowPlayingProvider()) { entry in
            NowPlayingView(entry: entry)
        }
        .configurationDisplayName("widget.nowplaying.title")
        .description("widget.nowplaying.desc")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular])
    }
}
