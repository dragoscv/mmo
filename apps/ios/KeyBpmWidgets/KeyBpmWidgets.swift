import ActivityKit
import AppIntents
import MixaiCore
import SwiftUI
import WidgetKit

// MixAI Key & BPM widgets extension (WP18-05): Live Activity + Dynamic Island, last-reading widget (Home, Lock
// Screen, StandBy), Identify widget, Control Center "Listen" control. Reads `LastReading` from the App Group.

@main
struct KeyBpmWidgetsBundle: WidgetBundle {
    var body: some Widget {
        KeyBpmLiveActivity()
        LastReadingWidget()
        IdentifyWidget()
        ListenControl()
    }
}

private func keyColor(_ k: Int) -> Color {
    let n = Harmony.camelotNumber(k) - 1
    return Harmony.isMinor(k) ? Tokens.Key.minor[n] : Tokens.Key.major[n]
}

private func label(_ k: Int?, _ notation: String) -> String {
    guard let k else { return "\u{2014}" }
    return (Notation(rawValue: notation) ?? .camelot).label(k)
}

// MARK: Live Activity

struct KeyBpmLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: KeyBpmActivityAttributes.self) { ctx in
            LockScreenActivity(state: ctx.state, startedAt: ctx.attributes.startedAt)
                .activityBackgroundTint(Tokens.Dark.background.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "mixai-keybpm://stage"))
        } dynamicIsland: { ctx in
            let s = ctx.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading) {
                        Text(label(s.keyIndex, s.notation)).font(.title.weight(.heavy)).foregroundStyle(s.keyIndex.map(keyColor) ?? .white)
                        Text(s.keyIndex.map(Harmony.longName) ?? "").font(.caption).foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing) {
                        Text(s.bpm.map { String(format: "%.1f", $0) } ?? "\u{2014}").font(.title.weight(.heavy)).monospacedDigit()
                        Text("BPM").font(.caption).foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 6) {
                        if let t = s.songTitle { Text([t, s.songArtist].compactMap { $0 }.joined(separator: " \u{2014} ")).font(.caption).lineLimit(1) }
                        if !s.next.isEmpty {
                            HStack(spacing: 6) {
                                Text("kb.la.next").font(.caption2).foregroundStyle(.secondary)
                                ForEach(s.next, id: \.self) { k in
                                    Text(label(k, s.notation)).font(.caption.weight(.semibold))
                                        .padding(.horizontal, 8).padding(.vertical, 2)
                                        .background(keyColor(k).opacity(0.3), in: Capsule())
                                }
                            }
                        }
                    }
                }
            } compactLeading: {
                Text(label(s.keyIndex, s.notation)).font(.caption.weight(.bold)).foregroundStyle(s.keyIndex.map(keyColor) ?? .white)
            } compactTrailing: {
                Text(s.bpm.map { String(format: "%.0f", $0) } ?? "\u{2014}").font(.caption.weight(.bold)).monospacedDigit()
            } minimal: {
                Text(label(s.keyIndex, s.notation)).font(.caption2.weight(.bold)).foregroundStyle(s.keyIndex.map(keyColor) ?? .white)
            }
            .widgetURL(URL(string: "mixai-keybpm://stage"))
        }
    }
}

private struct LockScreenActivity: View {
    let state: KeyBpmActivityAttributes.ContentState
    let startedAt: Date
    var body: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label(state.keyIndex, state.notation)).font(.system(size: 40, weight: .heavy, design: .rounded))
                    .foregroundStyle(state.keyIndex.map(keyColor) ?? .white).opacity(state.keyLocked ? 1 : 0.6)
                Text(state.keyIndex.map(Harmony.longName) ?? String(localized: "kb.listening")).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(state.bpm.map { String(format: "%.1f", $0) } ?? "\u{2014}").font(.system(size: 40, weight: .heavy, design: .rounded)).monospacedDigit()
                    .opacity(state.tempoLocked ? 1 : 0.6)
                HStack(spacing: 4) { Text("BPM"); Text("\u{00B7}"); Text(startedAt, style: .timer) }.font(.caption).foregroundStyle(.secondary)
            }
        }
        .overlay(alignment: .bottomLeading) {
            if !state.next.isEmpty {
                HStack(spacing: 4) {
                    ForEach(state.next, id: \.self) { k in
                        Text(label(k, state.notation)).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1)
                            .background(keyColor(k).opacity(0.3), in: Capsule())
                    }
                }
                .offset(y: 18)
            }
        }
        .padding(16)
        .padding(.bottom, state.next.isEmpty ? 0 : 12)
        .foregroundStyle(.white)
    }
}

