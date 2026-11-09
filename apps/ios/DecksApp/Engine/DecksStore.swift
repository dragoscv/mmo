import DecksFFI
import Foundation
import Observation
import QuartzCore

/// Owns the Rust engine (`DecksEngine`, decks-ffi) and mirrors its polled snapshot for SwiftUI.
/// Every FFI call happens here on the main actor; the audio callback stays on the engine's own thread.
@MainActor
@Observable
final class DecksStore {
    nonisolated static let deckCount = 2
    nonisolated static let tempoRanges: [Double] = [0.06, 0.08, 0.16, 0.5]
    nonisolated static let loopSizes: [Double] = [0.25, 0.5, 1, 2, 4, 8, 16, 32]

    let engine: DecksEngine

    private(set) var snapshot: EngineSnapshot?
    private(set) var running = false
    private(set) var startInfo: EngineStartInfo?
    private(set) var loads: [Int: LoadStatus] = [:]
    private(set) var trackInfo: [TrackInfo?] = Array(repeating: nil, count: deckCount)
    var lastError: String?
    var rendererFailure: String?

    var tempoRange: Double = 0.08
    var loopBeats: [Double] = Array(repeating: 4, count: deckCount)
    var jumpBeats: [Double] = Array(repeating: 4, count: deckCount)
    /// Normalised (0…1) knob positions the engine does not report back.
    var eq: [[Double]] = Array(repeating: [0.5, 0.5, 0.5], count: deckCount)
    var filter: [Double] = Array(repeating: 0.5, count: deckCount)
    var headphoneMix: Double = 0.5
    var reduceMotion = false
    var zoomSeconds: Float = 8

    // Hot path for the renderer (not observed: read at display rate).
    @ObservationIgnored private(set) var latest: EngineSnapshot?
    @ObservationIgnored private var latestAt: CFTimeInterval = 0
    @ObservationIgnored private var peaks: [WaveformPeaks?] = Array(repeating: nil, count: deckCount)
    @ObservationIgnored private(set) var peaksVersion: [Int] = Array(repeating: 0, count: deckCount)
    @ObservationIgnored private var grids: [RenderGrid?] = Array(repeating: nil, count: deckCount)
    @ObservationIgnored private var tickets: [UInt64: Int] = [:]
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var bendBase: [Double?] = Array(repeating: nil, count: deckCount)

    init() {
        engine = DecksEngine(config: DecksEngineConfig(sampleRate: nil, bufferFrames: nil, outputDeviceId: nil))
    }

    // MARK: lifecycle

    func startEngine() {
        guard !running else { return }
        do {
            try AudioSessionConfig.activate()
            startInfo = try engine.start()
            running = true
            applyRouting()
        } catch {
            lastError = error.localizedDescription
        }
        startPolling()
    }

    func stopEngine() {
        engine.stop()
        running = false
    }

