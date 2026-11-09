import Foundation

/// Pure music helpers (port of Android `ro.mixai.listen.Harmony`, same results; shared by app, watch, widgets).
/// Key index = tonic pitch class (C = 0) + 12 when minor, the `mixai-listen` scheme (A minor = 21 = 8A).
enum Harmony {
    static let notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

    static func tonic(_ i: Int) -> Int { ((i % 12) + 12) % 12 }
    static func isMinor(_ i: Int) -> Bool { i >= 12 }
    static func index(_ tonic: Int, minor: Bool) -> Int { ((tonic % 12) + 12) % 12 + (minor ? 12 : 0) }
    static func noteName(_ pc: Int) -> String { notes[((pc % 12) + 12) % 12] }
    static func keyName(_ i: Int) -> String { noteName(tonic(i)) + (isMinor(i) ? "m" : "") }

    static func camelotNumber(_ i: Int) -> Int {
        let t = isMinor(i) ? tonic(i) + 3 : tonic(i)
        return ((7 * t + 7) % 12 + 12) % 12 + 1
    }

    static func camelot(_ i: Int) -> String { "\(camelotNumber(i))\(isMinor(i) ? "A" : "B")" }

    /// Open Key notation (1d..12d / 1m..12m), same table as mixai-listen notation.rs (8A = A minor = 1m).
    static func openKey(_ i: Int) -> String { "\((camelotNumber(i) + 4) % 12 + 1)\(isMinor(i) ? "m" : "d")" }

