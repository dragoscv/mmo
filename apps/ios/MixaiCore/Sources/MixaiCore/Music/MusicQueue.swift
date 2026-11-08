import Foundation

/// Repeat mode of the local queue (same wire values as the server's `MusicQueueRepeat`).
public enum RepeatMode: String, Sendable, Codable, CaseIterable {
    case off, all, one

    public var next: RepeatMode {
        switch self {
        case .off: .all
        case .all: .one
        case .one: .off
        }
    }
}

/// Pure play queue: order, current index, shuffle with a restorable original order, repeat, edits.
/// The player owns one and asks it what to play; every edit keeps `index` on the same track.
public struct PlayQueue: Sendable, Equatable {
    public private(set) var tracks: [TrackCard]
    public private(set) var index: Int
    public private(set) var shuffled: Bool
    public var repeatMode: RepeatMode
    /// Order before shuffling (restored when shuffle is turned off).
    private var original: [TrackCard]

    public init(tracks: [TrackCard] = [], index: Int = 0, repeatMode: RepeatMode = .off) {
        self.tracks = tracks
        self.index = tracks.isEmpty ? 0 : min(max(0, index), tracks.count - 1)
        self.shuffled = false
        self.repeatMode = repeatMode
        self.original = tracks
    }

    public var current: TrackCard? { tracks.indices.contains(index) ? tracks[index] : nil }
    public var isEmpty: Bool { tracks.isEmpty }
    /// Tracks after the current one, in play order.
    public var upcoming: ArraySlice<TrackCard> { tracks.isEmpty ? [] : tracks[(index + 1)...] }

    /// Index that plays after the current one finishes on its own (`nil` = stop). Repeat-one repeats.
    public func nextIndexAfterEnd() -> Int? {
        guard !tracks.isEmpty else { return nil }
        if repeatMode == .one { return index }
        if index + 1 < tracks.count { return index + 1 }
        return repeatMode == .all ? 0 : nil
    }

    /// Index for an explicit "next" (skip): repeat-one does not trap the user on one track.
    public func nextIndexForSkip() -> Int? {
        guard !tracks.isEmpty else { return nil }
        if index + 1 < tracks.count { return index + 1 }
        return repeatMode == .off ? nil : 0
    }

    /// Previous track index, wrapping only with repeat-all.
    public func previousIndex() -> Int? {
        guard !tracks.isEmpty else { return nil }
        if index > 0 { return index - 1 }
        return repeatMode == .all ? tracks.count - 1 : nil
    }

    public mutating func move(to i: Int) {
        guard tracks.indices.contains(i) else { return }
        index = i
    }

    /// Shuffle keeps the current track first and shuffles the rest; off restores the original order.
    public mutating func setShuffle<G: RandomNumberGenerator>(_ on: Bool, using rng: inout G) {
        guard on != shuffled else { return }
        let cur = current
        if on {
            original = tracks
            var rest = tracks
            if tracks.indices.contains(index) { rest.remove(at: index) }
            rest.shuffle(using: &rng)
            tracks = (cur.map { [$0] } ?? []) + rest
            index = 0
        } else {
            // Edits made while shuffled survive: keep the original order of what is still queued, then additions.
            let ids = Set(tracks.map(\.id))
            var restored = original.filter { ids.contains($0.id) }
            let known = Set(restored.map(\.id))
            restored += tracks.filter { !known.contains($0.id) }
            tracks = restored
            index = cur.flatMap { c in tracks.firstIndex { $0.id == c.id } } ?? 0
        }
        shuffled = on
    }

    public mutating func setShuffle(_ on: Bool) {
        var g = SystemRandomNumberGenerator()
        setShuffle(on, using: &g)
    }

    /// "Play next": right after the current track.
    public mutating func playNext(_ add: [TrackCard]) {
        guard !add.isEmpty else { return }
        if tracks.isEmpty { self = PlayQueue(tracks: add, repeatMode: repeatMode); return }
        tracks.insert(contentsOf: add, at: index + 1)
        original += add
    }

