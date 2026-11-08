import AppIntents
import SwiftUI
import WidgetKit

@main
struct MixAIMusicWidgetsBundle: WidgetBundle {
    var body: some Widget {
        MusicNowPlayingWidget()
        MusicPlayPauseControl()
    }
}

struct MusicEntry: TimelineEntry {
    let date: Date
    let snapshot: MusicWidgetSnapshot?
}

struct MusicProvider: TimelineProvider {
    func placeholder(in context: Context) -> MusicEntry {
        MusicEntry(date: .now, snapshot: MusicWidgetSnapshot(title: "MixAI Music", artist: nil, album: nil, playing: true, hasCover: false, serverName: nil, updatedAt: .now))
    }

    func getSnapshot(in context: Context, completion: @escaping (MusicEntry) -> Void) {
        completion(MusicEntry(date: .now, snapshot: MusicWidgetSnapshot.load() ?? placeholder(in: context).snapshot))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MusicEntry>) -> Void) {
        // The app reloads the timeline on every track / state change; no polling.
        completion(Timeline(entries: [MusicEntry(date: .now, snapshot: MusicWidgetSnapshot.load())], policy: .never))
    }
}

/// Now playing: cover, title / artist, previous / play-pause / next (AudioPlaybackIntent, runs in the app, no launch).
/// Idle: Start a mix.
struct MusicNowPlayingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: MusicWidgetKinds.nowPlaying, provider: MusicProvider()) { entry in
            MusicWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetColors.background }
                .widgetURL(URL(string: "mixai-music://nowplaying"))
        }
        .configurationDisplayName("widget.music.name")
        .description("widget.music.desc")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

/// Colours copied from the generated tokens (extensions do not link MixaiCore).
enum WidgetColors {
    static let background = Color(.sRGB, red: 0.027, green: 0.024, blue: 0.059, opacity: 1)
    static let primary = Color(.sRGB, red: 0.584, green: 0.533, blue: 1.0, opacity: 1)
    static let muted = Color(.sRGB, red: 0.725, green: 0.71, blue: 0.84, opacity: 1)
}

struct MusicWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: MusicEntry

    var body: some View {
        if let s = entry.snapshot {
            switch family {
            case .accessoryRectangular:
                VStack(alignment: .leading) {
                    Text(s.title).font(.headline).lineLimit(1)
                    Text(s.artist ?? "").font(.caption).lineLimit(1)
                }
            case .systemSmall:
                VStack(alignment: .leading, spacing: 6) {
                    cover(s).frame(width: 64, height: 64)
                    Spacer(minLength: 0)
                    Text(s.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(s.artist ?? "").font(.system(size: 11)).foregroundStyle(WidgetColors.muted).lineLimit(1)
                    controls(s, compact: true)
                }
            default:
                HStack(spacing: 14) {
                    cover(s).frame(width: 110, height: 110)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(s.title).font(.system(size: 16, weight: .semibold)).lineLimit(2)
                        Text(s.artist ?? "").font(.system(size: 13)).foregroundStyle(WidgetColors.muted).lineLimit(1)
                        Spacer(minLength: 0)
                        controls(s, compact: false)
                    }
                }
            }
        } else {
            VStack(spacing: 8) {
                Image(systemName: "sparkles").font(.title2).foregroundStyle(WidgetColors.primary)
                Text("music.start_mix").font(.system(size: 14, weight: .semibold))
                Button(intent: StartMixIntent()) { Image(systemName: "play.fill") }.tint(WidgetColors.primary)
            }
        }
    }

    @ViewBuilder
    private func cover(_ s: MusicWidgetSnapshot) -> some View {
        if s.hasCover, let f = MusicAppGroup.coverFile, let img = UIImage(contentsOfFile: f.path) {
            Image(uiImage: img).resizable().aspectRatio(contentMode: .fill).clipShape(.rect(cornerRadius: 12))
        } else {
            RoundedRectangle(cornerRadius: 12).fill(WidgetColors.primary.opacity(0.25)).overlay(Image(systemName: "music.note").foregroundStyle(WidgetColors.primary))
        }
    }

    private func controls(_ s: MusicWidgetSnapshot, compact: Bool) -> some View {
        HStack(spacing: compact ? 10 : 18) {
            if !compact {
                Button(intent: PreviousTrackIntent()) { Image(systemName: "backward.fill") }.accessibilityLabel(Text("music.previous"))
            }
            Button(intent: TogglePlaybackIntent()) { Image(systemName: s.playing ? "pause.fill" : "play.fill") }
                .accessibilityLabel(Text(s.playing ? "player.pause" : "player.play"))
            Button(intent: NextTrackIntent()) { Image(systemName: "forward.fill") }.accessibilityLabel(Text("music.next"))
        }
        .buttonStyle(.plain)
        .font(.system(size: compact ? 15 : 18, weight: .semibold))
        .foregroundStyle(WidgetColors.primary)
    }
}

/// Control Center / Lock Screen / Action button control: play-pause.
struct MusicPlayPauseControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: MusicWidgetKinds.control) {
            let playing = MusicWidgetSnapshot.load()?.playing ?? false
            ControlWidgetButton(action: TogglePlaybackIntent()) {
                Label(playing ? "player.pause" : "player.play", systemImage: playing ? "pause.fill" : "play.fill")
            }
        }
        .displayName("widget.music.control")
    }
}
