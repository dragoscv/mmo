import Foundation

/// Progress writes: server first (`PUT /media/progress`, seconds), a persisted queue as fallback that is flushed
/// with the next successful write (port of `ProgressSync`).
public actor ProgressSync {
    private let store: MediaStore
    private let queueFile: URL?
    private var pending: [ProgressInput]

    public init(store: MediaStore, queueFile: URL?) {
        self.store = store
        self.queueFile = queueFile
        if let f = queueFile, let data = try? Data(contentsOf: f), let q = try? JSON.decoder.decode([ProgressInput].self, from: data) {
            pending = q
        } else {
            pending = []
        }
    }

    public var queued: Int { pending.count }

    public static func input(_ ref: MediaRef, positionSec: Double, durationSec: Double?, completed: Bool?, nowMs: Int) -> ProgressInput {
        ProgressInput(kind: ref.kind, tmdbId: ref.tmdbId, season: ref.season, episode: ref.episode,
                      positionSec: positionSec, durationSec: durationSec, completed: completed, updatedAt: nowMs)
    }

    /// Never throws — failures land in the queue.
    public func save(_ ref: MediaRef, positionSec: Double, durationSec: Double, completed: Bool? = nil) async {
        guard durationSec > 0 else { return }
        await put([Self.input(ref, positionSec: positionSec, durationSec: durationSec, completed: completed, nowMs: Self.nowMs())])
    }

    public func markWatched(_ ref: MediaRef, durationSec: Double?) async {
        await put([Self.input(ref, positionSec: durationSec ?? 0, durationSec: durationSec, completed: true, nowMs: Self.nowMs())])
    }

    private func put(_ fresh: [ProgressInput]) async {
        let batch = pending + fresh
        do {
            try await store.putProgress(batch)
            pending = []
        } catch {
            pending = Array((pending + fresh).suffix(500))
        }
        persist()
    }

    private func persist() {
        guard let f = queueFile else { return }
        try? FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
        if pending.isEmpty { try? FileManager.default.removeItem(at: f) } else if let d = try? JSON.encoder.encode(pending) { try? d.write(to: f, options: .atomic) }
    }

    static func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }
}