    /// "Add to queue": at the end.
    public mutating func append(_ add: [TrackCard]) {
        guard !add.isEmpty else { return }
        if tracks.isEmpty { self = PlayQueue(tracks: add, repeatMode: repeatMode); return }
        tracks += add
        original += add
    }

    /// Removes rows (indices into `tracks`). Removing the current track makes the next one current.
    /// Returns true when the current track changed (the player must load the new current).
    @discardableResult
    public mutating func remove(at offsets: IndexSet) -> Bool {
        let curId = current?.id
        let removedCurrent = offsets.contains(index)
        let before = offsets.filter { $0 < index }.count
        let removedIds = Set(offsets.compactMap { tracks.indices.contains($0) ? tracks[$0].id : nil })
        for i in offsets.sorted(by: >) where tracks.indices.contains(i) { tracks.remove(at: i) }
        original.removeAll { removedIds.contains($0.id) }
        if tracks.isEmpty { index = 0; return curId != nil }
        if removedCurrent {
            index = min(index - before, tracks.count - 1)
            return true
        }
        index -= before
        return false
    }

    /// Drag-reorder (SwiftUI `onMove` semantics). The current track keeps playing wherever it lands.
    public mutating func move(fromOffsets source: IndexSet, toOffset destination: Int) {
        let curId = current?.id
        let moving = source.sorted().compactMap { tracks.indices.contains($0) ? tracks[$0] : nil }
        var rest: [TrackCard] = []
        var insertAt = destination
        for (i, t) in tracks.enumerated() {
            if source.contains(i) {
                if i < destination { insertAt -= 1 }
            } else {
                rest.append(t)
            }
        }
        rest.insert(contentsOf: moving, at: max(0, min(insertAt, rest.count)))
        tracks = rest
        if let curId, let i = tracks.firstIndex(where: { $0.id == curId }) { index = i }
    }

    /// Clears everything after the current track.
    public mutating func clearUpcoming() {
        guard !tracks.isEmpty else { return }
        let dropped = Set(tracks[(index + 1)...].map(\.id))
        tracks.removeSubrange((index + 1)...)
        original.removeAll { dropped.contains($0.id) }
    }

    /// Server queue body (`PUT /media/music/queue`).
    public func input(positionSec: Double) -> MusicQueueInput {
        MusicQueueInput(trackIds: tracks.map(\.id), index: index, positionSec: positionSec, shuffle: shuffled,
                        repeat: MusicQueueInputRepeat(rawValue: repeatMode.rawValue))
    }
}

/// Sleep timer: a fixed number of minutes, or "end of the current track".
public enum SleepTimer: Sendable, Equatable {
    case off
    case minutes(Int, endsAt: Date)
    case endOfTrack

    public static let choices = [15, 30, 45, 60]

    public static func start(minutes: Int, now: Date = .now) -> SleepTimer {
        .minutes(minutes, endsAt: now.addingTimeInterval(TimeInterval(minutes * 60)))
    }

    public var isActive: Bool { self != .off }

    /// Seconds left (nil for off / end of track).
    public func remaining(now: Date = .now) -> TimeInterval? {
        if case .minutes(_, let end) = self { return max(0, end.timeIntervalSince(now)) }
        return nil
    }

    /// Whether playback should pause now (time reached), given the clock.
    public func expired(now: Date = .now) -> Bool {
        if case .minutes(_, let end) = self { return now >= end }
        return false
    }

    /// Volume factor for a gentle fade over the last `fadeSec` seconds of a timed sleep (1 = full).
    public func fadeFactor(now: Date = .now, fadeSec: TimeInterval = 20) -> Float {
        guard let left = remaining(now: now), left < fadeSec else { return 1 }
        return Float(max(0, left / fadeSec))
    }
}
