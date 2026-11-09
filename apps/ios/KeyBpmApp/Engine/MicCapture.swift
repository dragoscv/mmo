@preconcurrency import AVFoundation
import Foundation
#if canImport(KeyBpmFFI)
import KeyBpmFFI
#endif

/// Microphone → Rust engine (WP18-05). `.measurement` mode = no AGC / voice EQ (they bend key detection). Built in a
/// nonisolated type so the tap block is not inferred as main-actor isolated (Swift 6 would trap on the audio thread).
final class MicCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var running = false
    private(set) var sampleRate: Double = 48_000
    private var observers: [NSObjectProtocol] = []
    /// Called on the audio thread with mono float samples.
    private var onBlock: (@Sendable (UnsafePointer<Float>, Int) -> Void)?
    /// Called (main queue) when capture stopped by itself (interruption without resume, route lost, reset).
    var onLost: (@Sendable () -> Void)?

    static func requestPermission() async -> Bool { await AVAudioApplication.requestRecordPermission() }

    /// Configures the shared audio session for analysis. `playback` keeps the session usable for the metronome click.
    static func configureSession() throws {
        let s = AVAudioSession.sharedInstance()
        #if os(watchOS)
        try s.setCategory(.record, mode: .measurement, options: [])
        #else
        try s.setCategory(.playAndRecord, mode: .measurement, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP])
        try? s.setPreferredSampleRate(48_000)
        try? s.setPreferredIOBufferDuration(0.01)
        #endif
        try s.setActive(true)
    }

    func start(_ block: @escaping @Sendable (UnsafePointer<Float>, Int) -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        guard !running else { return }
        try Self.configureSession()
        onBlock = block
        try installAndStart()
        running = true
        observe()
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        guard running else { return }
        running = false
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        onBlock = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func installAndStart() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureError.noInput }
        sampleRate = format.sampleRate
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 50), format: format, block: Self.tap(self))
        engine.prepare()
        try engine.start()
    }

    private static func tap(_ me: MicCapture) -> AVAudioNodeTapBlock {
        { [weak me] buf, _ in
            guard let me, let ch = buf.floatChannelData?[0] else { return }
            me.onBlock?(ch, Int(buf.frameLength))
        }
    }

    private func observe() {
        let c = NotificationCenter.default
        observers.append(c.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            guard let self, let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .ended {
                let opts = (n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init) ?? []
                if opts.contains(.shouldResume), (try? Self.configureSession()) != nil, (try? self.installAndStart()) != nil { return }
                self.onLost?()
            }
        })
        observers.append(c.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] n in
            guard let self, let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
            // New input device (e.g. headset plugged / unplugged): reinstall the tap at the new format.
            if reason == .oldDeviceUnavailable || reason == .newDeviceAvailable {
                self.engine.stop()
                if (try? self.installAndStart()) == nil { self.onLost?() }
            }
        })
        observers.append(c.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            if (try? Self.configureSession()) == nil || (try? self.installAndStart()) == nil { self.onLost?() }
        })
    }

    enum CaptureError: Error { case noInput }
}

/// Thread-safe holder for the Rust engine: the audio tap pushes from the render thread, the UI polls on main.
final class EngineBox: @unchecked Sendable {
    private let lock = NSLock()
    #if canImport(KeyBpmFFI)
    private var engine: KeyBpmEngine?
    #endif

    func make(sampleRate: Double, a4: Double) {
        lock.lock(); defer { lock.unlock() }
        #if canImport(KeyBpmFFI)
        engine = KeyBpmEngine(config: EngineConfig(sampleRate: UInt32(sampleRate.rounded()), bpmFloor: 88, a4Hz: a4))
        #endif
    }

    func push(_ p: UnsafePointer<Float>, count: Int) {
        lock.lock()
        #if canImport(KeyBpmFFI)
        let e = engine
        #endif
        lock.unlock()
        #if canImport(KeyBpmFFI)
        guard let e else { return }
        e.pushPcmBytes(leF32: Data(bytes: p, count: count * MemoryLayout<Float>.size))
        #endif
    }

    func setA4(_ hz: Double) {
        lock.lock(); defer { lock.unlock() }
        #if canImport(KeyBpmFFI)
        engine?.setA4(hz: hz)
        #endif
    }

    func close() {
        lock.lock(); defer { lock.unlock() }
        #if canImport(KeyBpmFFI)
        engine = nil
        #endif
    }

