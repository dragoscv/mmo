import Foundation

/// Per-key leading + trailing throttle (pure, clock passed in). The first value of a key goes out at once; values
/// offered within `interval` are held, and the newest (merged) one is released by `due(now:)` when the window ends.
/// Used for sliders: the protocol allows 200 msg/s per client, the apps send at most one per key per 30 ms.
public struct Throttle<Value: Sendable>: Sendable {
    public let interval: Double
    private var lastSent: [String: Double] = [:]
    private var pending: [String: Value] = [:]

    public init(interval: Double) { self.interval = interval }

    /// Returns the value when it may be sent now, nil when it was held (merged into the pending one).
    public mutating func offer(key: String, value: Value, now: Double, merge: (Value, Value) -> Value = { _, new in new }) -> Value? {
        if let last = lastSent[key], now - last < interval {
            pending[key] = pending[key].map { merge($0, value) } ?? value
            return nil
        }
        lastSent[key] = now
        pending[key] = nil
        return value
    }

    /// Held values whose window has elapsed (they count as sent now).
    public mutating func due(now: Double) -> [Value] {
        var out: [Value] = []
        for (k, v) in pending.sorted(by: { $0.key < $1.key }) where now - (lastSent[k] ?? 0) >= interval {
            out.append(v)
            pending[k] = nil
            lastSent[k] = now
        }
        return out
    }

    public var hasPending: Bool { !pending.isEmpty }

    /// Drop a held value (e.g. a discrete command for the same target superseded it).
    public mutating func cancel(key: String) { pending[key] = nil }

    public mutating func reset() { lastSent = [:]; pending = [:] }
}
