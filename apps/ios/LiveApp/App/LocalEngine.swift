import AVFAudio
import Foundation
import LiveCore
import LiveFFI
import UIKit

/// The phone as a backup processor (WP21-06): runs the Rust MixAI Live engine in-process (cpal → CoreAudio) and lets
/// the app's own `LiveClient` connect to it on 127.0.0.1 with the controller token, so every screen works without a
/// computer. Its tokens change on every start, so it is never stored as a paired engine.
@MainActor @Observable
final class LocalEngine {
    static let shared = LocalEngine()

    enum Status: Equatable {
        case stopped
        case starting
        case running(input: String, sampleRate: Int, buffer: Int, lanHost: String?, port: Int)
        case failed(String)
    }

    private(set) var status: Status = .stopped
    private(set) var latency: String?
    private(set) var measuring = false
    /// Endpoint of the running engine (the session uses it to recognise the local connection).
    private(set) var endpoint: EngineEndpoint?
    /// LAN endpoint + performer token for other devices (watch), only with LAN control on.
    private(set) var lanPairing: PairingLink?

    /// The Rust engine is linked into this build (the xcframework existed when the app was compiled).
    static var available: Bool { LiveFFIPackage.hasEngine }

    #if canImport(live_ffiFFI)
    @ObservationIgnored private var engine: LiveEngine?
    #endif

    /// Asks for the microphone, configures the audio session for low latency and starts the engine.
    func start(lan: Bool, session: LiveSession) async {
        guard status == .stopped || status.isFailed else { return }
        status = .starting
        latency = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            status = .failed(String(localized: "live.local.mic_denied"))
            return
        }
        #if canImport(live_ffiFFI)
        do {
            let s = AVAudioSession.sharedInstance()
            // No Bluetooth A2DP: 150-250 ms of output latency is unusable for live monitoring.
            try s.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker])
            try s.setPreferredSampleRate(48_000)
            try s.setPreferredIOBufferDuration(0.004)
            try s.setActive(true)
            let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("live", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let cfg = LocalEngineConfig(
                sampleRate: 48_000, bufferFrames: 192, preset: "Natural Vocal", lan: lan, port: 0,
                name: "MixAI Live (\(UIDeviceName.current))", dataDir: dir.path, startMuted: true,
                audioHost: nil, inputDevice: nil, outputDevice: nil)
            let e = try await Task.detached { try LiveEngine.start(config: cfg) }.value
            let r = e.ready()
            engine = e
            let ep = EngineEndpoint(host: r.localHost, port: Int(r.port))
            endpoint = ep
            lanPairing = r.lanHost == r.localHost ? nil : PairingLink.parse(r.performerUrl)
            watch(e, session: session)
            status = .running(input: r.input, sampleRate: Int(r.sampleRate), buffer: Int(r.bufferFrames),
                              lanHost: r.lanHost == r.localHost ? nil : r.lanHost, port: Int(r.port))
            session.connectLocal(endpoint: ep, token: r.controllerToken)
        } catch {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            status = .failed(Self.reason(error))
        }
        #else
        status = .failed(String(localized: "live.local.unavailable"))
        #endif
    }

    func measureLatency() async {
        #if canImport(live_ffiFFI)
        guard let e = engine, !measuring else { return }
        measuring = true
        latency = String(localized: "live.local.latency_running")
        do {
            let r = try await Task.detached { try e.measureLatency(timeoutMs: 6000) }.value
            latency = String(format: String(localized: "live.local.latency_result %@ %@"),
                             String(format: "%.1f", r.roundTripMs), String(format: "%.1f", r.nominalMs))
        } catch {
            latency = String(format: String(localized: "live.local.latency_failed %@"), Self.reason(error))
        }
        measuring = false
        #endif
    }

    /// Stops at once in the UI; the native stop (joins threads, closes CoreAudio) runs off the main actor.
    func stop(session: LiveSession, reason: String? = nil) {
        if session.isLocal { session.disconnect() }
        watchdog?.cancel()
        watchdog = nil
        #if canImport(live_ffiFFI)
        if let e = engine {
            engine = nil
            Task.detached {
                e.stop()
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
        #endif
        endpoint = nil
        lanPairing = nil
        latency = nil
        status = reason.map { .failed($0) } ?? .stopped
    }

    @ObservationIgnored private var watchdog: Task<Void, Never>?

    #if canImport(live_ffiFFI)
    /// Stops everything when the stream dies (route change, call, media services reset) and says why.
    private func watch(_ e: LiveEngine, session: LiveSession) {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            // Whichever comes first: an interruption (call, Siri) or the engine reporting a dead stream.
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    for await n in NotificationCenter.default.notifications(named: AVAudioSession.interruptionNotification) {
                        let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
                        if raw == AVAudioSession.InterruptionType.began.rawValue { return }
                    }
                }
                group.addTask {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(1))
                        if !e.alive() { return }
                    }
                }
                await group.next()
                group.cancelAll()
            }
            guard !Task.isCancelled, let self, self.engine === e else { return }
            self.stop(session: session, reason: e.error() ?? String(localized: "live.local.stopped_unexpectedly"))
        }
    }
    #endif

    private static func reason(_ error: Error) -> String {
        // Every LiveError case carries a `reason` field; read it without naming the generated cases (their casing
        // depends on the UniFFI version), same as DecksApp's ImportView.
        let payload = Mirror(reflecting: error).children.first?.value
        let reason = payload.flatMap { Mirror(reflecting: $0).children.first { $0.label == "reason" }?.value as? String }
        return reason ?? error.localizedDescription
    }
}

private extension LocalEngine.Status {
    var isFailed: Bool { if case .failed = self { return true } else { return false } }
}

/// Short device label for the engine name (model, not the user-chosen device name: that is personal data).
enum UIDeviceName {
    @MainActor static var current: String { UIDevice.current.model }
}
