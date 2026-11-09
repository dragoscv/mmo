import SwiftUI
import WatchConnectivity
import WatchKit
import WidgetKit

/// MixAI Key & BPM for Apple Watch (WP18-05): independent app with its own mic + Rust engine (aarch64 watchOS, classic
/// key path), mirror of the iPhone over WatchConnectivity, haptic beat, wrist tap / Double Tap tempo, complications.
@main
struct KeyBpmWatchApp: App {
    @State private var model = WatchListen.shared

    var body: some Scene {
        WindowGroup {
            WatchRoot().environment(model)
                .task { model.applyScreenshotHook() }
        }
    }
}

enum WatchSource { case none, watch, phone }

/// Watch session (port of Android `WearListen`).
@MainActor @Observable
final class WatchListen: NSObject, WCSessionDelegate {
    static let shared = WatchListen()

    private(set) var source: WatchSource = .none
    private(set) var keyIndex: Int?
    private(set) var keyLocked = false
    private(set) var bpm: Double?
    private(set) var tempoLocked = false
    private(set) var tapBpm: Double?
    private(set) var levelLow = false
    private(set) var micFailed = false
    private(set) var phoneListening = false
    private(set) var title: String?
    private(set) var keyChange: Int?
    var haptics: Bool { didSet { KeyBpmGroup.defaults.set(haptics, forKey: "haptics"); syncHaptics() } }

    var shownBpm: Double? { tapBpm ?? bpm }
    var active: Bool { source != .none }

    @ObservationIgnored private let mic = MicCapture()
    @ObservationIgnored private let engine = EngineBox()
    @ObservationIgnored let clock = BeatClockBox()
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var phoneTimeout: Task<Void, Never>?
    @ObservationIgnored private var hapticTask: Task<Void, Never>?
    @ObservationIgnored private var taps: [TimeInterval] = []
    @ObservationIgnored private var lastKey: Int?

    private override init() {
        haptics = KeyBpmGroup.defaults.bool(forKey: "haptics")
        super.init()
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
    }