// MARK: last reading widget

struct LastEntry: TimelineEntry {
    let date: Date
    let reading: LastReading?
}

struct LastProvider: TimelineProvider {
    func placeholder(in context: Context) -> LastEntry { LastEntry(date: .now, reading: LastReading(keyIndex: 21, bpm: 124, at: .now)) }
    func getSnapshot(in context: Context, completion: @escaping (LastEntry) -> Void) { completion(LastEntry(date: .now, reading: LastReading.load() ?? placeholder(in: context).reading)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LastEntry>) -> Void) {
        completion(Timeline(entries: [LastEntry(date: .now, reading: LastReading.load())], policy: .never))
    }
}

struct LastReadingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "keybpm.last", provider: LastProvider()) { e in LastReadingView(entry: e) }
            .configurationDisplayName("kb.widget.last")
            .description("kb.widget.last_desc")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct LastReadingView: View {
    let entry: LastEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let r = entry.reading
        let key = r?.keyIndex.map(Harmony.camelot) ?? "\u{2014}"
        let bpm = r?.bpm.map { String(format: "%.0f", $0) } ?? "\u{2014}"
        Group {
            switch family {
            case .accessoryInline: Text("\(key) \u{00B7} \(bpm) BPM")
            case .accessoryCircular:
                VStack(spacing: 0) { Text(key).font(.headline.weight(.heavy)); Text(bpm).font(.caption2) }
                    .containerBackground(.clear, for: .widget)
            case .accessoryRectangular:
                VStack(alignment: .leading) {
                    Text("\(key) \u{00B7} \(bpm) BPM").font(.headline)
                    if let t = r?.title { Text(t).font(.caption).lineLimit(1) } else { Text(r?.keyIndex.map(Harmony.longName) ?? "").font(.caption) }
                }
                .containerBackground(.clear, for: .widget)
            default:
                VStack(alignment: .leading, spacing: 4) {
                    Text(key).font(.system(size: 44, weight: .heavy, design: .rounded)).foregroundStyle(r?.keyIndex.map(keyColor) ?? .white)
                    Text("\(bpm) BPM").font(.title3.weight(.semibold)).monospacedDigit()
                    if let t = r?.title { Text(t).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                    Spacer(minLength: 0)
                    Button(intent: StartListeningWidgetIntent()) { Label("kb.listen", systemImage: "waveform") }
                        .font(.caption.weight(.semibold)).tint(Tokens.Brand.violetDark)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(.white)
                .containerBackground(Tokens.Dark.background, for: .widget)
            }
        }
        .widgetURL(URL(string: "mixai-keybpm://listen"))
    }
}

/// Widget buttons open the app at Listen (an extension cannot own the mic; the app's AudioRecordingIntent does).
struct StartListeningWidgetIntent: AppIntent {
    static let title: LocalizedStringResource = "kb.intent.listen"
    static let openAppWhenRun = true
    func perform() async throws -> some IntentResult & OpensIntent { .result(opensIntent: OpenURLIntent(URL(string: "mixai-keybpm://listen")!)) }
}

// MARK: Identify widget

struct IdentifyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "keybpm.identify", provider: LastProvider()) { _ in
            VStack(spacing: 8) {
                Image(systemName: "shazam.logo").font(.system(size: 34))
                Text("kb.widget.identify").font(.headline).multilineTextAlignment(.center)
            }
            .foregroundStyle(.white)
            .containerBackground(Tokens.Brand.violetDark.gradient, for: .widget)
            .widgetURL(URL(string: "mixai-keybpm://identify"))
        }
        .configurationDisplayName("kb.widget.identify")
        .description("kb.widget.identify_desc")
        .supportedFamilies([.systemSmall, .accessoryCircular])
    }
}

// MARK: Control Center

struct ListenControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "ro.mixai.keybpm.listen") {
            ControlWidgetButton(action: StartListeningWidgetIntent()) {
                Label("kb.control.listen", systemImage: "waveform")
            }
        }
        .displayName("kb.control.listen")
        .description("kb.control.listen_desc")
    }
}
