import ActivityKit
import Foundation

/// Live Activity / Dynamic Island while listening (WP18-20 iOS). Started with the session (also required by Apple
/// for AudioRecordingIntent starts), updated at most once a second and only on a visible change, ended on stop.
@MainActor
final class LiveActivityController {
    static let shared = LiveActivityController()

    private var activity: Activity<KeyBpmActivityAttributes>?
    private var last: KeyBpmActivityAttributes.ContentState?
    private var lastAt: TimeInterval = 0

    func start(session: ListenSession) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled, activity == nil else { return }
        let state = Self.state(session)
        do {
            activity = try Activity.request(attributes: KeyBpmActivityAttributes(startedAt: .now),
                                            content: ActivityContent(state: state, staleDate: nil), pushType: nil)
            last = state
        } catch {
            activity = nil
        }
    }

    func update(session: ListenSession) {
        guard let activity else { return }
        let state = Self.state(session)
        let now = ProcessInfo.processInfo.systemUptime
        guard state != last, now - lastAt >= 1 else { return }
        last = state
        lastAt = now
        Self.push(id: activity.id, state: state)
    }

    func end(session: ListenSession) {
        guard let activity else { return }
        let state = Self.state(session)
        self.activity = nil
        last = nil
        Self.finish(id: activity.id, state: state)
    }

    /// Looks the activity up by id inside the task (Activity is not Sendable; Swift 6 refuses sending it).
    nonisolated private static func push(id: String, state: KeyBpmActivityAttributes.ContentState) {
        Task.detached {
            guard let a = Activity<KeyBpmActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
            await a.update(ActivityContent(state: state, staleDate: .now.addingTimeInterval(120)))
        }
    }

    nonisolated private static func finish(id: String, state: KeyBpmActivityAttributes.ContentState) {
        Task.detached {
            guard let a = Activity<KeyBpmActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
            await a.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(.now.addingTimeInterval(300)))
        }
    }

    static func state(_ s: ListenSession) -> KeyBpmActivityAttributes.ContentState {
        let k = s.reading?.keyIndex
        var title: String?, artist: String?
        if case .found(let m, _) = s.songId { title = m.title; artist = m.artist }
        return .init(
            keyIndex: k, keyLocked: s.reading?.keyLocked ?? false,
            bpm: s.bpm.map { ($0 * 10).rounded() / 10 }, tempoLocked: s.reading?.tempoLocked ?? false,
            next: k.map { Harmony.mixNextLabels($0, limit: 3).map(\.key) } ?? [],
            songTitle: title, songArtist: artist, notation: s.notation.rawValue)
    }
}