    private func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.tick()
                try? await Task.sleep(for: .milliseconds(33))
            }
        }
    }

    /// Polls the engine (well under 1 ms per call) and advances pending loads.
    func tick() {
        let s = engine.snapshot()
        latest = s
        latestAt = CACurrentMediaTime()
        if snapshot != s { snapshot = s }
        if running != s.running { running = s.running }
        for (ticket, deck) in tickets {
            guard let status = engine.loadStatus(ticket: ticket) else { continue }
            loads[deck] = status
            switch status.state {
            case .ready:
                tickets[ticket] = nil
                finishLoad(deck)
            case .failed:
                tickets[ticket] = nil
                lastError = status.error
            case .cancelled:
                tickets[ticket] = nil
            case .queued, .decoding, .analysing:
                break
            }
        }
    }

    func deck(_ i: Int) -> DeckSnapshot? {
        guard let s = snapshot, i < s.decks.count else { return nil }
        return s.decks[i]
    }

    // MARK: load

    func load(deck: Int, path: String) {
        do {
            let ticket = try engine.load(deck: UInt8(deck), path: path)
            tickets[ticket] = deck
            loads[deck] = engine.loadStatus(ticket: ticket)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func isLoading(_ deck: Int) -> Bool {
        guard let st = loads[deck]?.state else { return false }
        return st == .queued || st == .decoding || st == .analysing
    }

    private func finishLoad(_ deck: Int) {
        let d = UInt8(deck)
        trackInfo[deck] = try? engine.trackInfo(deck: d)
        if let p = try? engine.peaks(deck: d) {
            peaks[deck] = p
            peaksVersion[deck] += 1
        }
        if let g = try? engine.beatgrid(deck: d), g.bpm > 0 {
            let downbeat = g.firstBeatSec + Double(g.downbeatOffsetBeats) * 60 / g.bpm
            grids[deck] = RenderGrid(bpm: g.bpm, firstDownbeatSec: downbeat, beatsPerBar: 4)
        } else {
            grids[deck] = nil
        }
        eq[deck] = [0.5, 0.5, 0.5]
        filter[deck] = 0.5
    }

    // MARK: transport

    private func run(_ body: () throws -> Void) {
        do { try body() } catch { lastError = error.localizedDescription }
    }

    func togglePlay(_ deck: Int) {
        let d = UInt8(deck)
        run { if self.deck(deck)?.playing == true { try engine.pause(deck: d) } else { try engine.play(deck: d) } }
    }

    func cue(_ deck: Int, pressed: Bool) { run { try engine.cue(deck: UInt8(deck), pressed: pressed) } }

    func hotCue(_ deck: Int, slot: Int) {
        let set = self.deck(deck).map { slot < $0.hotCues.count && $0.hotCues[slot] != nil } ?? false
        run {
            if set { try engine.hotCueJump(deck: UInt8(deck), slot: UInt8(slot)) } else { try engine.hotCueSet(deck: UInt8(deck), slot: UInt8(slot)) }
        }
    }

    func deleteHotCue(_ deck: Int, slot: Int) { run { try engine.hotCueDelete(deck: UInt8(deck), slot: UInt8(slot)) } }

    func loopToggleAuto(_ deck: Int) {
        let d = UInt8(deck)
        run {
            if self.deck(deck)?.loopActive == true { try engine.loopExit(deck: d) } else { try engine.loopAuto(deck: d, beats: loopBeats[deck]) }
        }
    }

    func loopHalve(_ deck: Int) {
        if self.deck(deck)?.loopActive == true {
            run { try engine.loopHalve(deck: UInt8(deck)) }
        }
        loopBeats[deck] = max(Self.loopSizes.first ?? 0.25, loopBeats[deck] / 2)
    }

    func loopDouble(_ deck: Int) {
        if self.deck(deck)?.loopActive == true {
            run { try engine.loopDouble(deck: UInt8(deck)) }
        }
        loopBeats[deck] = min(Self.loopSizes.last ?? 32, loopBeats[deck] * 2)
    }

    func beatJump(_ deck: Int, forward: Bool) {
        let beats = jumpBeats[deck] * (forward ? 1 : -1)
        run { try engine.beatJump(deck: UInt8(deck), beats: beats) }
    }

    /// Tempo fader position −1…1 → ratio within the selected range.
    func setTempoFader(_ deck: Int, _ fader: Double) {
        let ratio = 1 + min(1, max(-1, fader)) * tempoRange
        run { try engine.setTempo(deck: UInt8(deck), ratio: ratio) }
    }

    func tempoFader(_ deck: Int) -> Double {
        guard let t = self.deck(deck)?.tempo, tempoRange > 0 else { return 0 }
        return min(1, max(-1, (t - 1) / tempoRange))
    }

    func toggleKeyLock(_ deck: Int) {
        let on = !(self.deck(deck)?.keyLock ?? false)
        run { try engine.setKeyLock(deck: UInt8(deck), on: on) }
    }

    func shiftKey(_ deck: Int, by semitones: Double) {
        let now = self.deck(deck)?.keyShiftSemitones ?? 0
        let next = min(12, max(-12, now + semitones))
        run { try engine.setKeyShift(deck: UInt8(deck), semitones: next) }
    }

    func resetKey(_ deck: Int) { run { try engine.setKeyShift(deck: UInt8(deck), semitones: 0) } }

    func keyMatch(_ deck: Int) { run { _ = try engine.keyMatch(deck: UInt8(deck)) } }

    /// Tap = one-shot beat sync to the master; the lock is a separate toggle.
    func syncTap(_ deck: Int) { run { try engine.phaseSync(deck: UInt8(deck), lockOn: false) } }

    func toggleSyncLock(_ deck: Int) {
        let on = !(self.deck(deck)?.syncLock ?? false)
        run {
            if on { try engine.phaseSync(deck: UInt8(deck), lockOn: true) }
            try engine.setSyncLock(deck: UInt8(deck), on: on)
        }
    }

    func toggleQuantize(_ deck: Int) {
        let on = !(self.deck(deck)?.quantize ?? false)
        run { try engine.setQuantize(deck: UInt8(deck), on: on) }
    }

    func toggleSlip(_ deck: Int) {
        let on = !(self.deck(deck)?.slip ?? false)
        run { try engine.setSlip(deck: UInt8(deck), on: on) }
    }

    /// Jog: paused = scrub (seek), playing = temporary pitch bend.
    func jog(_ deck: Int, delta: Double, touching: Bool) {
        guard let d = self.deck(deck), d.loaded else { return }
        if d.playing {
            if touching {
                if bendBase[deck] == nil { bendBase[deck] = d.tempo }
                let base = bendBase[deck] ?? 1
                let bend = min(0.08, max(-0.08, delta * 0.002))
                run { try engine.setTempo(deck: UInt8(deck), ratio: base * (1 + bend)) }
            } else if let base = bendBase[deck] {
                bendBase[deck] = nil
                run { try engine.setTempo(deck: UInt8(deck), ratio: base) }
            }
        } else if touching {
            let target = min(d.durationSec, max(0, d.playheadSec + delta * 0.01))
            run { try engine.seek(deck: UInt8(deck), positionSec: target) }
        }
    }

    func seek(_ deck: Int, fraction: Double) {
        guard let d = self.deck(deck), d.loaded, d.durationSec > 0 else { return }
        run { try engine.seek(deck: UInt8(deck), positionSec: min(1, max(0, fraction)) * d.durationSec) }
    }

    // MARK: mixer

    /// EQ knob 0…1 → dB (0.5 = flat, 0 = kill −26 dB, 1 = +6 dB).
    static func eqDb(_ v: Double) -> Float {
        Float(v < 0.5 ? -26 + v / 0.5 * 26 : (v - 0.5) / 0.5 * 6)
    }

    func setEq(_ deck: Int, band: Int, _ v: Double) {
        eq[deck][band] = v
        let b: EqBand = band == 0 ? .high : (band == 1 ? .mid : .low)
        run { try engine.setEq(deck: UInt8(deck), band: b, db: Self.eqDb(v)) }
    }

    func setFilter(_ deck: Int, _ v: Double) {
        filter[deck] = v
        run { try engine.setFilter(deck: UInt8(deck), value: Float(v * 2 - 1)) }
    }

    /// Gain knob 0…1 → −12…+12 dB.
    func setGain(_ deck: Int, _ v: Double) { run { try engine.setGain(deck: UInt8(deck), db: Float(v * 24 - 12)) } }

    func gainNorm(_ deck: Int) -> Double { Double((self.deck(deck)?.gainDb ?? 0) + 12) / 24 }

    func setVolume(_ deck: Int, _ v: Double) { run { try engine.setVolume(deck: UInt8(deck), value: Float(v)) } }

    func togglePfl(_ deck: Int) {
        let on = !(self.deck(deck)?.pfl ?? false)
        run { try engine.setPfl(deck: UInt8(deck), on: on) }
    }

    /// Crossfader 0…1 (UI) → −1…1 (engine).
    func setCrossfader(_ v: Double) { run { try engine.setCrossfader(value: Float(v * 2 - 1)) } }

    var crossfaderNorm: Double { Double((snapshot?.crossfader ?? 0) + 1) / 2 }

    func setMasterVolume(_ v: Double) { run { try engine.setMasterVolume(value: Float(v)) } }

    func setHeadphoneMix(_ v: Double) {
        headphoneMix = v
        applyRouting()
    }

    private func applyRouting() {
        guard running, var r = try? engine.routingGet() else { return }
        r.cueMix = Float(headphoneMix)
        run { try engine.routingSet(routing: r) }
    }

    // MARK: renderer

    func uploadPeaks(to renderer: DecksRenderer, seen: inout [Int]) {
        for i in 0..<Self.deckCount where seen[i] != peaksVersion[i] {
            seen[i] = peaksVersion[i]
            if let p = peaks[i] { try? renderer.setPeaks(deck: UInt8(i), peaks: p) }
        }
    }

    func renderFrame(now: CFTimeInterval) -> RenderFrameState {
        var decks: [DeckFrameState] = []
        for i in 0..<Self.deckCount {
            guard let s = latest, i < s.decks.count else {
                decks.append(DeckFrameState(loaded: false, playheadSec: 0, slipPlayheadSec: nil, durationSec: 0, grid: nil, markers: [], platterRpm: 33.333, dvsScope: []))
                continue
            }
            let d = s.decks[i]
            var pos = d.playheadSec
            if d.playing {
                let rate = (0.2...4).contains(d.tempo) ? d.tempo : 1
                pos = min(d.durationSec, pos + max(0, now - latestAt) * rate)
            }
            var markers: [RenderMarker] = []
            if d.loaded {
                markers.append(RenderMarker(kind: .cue, startSec: d.cuePointSec, endSec: d.cuePointSec, colour: DecksTheme.cueRGB))
                for (slot, at) in d.hotCues.enumerated() {
                    if let at {
                        markers.append(RenderMarker(kind: .hotCue(slot: UInt8(slot)), startSec: at, endSec: at, colour: DecksTheme.hotCueRGB[slot % DecksTheme.hotCueRGB.count]))
                    }
                }
                if d.loopActive {
                    markers.append(RenderMarker(kind: .loop, startSec: d.loopStartSec, endSec: d.loopEndSec, colour: DecksTheme.deckRGB[i]))
                }
            }
            decks.append(DeckFrameState(loaded: d.loaded, playheadSec: pos, slipPlayheadSec: d.slipShadowSec, durationSec: d.durationSec, grid: grids[i], markers: markers, platterRpm: 33.333, dvsScope: []))
        }
        return RenderFrameState(decks: decks, zoomSeconds: zoomSeconds, style: .rgb3Band, theme: .dark, reducedMotion: reduceMotion)
    }
}
