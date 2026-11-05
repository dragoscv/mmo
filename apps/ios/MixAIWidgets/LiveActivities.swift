import ActivityKit
import SwiftUI
import WidgetKit

// MARK: Download

extension DownloadActivityAttributes.ContentState.Phase {
    var labelKey: LocalizedStringKey {
        switch self {
        case .preparing: "activity.download.preparing"
        case .downloading: "activity.download.downloading"
        case .done: "activity.download.done"
        case .failed: "activity.download.failed"
        }
    }

    var symbol: String {
        switch self {
        case .preparing: "gearshape.2"
        case .downloading: "arrow.down.circle"
        case .done: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }
}

enum DownloadFormat {
    static func bytes(_ done: Int64, _ total: Int64) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        if total > 0 { return "\(f.string(fromByteCount: done)) / \(f.string(fromByteCount: total))" }
        return f.string(fromByteCount: done)
    }

    static func percent(_ progress: Double) -> String {
        "\(Int((min(max(progress, 0), 1) * 100).rounded()))%"
    }
}

struct DownloadLockScreenView: View {
    let attributes: DownloadActivityAttributes
    let state: DownloadActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: state.phase.symbol)
                    .font(.title3)
                    .foregroundStyle(state.phase == .failed ? Color.red : WidgetPalette.accent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                    if let subtitle = attributes.subtitle {
                        Text(verbatim: subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                Text(state.phase.labelKey)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: min(max(state.progress, 0), 1))
                .tint(WidgetPalette.accent)
            HStack {
                Text(verbatim: DownloadFormat.bytes(state.bytesDone, state.bytesTotal))
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Spacer()
                if state.queued > 0 {
                    Text("activity.download.queued \(state.queued)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .foregroundStyle(.white)
        .accessibilityElement(children: .combine)
    }
}

struct ProgressRing: View {
    let progress: Double

    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.25), lineWidth: 3)
            Circle()
                .trim(from: 0, to: min(max(progress, 0), 1))
                .stroke(WidgetPalette.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .padding(2)
        .accessibilityHidden(true)
    }
}

struct DownloadLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DownloadActivityAttributes.self) { context in
            DownloadLockScreenView(attributes: context.attributes, state: context.state)
                .padding()
                .activityBackgroundTint(WidgetPalette.background)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(DeepLink.downloads)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: context.state.phase.symbol)
                        .font(.title2)
                        .foregroundStyle(WidgetPalette.accent)
                        .accessibilityHidden(true)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(verbatim: DownloadFormat.percent(context.state.progress))
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(verbatim: context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 4) {
                        ProgressView(value: min(max(context.state.progress, 0), 1))
                            .tint(WidgetPalette.accent)
                        HStack {
                            Text(context.state.phase.labelKey)
                            Spacer()
                            Text(verbatim: DownloadFormat.bytes(context.state.bytesDone, context.state.bytesTotal))
                                .monospacedDigit()
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                Image(systemName: "arrow.down.circle")
                    .foregroundStyle(WidgetPalette.accent)
                    .accessibilityHidden(true)
            } compactTrailing: {
                Text(verbatim: DownloadFormat.percent(context.state.progress))
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
            } minimal: {
                ProgressRing(progress: context.state.progress)
            }
            .widgetURL(DeepLink.downloads)
            .keylineTint(WidgetPalette.accent)
        }
    }
}

// MARK: Recording

extension RecordingActivityAttributes.ContentState.Status {
    var labelKey: LocalizedStringKey {
        switch self {
        case .recording: "activity.recording.live"
        case .done: "activity.recording.done"
        case .failed: "activity.recording.failed"
        }
    }
}

struct RecordDot: View {
    let status: RecordingActivityAttributes.ContentState.Status

    var body: some View {
        Circle()
            .fill(status == .recording ? Color.red : Color.gray)
            .frame(width: 10, height: 10)
            .accessibilityHidden(true)
    }
}

/// Elapsed recording time; a timer interval must have lower <= upper.
func recordingElapsed(_ attributes: RecordingActivityAttributes, _ state: RecordingActivityAttributes.ContentState) -> Text {
    let end = max(state.endsAt, attributes.startedAt)
    return Text(timerInterval: attributes.startedAt...end, countsDown: false)
}

struct RecordingLockScreenView: View {
    let attributes: RecordingActivityAttributes
    let state: RecordingActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 10) {
            RecordDot(status: state.status)
            VStack(alignment: .leading, spacing: 2) {
                Text(state.status.labelKey)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(state.status == .recording ? Color.red : Color.secondary)
                Text(verbatim: attributes.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(verbatim: attributes.channel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                if state.status == .recording {
                    recordingElapsed(attributes, state)
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                        .multilineTextAlignment(.trailing)
                }
                Text(state.endsAt, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.white)
        .accessibilityElement(children: .combine)
    }
}

struct RecordingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            RecordingLockScreenView(attributes: context.attributes, state: context.state)
                .padding()
                .activityBackgroundTint(WidgetPalette.background)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(DeepLink.live)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        RecordDot(status: context.state.status)
                        Text(context.state.status.labelKey)
                            .font(.caption.weight(.semibold))
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.status == .recording {
                        recordingElapsed(context.attributes, context.state)
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 64)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(verbatim: context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text(verbatim: context.attributes.channel)
                        Spacer()
                        Text(context.state.endsAt, style: .time)
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            } compactLeading: {
                RecordDot(status: context.state.status)
            } compactTrailing: {
                if context.state.status == .recording {
                    recordingElapsed(context.attributes, context.state)
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .frame(maxWidth: 48)
                } else {
                    Text(context.state.status.labelKey)
                        .font(.caption2)
                }
            } minimal: {
                RecordDot(status: context.state.status)
            }
            .widgetURL(DeepLink.live)
            .keylineTint(.red)
        }
    }
}
