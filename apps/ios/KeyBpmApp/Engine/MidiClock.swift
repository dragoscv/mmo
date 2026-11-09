@preconcurrency import AVFoundation
import CoreMIDI
import Foundation
import Observation

/// MIDI clock out (WP18-08 iOS): Start (FA), 24 ppqn Clock (F8), Stop (FC) as UMP MIDI 1.0 system messages, scheduled
/// 40 ms ahead with host-time timestamps from a dedicated thread (CoreMIDI delivers each tick on time). Goes to every
/// connected destination (USB, network session, Bluetooth LE after pairing in the BLE sheet) and a virtual source
/// "MixAI Clock" other apps on the phone can listen to. Plus an AVAudioEngine metronome click.
@MainActor @Observable
final class MidiClock {
    static let shared = MidiClock()

    private(set) var running = false
    private(set) var destinations: [String] = []
    private(set) var beat = 0
    var bpm: Double = 120 { didSet { bpm = min(300, max(40, bpm)); worker.setBpm(bpm) } }
    var click = false { didSet { worker.click = click } }

    @ObservationIgnored private let worker = ClockWorker()

    private init() {
        worker.onBeat = { b in Task { @MainActor in MidiClock.shared.beat = b } }
        refresh()
        MIDINetworkSession.default().isEnabled = true
        MIDINetworkSession.default().connectionPolicy = .anyone
    }

    func refresh() { destinations = worker.destinationNames() }

    func start() {
        guard !running else { return }
        running = true
        worker.start(bpm: bpm)
    }

    func stop() {
        guard running else { return }
        running = false
        worker.stop()
    }
}

/// Real-time side of the clock (no actor isolation: runs on its own thread).
final class ClockWorker: @unchecked Sendable {
    private var client = MIDIClientRef()
    private var port = MIDIPortRef()
    private var source = MIDIEndpointRef()
    private let lock = NSLock()
    private var thread: Thread?
    private var bpm = 120.0
    private var t0: UInt64 = 0
    private var tick: UInt64 = 0
    private var origin = 0.0
    var click = false
    var onBeat: (@Sendable (Int) -> Void)?
    private let metronome = Metronome()
    private static let tb: mach_timebase_info_data_t = { var i = mach_timebase_info_data_t(); mach_timebase_info(&i); return i }()

    init() {
        MIDIClientCreateWithBlock("MixAI Key & BPM" as CFString, &client) { _ in }
        MIDIOutputPortCreate(client, "Clock out" as CFString, &port)
        MIDISourceCreateWithProtocol(client, "MixAI Clock" as CFString, ._1_0, &source)
    }

    func destinationNames() -> [String] {
        (0..<MIDIGetNumberOfDestinations()).compactMap { i in
            var name: Unmanaged<CFString>?
            MIDIObjectGetStringProperty(MIDIGetDestination(i), kMIDIPropertyDisplayName, &name)
            return name?.takeRetainedValue() as String?
        }
    }

    func setBpm(_ v: Double) {
        lock.lock(); defer { lock.unlock() }
        // Keep the phase: re-anchor the tick grid at the current tick.
        if thread != nil { origin = seconds(of: tick) ; t0 = now(); tick = 0 }
        bpm = v
    }

    func start(bpm: Double) {
        lock.lock()
        self.bpm = bpm
        t0 = now() + nanosToHost(20_000_000)
        tick = 0
        origin = 0
        lock.unlock()
        send(0x10FA_0000, at: t0)
        let th = Thread { [weak self] in self?.loop() }
        th.qualityOfService = .userInteractive
        th.name = "keybpm-midi-clock"
        thread = th
        th.start()
    }

    func stop() {
        thread?.cancel()
        thread = nil
        send(0x10FC_0000, at: now())
    }

    private func loop() {
        let ahead = nanosToHost(40_000_000)
        while !Thread.current.isCancelled {
            lock.lock()
            let horizon = now() + ahead
            while true {
                let at = t0 + secondsToHost(seconds(of: tick) - origin)
                if at > horizon { break }
                send(0x10F8_0000, at: at)
                if tick % 24 == 0 {
                    let b = Int(tick / 24)
                    onBeat?(b)
                    if click { metronome.click(downbeat: b % 4 == 0, at: at) }
                }
                tick += 1
            }
            lock.unlock()
            Thread.sleep(forTimeInterval: 0.01)
        }
    }

    /// Seconds of tick n since the anchor at the current BPM (24 ppqn).
    private func seconds(of n: UInt64) -> Double { origin + Double(n) * 60 / (bpm * 24) }

    private func send(_ word: UInt32, at host: UInt64) {
        var list = MIDIEventList()
        let pkt = MIDIEventListInit(&list, ._1_0)
        var w = word
        _ = MIDIEventListAdd(&list, MemoryLayout<MIDIEventList>.size, pkt, MIDITimeStamp(host), 1, &w)
        for i in 0..<MIDIGetNumberOfDestinations() { MIDISendEventList(port, MIDIGetDestination(i), &list) }
        MIDIReceivedEventList(source, &list)
    }

    private func now() -> UInt64 { mach_absolute_time() }
    private func nanosToHost(_ ns: UInt64) -> UInt64 { ns * UInt64(Self.tb.denom) / UInt64(Self.tb.numer) }
    private func secondsToHost(_ s: Double) -> UInt64 { nanosToHost(UInt64(max(0, s) * 1e9)) }
}

/// 30 ms sine click (1 kHz downbeat, 800 Hz other beats), same as Android.
final class Metronome: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var hi: AVAudioPCMBuffer?
    private var lo: AVAudioPCMBuffer?

    init() {
        let fmt = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: fmt)
        hi = Self.tone(1000, fmt); lo = Self.tone(800, fmt)
    }

    func click(downbeat: Bool, at host: UInt64) {
        if !engine.isRunning { try? engine.start(); player.play() }
        guard let b = downbeat ? hi : lo else { return }
        player.scheduleBuffer(b, at: AVAudioTime(hostTime: host), options: [])
    }

    private static func tone(_ hz: Double, _ fmt: AVAudioFormat) -> AVAudioPCMBuffer? {
        let n = AVAudioFrameCount(48_000 * 0.03)
        guard let b = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: n) else { return nil }
        b.frameLength = n
        for i in 0..<Int(n) {
            let t = Double(i) / 48_000
            b.floatChannelData![0][i] = Float(sin(2 * .pi * hz * t) * exp(-t * 150) * 0.6)
        }
        return b
    }
}