    private static let majorSpelling = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
    private static let minorSpelling = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]

    /// Musical short name as the engine spells it ("Am", "Eb", "F#m").
    static func musicalName(_ i: Int) -> String {
        isMinor(i) ? minorSpelling[tonic(i)] + "m" : majorSpelling[tonic(i)]
    }

    /// Long name ("A minor", "Eb major").
    static func longName(_ i: Int) -> String {
        isMinor(i) ? minorSpelling[tonic(i)] + " minor" : majorSpelling[tonic(i)] + " major"
    }

    /// Index from a Camelot label ("8A", "12B"), nil when malformed.
    static func fromCamelot(_ s: String) -> Int? {
        let t = s.trimmingCharacters(in: .whitespaces).uppercased()
        guard let letter = t.last, letter == "A" || letter == "B", let n = Int(t.dropLast()), (1...12).contains(n) else { return nil }
        return (0..<24).first { camelotNumber($0) == n && isMinor($0) == (letter == "A") }
    }

    enum Relation: String, Sendable { case same, relative, adjacent, energyBoost = "energy_boost", wholeStep = "whole_step", diagonal, clash }

    /// Same scores as mixai-listen `compatible_keys`: all keys with score > 0, best first (stable on ties).
    static func compatibleKeys(_ i: Int) -> [(key: Int, relation: Relation, score: Double)] {
        let n = camelotNumber(i), m = isMinor(i)
        let all: [(Int, Relation, Double)] = (0..<24).map { k in
            let kn = camelotNumber(k), km = isMinor(k)
            let d = min(((n - kn) % 12 + 12) % 12, ((kn - n) % 12 + 12) % 12)
            if kn == n { return km == m ? (k, .same, 1.0) : (k, .relative, 0.92) }
            if km == m {
                switch d {
                case 1: return (k, .adjacent, 0.85)
                case 5: return (k, .energyBoost, 0.6)
                case 2: return (k, .wholeStep, 0.45)
                default: return (k, .clash, 0)
                }
            }
            return d == 1 ? (k, .diagonal, 0.55) : (k, .clash, 0)
        }
        return all.enumerated().filter { $0.element.2 > 0 }
            .sorted { $0.element.2 != $1.element.2 ? $0.element.2 > $1.element.2 : $0.offset < $1.offset }
            .map { (key: $0.element.0, relation: $0.element.1, score: $0.element.2) }
    }

    /// "Mix next" chips: compatible keys without same/clash, first `limit`, with the Android label id.
    static func mixNextLabels(_ i: Int, limit: Int = 5) -> [(key: Int, label: String)] {
        compatibleKeys(i).filter { $0.relation != .same && $0.relation != .clash }.prefix(limit).map { c in
            let label: String
            switch c.relation {
            case .relative: label = "mix.relative"
            case .adjacent: label = ((camelotNumber(c.key) - camelotNumber(i)) % 12 + 12) % 12 == 11 ? "mix.down" : "mix.up"
            case .energyBoost: label = "mix.boost"
            case .diagonal, .wholeStep: label = "mix.diagonal"
            default: label = "mix.same"
            }
            return (c.key, label)
        }
    }

    static func wheelDistance(_ a: Int, _ b: Int) -> Int {
        let na = camelotNumber(a), nb = camelotNumber(b)
        let ring = min(((na - nb) % 12 + 12) % 12, ((nb - na) % 12 + 12) % 12)
        let letter = isMinor(a) == isMinor(b) ? 0 : 1
        if ring == 0 { return letter }
        return letter == 0 ? ring : ring + 1
    }

    static func transpose(_ i: Int, _ semis: Int) -> Int { index(tonic(i) + semis, minor: isMinor(i)) }
    static func semitonesForRate(_ pct: Double) -> Double { 12 * log2(1 + pct / 100) }

    static func tempoMatchPercent(live: Double, track: Double) -> Double {
        guard live > 0, track > 0 else { return 0 }
        return [track, track * 2, track / 2].map { (live / $0 - 1) * 100 }.min { abs($0) < abs($1) } ?? 0
    }

    struct MixAdvice: Equatable { var ratePercent: Double; var keyAtRate: Int?; var transpose: Int; var keyAfter: Int; var distance: Int }

    static func mixAdvice(liveKey: Int, liveBpm: Double, trackKey: Int, trackBpm: Double) -> MixAdvice {
        let rate = tempoMatchPercent(live: liveBpm, track: trackBpm)
        let shift = Int(semitonesForRate(rate).rounded())
        let atRate = shift != 0 ? transpose(trackKey, shift) : nil
        let best = (-2...2).min { a, b in
            let da = wheelDistance(liveKey, transpose(trackKey, a)), db = wheelDistance(liveKey, transpose(trackKey, b))
            return da != db ? da < db : abs(a) < abs(b)
        } ?? 0
        let after = transpose(trackKey, best)
        return MixAdvice(ratePercent: rate, keyAtRate: atRate, transpose: best, keyAfter: after, distance: wheelDistance(liveKey, after))
    }

    private static let majorSteps = [0, 2, 4, 5, 7, 9, 11]
    private static let minorSteps = [0, 2, 3, 5, 7, 8, 10]

    static func scale(_ i: Int) -> [String] { (isMinor(i) ? minorSteps : majorSteps).map { noteName(tonic(i) + $0) } }

    static func chords(_ i: Int) -> [String] {
        let q = isMinor(i) ? ["m", "dim", "", "m", "m", "", ""] : ["", "m", "m", "", "", "m", "dim"]
        return (isMinor(i) ? minorSteps : majorSteps).enumerated().map { noteName(tonic(i) + $0.element) + q[$0.offset] }
    }

    static func singerTranspose(songKey: Int, voiceCentreMidi: Int) -> Int {
        let d = (((voiceCentreMidi % 12) - tonic(songKey)) % 12 + 12) % 12
        return d > 5 ? d - 12 : d
    }

    static func voiceCentre(_ notes: [Int]) -> Int? {
        guard notes.count >= 5 else { return nil }
        let s = notes.sorted(), cut = s.count / 10
        let core = Array(s[cut..<(s.count - cut)])
        return core[core.count / 2]
    }

    static func capo(_ key: Int) -> (fret: Int, shape: Int) {
        let easy = isMinor(key) ? [4, 9, 2] : [7, 0, 2, 4, 9]
        for fret in 0...7 {
            let shape = tonic(key) - fret
            if easy.contains(((shape % 12) + 12) % 12) { return (fret, index(shape, minor: isMinor(key))) }
        }
        return (0, key)
    }

    static func tapBpm(_ taps: [TimeInterval]) -> Double? {
        guard !taps.isEmpty else { return nil }
        // Tail where consecutive gaps are <= 2 s (a pause starts a new tempo), then the last 9 taps.
        var start = taps.count - 1
        while start > 0, taps[start] - taps[start - 1] <= 2 { start -= 1 }
        let recent = Array(taps[start...].suffix(9))
        var gaps: [Double] = []
        for i in 1..<max(1, recent.count) where recent[i] - recent[i - 1] > 0 { gaps.append(recent[i] - recent[i - 1]) }
        guard gaps.count >= 2 else { return nil }
        let median = gaps.sorted()[gaps.count / 2]
        let good = gaps.filter { abs($0 - median) <= median * 0.3 }
        guard good.count >= 2 else { return nil }
        let bpm = 60 / (good.reduce(0, +) / Double(good.count))
        return (40...300).contains(bpm) ? bpm : nil
    }
}

