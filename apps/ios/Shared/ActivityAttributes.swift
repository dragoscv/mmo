import ActivityKit
import Foundation

// Live Activities (ActivityKit). Compiled into the app (requests/updates) and MixAIWidgets (renders).

/// Offline download: server MP4 remux (`preparing`) then the background URLSession transfer.
struct DownloadActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        enum Phase: String, Codable, Hashable, Sendable { case preparing, downloading, done, failed }
        var phase: Phase
        /// 0...1 of the current phase.
        var progress: Double
        var bytesDone: Int64
        var bytesTotal: Int64
        /// Other downloads still queued after this one.
        var queued: Int
    }

    var title: String
    var subtitle: String?
    /// `DownloadItem.id` (fileId + audio ordinal).
    var downloadId: String
}

/// A DVR recording running on the MMO Server (`/livetv/recordings` status `recording`).
struct RecordingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        enum Status: String, Codable, Hashable, Sendable { case recording, done, failed }
        var status: Status
        var endsAt: Date
    }

    var title: String
    var channel: String
    var startedAt: Date
    var recordingId: String
}
