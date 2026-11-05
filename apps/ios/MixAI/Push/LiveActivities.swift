import ActivityKit
import Foundation
import MixaiCore

/// Live Activities for offline downloads and running DVR recordings (rendered by MixAIWidgets).
@MainActor
final class LiveActivityCenter {
    private var downloads: [String: Activity<DownloadActivityAttributes>] = [:]
    private var recordings: [String: Activity<RecordingActivityAttributes>] = [:]
    private var tokenTask: Task<Void, Never>?

    var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    // MARK: downloads

    func startDownload(item: DownloadItem, queued: Int) {
        guard enabled, downloads[item.id] == nil else { return }
        let attrs = DownloadActivityAttributes(title: item.show ?? item.title, subtitle: item.show == nil ? nil : item.title, downloadId: item.id)
        let state = DownloadActivityAttributes.ContentState(phase: .preparing, progress: 0, bytesDone: 0, bytesTotal: 0, queued: queued)
        do {
            downloads[item.id] = try Activity<DownloadActivityAttributes>.request(attributes: attrs, content: .init(state: state, staleDate: nil), pushType: nil)
        } catch {
            // Activities disabled / too many running: downloads continue without one.
        }
    }

    func updateDownload(id: String, state: DownloadActivityAttributes.ContentState) {
        guard downloads[id] != nil else { return }
        Task { await Self.updateDownloadActivity(id: id, state: state) }
    }

    func endDownload(id: String, success: Bool) {
        guard let a = downloads.removeValue(forKey: id) else { return }
        var final = a.content.state
        final.phase = success ? .done : .failed
        if success { final.progress = 1 }
        let dismiss = Date().addingTimeInterval(success ? 30 : 300)
        Task { await Self.endDownloadActivity(id: id, state: final, dismiss: dismiss) }
    }

    // MARK: recordings

    func startRecording(id: String, title: String, channel: String, startedAt: Date, endsAt: Date) {
        guard enabled, recordings[id] == nil else { return }
        let attrs = RecordingActivityAttributes(title: title, channel: channel, startedAt: startedAt, recordingId: id)
        let state = RecordingActivityAttributes.ContentState(status: .recording, endsAt: endsAt)
        do {
            recordings[id] = try Activity<RecordingActivityAttributes>.request(attributes: attrs, content: .init(state: state, staleDate: endsAt), pushType: nil)
        } catch {}
    }

    func endRecording(id: String, success: Bool) {
        guard let a = recordings.removeValue(forKey: id) else { return }
        let state = RecordingActivityAttributes.ContentState(status: success ? .done : .failed, endsAt: a.content.state.endsAt)
        let dismiss = Date().addingTimeInterval(600)
        Task { await Self.endRecordingActivity(id: id, state: state, dismiss: dismiss) }
    }

    // An `Activity` value is not Sendable: re-fetch it from ActivityKit inside a nonisolated function and use it there.
    private nonisolated static func updateDownloadActivity(id: String, state: DownloadActivityAttributes.ContentState) async {
        guard let a = Activity<DownloadActivityAttributes>.activities.first(where: { $0.attributes.downloadId == id }) else { return }
        await a.update(.init(state: state, staleDate: Date().addingTimeInterval(120)))
    }

    private nonisolated static func endDownloadActivity(id: String, state: DownloadActivityAttributes.ContentState, dismiss: Date) async {
        guard let a = Activity<DownloadActivityAttributes>.activities.first(where: { $0.attributes.downloadId == id }) else { return }
        await a.end(.init(state: state, staleDate: nil), dismissalPolicy: .after(dismiss))
    }

    private nonisolated static func endRecordingActivity(id: String, state: RecordingActivityAttributes.ContentState, dismiss: Date) async {
        guard let a = Activity<RecordingActivityAttributes>.activities.first(where: { $0.attributes.recordingId == id }) else { return }
        await a.end(.init(state: state, staleDate: nil), dismissalPolicy: .after(dismiss))
    }

    /// Ends activities of recordings that are no longer `recording` on the server.
    func syncRecordings(active ids: Set<String>) {
        for id in recordings.keys where !ids.contains(id) { endRecording(id: id, success: true) }
    }

    // MARK: push-to-start token

    func observePushToStart(app: AppModel) {
        guard tokenTask == nil else { return }
        tokenTask = Task {
            for await data in Activity<DownloadActivityAttributes>.pushToStartTokenUpdates {
                app.push.liveActivityToken = apnsTokenHex(data)
                await app.push.register(app: app)
            }
        }
    }
}