    var isOpen: Bool {
        lock.lock(); defer { lock.unlock() }
        #if canImport(KeyBpmFFI)
        return engine != nil
        #else
        return false
        #endif
    }

    func read() -> Reading? {
        lock.lock()
        #if canImport(KeyBpmFFI)
        let e = engine
        #endif
        lock.unlock()
        #if canImport(KeyBpmFFI)
        guard let s = e?.snapshot() else { return nil }
        return Reading(s)
        #else
        return nil
        #endif
    }

    /// File mode (CNN on): decodes and analyses on the calling (background) thread.
    static func analyzeFile(_ path: String) throws -> Reading {
        #if canImport(KeyBpmFFI)
        return Reading(try KeyBpmFFI.analyzeFile(path: path, bpmFloor: 88))
        #else
        throw MicCapture.CaptureError.noInput
        #endif
    }
}

/// Live reading shown by every screen (phone, widgets, Live Activity, watch mirror). Plain Swift, Sendable.
struct Reading: Equatable, Sendable {
    var keyIndex: Int?
    var keyLocked = false
    var keyConfidence = 0.0
    var alternativeIndex: Int?
    var bpm: Double?
    var tempoLocked = false
    var tempoConfidence = 0.0
    var nextBeatIn = 0.0
    var chord: String?
    var tuningA4 = 440.0
    var tuningCents = 0.0
    var lufs: Double?
    var energy: Double?
    var levelDbfs = -120.0
    var pitchNote: String?
    var pitchHz = 0.0
    var pitchCents = 0.0
    var pitchMidi: Int?
    var pitchClarity = 0.0
    var chroma: [Float] = Array(repeating: 0, count: 12)
    var keyChanged = false
}

#if canImport(KeyBpmFFI)
extension Reading {
    init(_ s: ListenSnapshot) {
        self.init()
        keyIndex = s.key.map { Int($0.key.index) }
        keyLocked = s.key?.locked ?? false
        keyConfidence = s.key?.confidence ?? 0
        alternativeIndex = s.key.map { Int($0.alternative.index) }
        bpm = s.tempo?.bpm
        tempoLocked = s.tempo?.locked ?? false
        tempoConfidence = s.tempo?.confidence ?? 0
        nextBeatIn = s.tempo?.nextBeatInSecs ?? 0
        chord = s.chord?.label
        tuningA4 = s.tuningA4Hz
        tuningCents = s.tuningCents
        lufs = s.loudness.map(\.shortTermLufs).flatMap { $0.isFinite ? $0 : nil }
        energy = s.energy
        levelDbfs = s.levelDbfs
        pitchNote = s.pitch?.noteName
        pitchHz = s.pitch?.hz ?? 0
        pitchCents = s.pitch?.cents ?? 0
        pitchMidi = s.pitch.map { Int($0.midi) }
        pitchClarity = s.pitch?.clarity ?? 0
        chroma = s.chroma.count == 12 ? s.chroma : Array(repeating: 0, count: 12)
        keyChanged = s.keyChanged
    }
}
#endif

/// Last N seconds of mono float PCM for Song ID. Written from the audio thread, read on demand.
final class PcmRing: @unchecked Sendable {
    private let lock = NSLock()
    private let seconds: Double
    private var buf: [Float] = []
    private var pos = 0
    private var filled = 0
    private(set) var sampleRate: Double = 48_000

    init(seconds: Double) { self.seconds = seconds }

    func reset(sampleRate: Double) {
        lock.lock(); defer { lock.unlock() }
        self.sampleRate = sampleRate
        buf = Array(repeating: 0, count: Int(sampleRate * seconds))
        pos = 0; filled = 0
    }

    func push(_ p: UnsafePointer<Float>, count: Int) {
        lock.lock(); defer { lock.unlock() }
        guard !buf.isEmpty else { return }
        for i in 0..<count { buf[pos] = p[i]; pos += 1; if pos == buf.count { pos = 0 } }
        filled = min(buf.count, filled + count)
    }

    var filledSeconds: Double { lock.lock(); defer { lock.unlock() }; return Double(filled) / sampleRate }

    /// The last `secs` seconds in chronological order.
    func last(_ secs: Double) -> [Float] {
        lock.lock(); defer { lock.unlock() }
        let n = min(filled, Int(secs * sampleRate))
        guard n > 0 else { return [] }
        var out = [Float](repeating: 0, count: n)
        var start = (pos - n + buf.count) % buf.count
        for i in 0..<n { out[i] = buf[start]; start += 1; if start == buf.count { start = 0 } }
        return out
    }
}