    // MARK: own mic
    func startWatch() async {
        guard source != .watch else { return }
        guard await MicCapture.requestPermission() else { micFailed = true; return }
        let engine = self.engine
        do { try mic.start { p, n in engine.push(p, count: n) } } catch { micFailed = true; return }
        engine.make(sampleRate: mic.sampleRate, a4: 440)
        mic.onLost = { [weak self] in Task { @MainActor in self?.stopWatch() } }
        clock.stop()
        source = .watch
        keyIndex = nil; bpm = nil; keyLocked = false; tempoLocked = false; micFailed = false; tapBpm = nil; title = nil; keyChange = nil
        lastKey = nil
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                self?.tick()
            }
        }
        syncHaptics()
    }

    func stopWatch() {
        poll?.cancel(); poll = nil
        mic.stop()
        engine.close()
        clock.stop()
        source = phoneListening ? .phone : .none
        syncHaptics()
    }

    private func tick() {
        guard let r = engine.read() else { return }
        var change: Int?
        if r.keyChanged, let k = r.keyIndex, let lk = lastKey, k != lk { change = k }
        if let k = r.keyIndex { lastKey = k }
        if let b = r.bpm, tapBpm == nil { clock.update(bpm: b, nextIn: r.nextBeatIn, now: ProcessInfo.processInfo.systemUptime) }
        keyIndex = r.keyIndex; keyLocked = r.keyLocked; bpm = r.bpm; tempoLocked = r.tempoLocked; levelLow = r.levelDbfs < -55
        if let change { keyChange = change; keyChangeBuzz() }
        if r.keyLocked, r.tempoLocked, let k = r.keyIndex, let b = r.bpm, LastReading.save(LastReading(keyIndex: k, bpm: b, at: .now)) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        syncHaptics()
    }

    // MARK: phone mirror
    private func onPhone(_ r: WearLink.Reading) {
        phoneTimeout?.cancel()
        guard r.listening else {
            phoneListening = false
            if source == .phone { source = .none; clock.stop(); syncHaptics() }
            return
        }
        phoneTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            self?.onPhone(WearLink.Reading(listening: false))
        }
        phoneListening = true
        if source == .watch { return }
        let change = source == .phone && r.keyIndex != nil && keyIndex != nil && r.keyIndex != keyIndex && r.keyLocked ? r.keyIndex : nil
        if let b = r.bpm, let next = r.nextBeatMs, tapBpm == nil {
            let age = min(2000, max(0, Double(Int64(Date.now.timeIntervalSince1970 * 1000) - r.atMillis)))
            var n = Double(next) - age
            if n < 0 { n = n.truncatingRemainder(dividingBy: 60_000 / b) + 60_000 / b }
            clock.update(bpm: b, nextIn: n / 1000, now: ProcessInfo.processInfo.systemUptime)
        }
        source = .phone
        keyIndex = r.keyIndex; keyLocked = r.keyLocked; bpm = r.bpm; tempoLocked = r.tempoLocked; title = r.title; levelLow = false
        if let change { keyChange = change; keyChangeBuzz() }
        if r.keyLocked, r.tempoLocked, LastReading.save(LastReading(keyIndex: r.keyIndex, bpm: r.bpm, at: .now, title: r.title)) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        syncHaptics()
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let line = message[WearLink.lineKey] as? String, let r = WearLink.decode(line) else { return }
        Task { @MainActor in self.onPhone(r) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext ctx: [String: Any]) {
        guard let line = ctx[WearLink.lineKey] as? String, let r = WearLink.decode(line) else { return }
        Task { @MainActor in
            if LastReading.save(LastReading(keyIndex: r.keyIndex, bpm: r.bpm, at: .now, title: r.title)) { WidgetCenter.shared.reloadAllTimelines() }
        }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    // MARK: tap tempo + haptics
    /// Wrist tap / Double Tap: two or more taps set the BPM, the beat lands on the last tap.
    func tap() {
        let t = ProcessInfo.processInfo.systemUptime
        taps.append(t)
        taps = Array(taps.suffix(12))
        guard let b = Harmony.tapBpm(taps) else { return }
        clock.update(bpm: b, nextIn: 60 / b, now: t)
        tapBpm = b
        syncHaptics()
    }

    func clearTap() {
        taps = []
        tapBpm = nil
        if bpm == nil { clock.stop() }
        syncHaptics()
    }

    func dismissKeyChange() { keyChange = nil; micFailed = false }

    /// Store screenshots from the Simulator (scripts/keybpm-watch-shots.sh): `-KBShot live|phone|tap|controls`
    /// `-KBShotKey <0-23>` `-KBShotBpm <bpm>` seed a locked reading without a microphone. No effect otherwise.
    private(set) var shotPage = 0
    func applyScreenshotHook() {
        let d = UserDefaults.standard
        guard let mode = d.string(forKey: "KBShot") else { return }
        let k = d.object(forKey: "KBShotKey") == nil ? nil : d.integer(forKey: "KBShotKey")
        let b = d.object(forKey: "KBShotBpm") == nil ? nil : d.double(forKey: "KBShotBpm")
        keyIndex = k; bpm = b; keyLocked = k != nil; tempoLocked = b != nil
        switch mode {
        case "phone": source = .phone; phoneListening = true; title = "Endless Summer \u{2014} The Midnight"
        case "tap": source = .none; tapBpm = b
        case "controls": source = .none; haptics = true; shotPage = 1
        default: source = .watch
        }
        if let b { clock.update(bpm: b, nextIn: 0.2, now: ProcessInfo.processInfo.systemUptime) }
    }

    /// Beat haptic: every beat while it is >= 0.45 s apart (watchOS drops closer haptics), otherwise downbeats only.
    private func syncHaptics() {
        let want = haptics && (active || tapBpm != nil)
        if !want { hapticTask?.cancel(); hapticTask = nil; return }
        guard hapticTask == nil else { return }
        let clock = self.clock
        hapticTask = Task.detached(priority: .userInitiated) {
            while !Task.isCancelled {
                guard let (wait, index, period) = clock.nextBeat(now: ProcessInfo.processInfo.systemUptime) else {
                    try? await Task.sleep(for: .milliseconds(100)); continue
                }
                if wait > 0.004 { try? await Task.sleep(for: .seconds(wait)); continue }
                clock.consume()
                let downbeat = index % 4 == 0
                if downbeat || period >= 0.45 {
                    await MainActor.run { WKInterfaceDevice.current().play(downbeat ? .start : .click) }
                }
            }
        }
    }

    private func keyChangeBuzz() {
        WKInterfaceDevice.current().play(.notification)
    }
}

extension BeatClockBox {
    /// (seconds until the next beat, its index, period) or nil when stopped.
    func nextBeat(now: TimeInterval) -> (TimeInterval, Int, TimeInterval)? { withClock { c in c.untilNext(now: now).map { ($0, c.index, c.period) } } }
    func consume() { withClock { c in _ = c.consume() } }
}
