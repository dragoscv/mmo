import Foundation

// 1:1 port of server/src/hub/sync-math.ts via tv-android SyncMath.kt — keep the constants identical.
//   offset = ((t1 - t0) + (t2 - t3)) / 2, RTT = (t3 - t0) - (t2 - t1)
//   keep the 8 latest samples, trust the lowest RTT, smooth with EMA α = 0.4.

public struct ClockSample: Sendable, Equatable {
    public let offsetMs: Double
    public let rttMs: Double
    public init(offsetMs: Double, rttMs: Double) { self.offsetMs = offsetMs; self.rttMs = rttMs }
}

public func sampleFrom(t0: Double, t1: Double, t2: Double, t3: Double) -> ClockSample {
    ClockSample(offsetMs: ((t1 - t0) + (t2 - t3)) / 2, rttMs: max(0, (t3 - t0) - (t2 - t1)))
}

public struct ClockEstimator: Sendable {
    private let window: Int
    private let alpha: Double
    private var samples: [ClockSample] = []
    private var ema: Double?

    public init(window: Int = 8, alpha: Double = 0.4) {
        self.window = window
        self.alpha = alpha
    }

    public mutating func add(_ s: ClockSample) {
        samples.append(s)
        if samples.count > window { samples.removeFirst() }
        guard let b = best else { return }
        ema = ema.map { $0 + alpha * (b.offsetMs - $0) } ?? b.offsetMs
    }

    /// Lowest-RTT sample (first one wins ties, like the Kotlin fold).
    public var best: ClockSample? {
        samples.reduce(nil as ClockSample?) { a, s in (a == nil || s.rttMs < a!.rttMs) ? s : a }
    }

    /// serverTime ≈ localTime + offset
    public var offsetMs: Double { ema ?? 0 }
    public var rttMs: Double { best?.rttMs ?? 0 }
    public var count: Int { samples.count }
}

/// `positionSec` was true at server time `atServerMs`.
public struct PlaybackAnchor: Sendable, Equatable {
    public let playing: Bool
    public let positionSec: Double
    public let atServerMs: Double
    public let rate: Double?
    public init(playing: Bool, positionSec: Double, atServerMs: Double, rate: Double? = nil) {
        self.playing = playing
        self.positionSec = positionSec
        self.atServerMs = atServerMs
        self.rate = rate
    }
}

public func expectedPosition(_ a: PlaybackAnchor, serverNowMs: Double) -> Double {
    guard a.playing else { return a.positionSec }
    return a.positionSec + max(0, serverNowMs - a.atServerMs) / 1000 * (a.rate ?? 1)
}

public enum DriftAction: Sendable, Equatable {
    case none
    case rate(Double)
    case seek(Double)
}

public let driftStartMs = 120.0
public let driftStopMs = 40.0
public let driftSeekMs = 1500.0

/// JavaScript `Math.round` (half rounds towards +∞).
func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

/// Hysteresis drift correction (drift = actual - expected; positive = ahead → slow down).
public func driftAction(actualSec: Double, expectedSec: Double, correcting: Bool) -> DriftAction {
    let driftMs = (actualSec - expectedSec) * 1000
    let a = abs(driftMs)
    if a >= driftSeekMs { return .seek(expectedSec) }
    if a < driftStopMs || (!correcting && a < driftStartMs) { return .none }
    let rate = 1 - max(-0.05, min(0.05, driftMs / 1000 / 4))
    return .rate(jsRound(rate * 1000) / 1000)
}

/// Lead time for a scheduled command: slowest RTT + 150 ms, clamped 150..2000 ms.
public func leadTimeMs(_ rtts: [Double]) -> Int {
    let mx = rtts.max() ?? 0
    return max(150, min(2000, Int(jsRound(mx + 150))))
}

/// Stateful wrapper remembering whether a rate correction is in progress.
public struct DriftCorrector: Sendable {
    public private(set) var correcting = false
    public init() {}
    public mutating func update(actualSec: Double, expectedSec: Double) -> DriftAction {
        let act = driftAction(actualSec: actualSec, expectedSec: expectedSec, correcting: correcting)
        if case .rate = act { correcting = true } else { correcting = false }
        return act
    }
    public mutating func reset() { correcting = false }
}