/// Tempo drift alarm (bands / drummers): warns after the BPM stays > threshold % off the reference for `hold` s.
struct DriftMonitor: Sendable {
    var thresholdPercent = 0.5
    var hold: TimeInterval = 3
    private(set) var reference: Double?
    private var outsideSince: TimeInterval?

    mutating func setReference(_ bpm: Double?) { reference = bpm; outsideSince = nil }

    /// Drift in percent while alarming, else nil. The first reading becomes the reference.
    mutating func update(bpm: Double, now: TimeInterval) -> Double? {
        guard let ref = reference else { reference = bpm; return nil }
        let drift = (bpm / ref - 1) * 100
        if abs(drift) <= thresholdPercent { outsideSince = nil; return nil }
        let since = outsideSince ?? now
        outsideSince = since
        return now - since >= hold ? drift : nil
    }
}

/// Beat grid from "next beat in X s at BPM" snapshots (port of Android BeatClock, same confirm-before-resync rule:
/// the engine's phase swings by up to ~40 % of a beat and comes back; resyncing on each swing skipped beats).
struct BeatClock {
    private(set) var period: TimeInterval = 0
    private var next: TimeInterval = 0
    private(set) var index = 0
    private(set) var skips = 0
    private var pendingErr: TimeInterval?
    private var pendingSince: TimeInterval = 0
    var running: Bool { period > 0 }
    private var late: TimeInterval { max(0.06, period * 0.4) }

    mutating func stop() { period = 0; pendingErr = nil }

    mutating func update(bpm: Double, nextIn: TimeInterval, now: TimeInterval) {
        guard bpm > 0 else { stop(); return }
        let p = 60 / bpm, observed = now + nextIn
        if !running { period = p; next = observed; index = 0; pendingErr = nil; return }
        period = p
        while next < now - late { next += period; index += 1; skips += 1 }
        var err = observed - next
        if err > period / 2 { err -= period }
        if err < -period / 2 { err += period }
        if abs(err) <= period / 4 { pendingErr = nil; next += err * 0.25; return }
        if let pe = pendingErr, abs(err - pe) <= period / 8, now - pendingSince >= 0.25 {
            next += err; pendingErr = nil
        } else if pendingErr == nil || abs(err - (pendingErr ?? 0)) > period / 8 {
            pendingErr = err; pendingSince = now
        }
    }

    mutating func untilNext(now: TimeInterval) -> TimeInterval? {
        guard running else { return nil }
        while next < now - late { next += period; index += 1; skips += 1 }
        return max(0, next - now)
    }

    mutating func consume() -> Int { let i = index; next += period; index += 1; return i }
}

/// Thread-safe BeatClock shared by the wheel pulse, haptics and the Live Activity (any thread).
final class BeatClockBox: @unchecked Sendable {
    private let lock = NSLock()
    private var clock = BeatClock()
    var box: BeatClockBox { self }

    func update(bpm: Double, nextIn: TimeInterval, now: TimeInterval) { withClock { $0.update(bpm: bpm, nextIn: nextIn, now: now) } }
    func stop() { withClock { $0.stop() } }

    func withClock<T>(_ body: (inout BeatClock) -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body(&clock)
    }

    /// 0…1 beat pulse for drawing: 1 on the beat, decaying over 180 ms.
    func pulse(now: TimeInterval) -> Double {
        withClock { c in
            guard c.running, let until = c.untilNext(now: now) else { return 0 }
            let since = c.period - until
            return since < 0.18 ? 1 - since / 0.18 : 0
        }
    }
}
