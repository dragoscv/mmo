import ActivityKit
import Foundation

/// Live Activity / Dynamic Island while listening (WP18-05, WP18-20). Started by the app (or an AudioRecordingIntent:
/// Apple requires a Live Activity for the whole recording), rendered by KeyBpmWidgets. Updated at most once a second
/// and only when something visible changed.
struct KeyBpmActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var keyIndex: Int?
        var keyLocked: Bool
        var bpm: Double?
        var tempoLocked: Bool
        /// Up to 3 harmonic next keys (indices), best first.
        var next: [Int]
        var songTitle: String?
        var songArtist: String?
        /// Key notation chosen in the app (`KeyNotation.rawValue`).
        var notation: String
    }

    var startedAt: Date
}
