import AVFoundation
@preconcurrency import AudioStreaming
import Foundation

/// One AVAudioEngine-backed player (AudioStreaming) with a per-track gain stage and a peak limiter.
/// `MusicPlayer` runs two decks: the active one, and the incoming one during a crossfade.
@MainActor
final class MusicDeck {
    enum Event {
        case started(String)
        case finished(String, eof: Bool)
        case failed(AudioPlayerError)
    }

    let name: String
    private let player: AudioPlayer
    private let gain = AVAudioUnitEQ(numberOfBands: 1)
    private let limiter: AVAudioUnitEffect
    private let relay = DeckRelay()
    /// URL string → track id for entries this deck was given (AudioStreaming ids entries by URL string).
    private var entries: [String: String] = [:]
    private(set) var queuedNext: URL?
    var onEvent: ((Event) -> Void)?

    init(name: String) {
        self.name = name
        player = AudioPlayer(configuration: AudioPlayerConfiguration(flushQueueOnSeek: false, enableLogs: false))
        limiter = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
            componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
        gain.bands[0].bypass = true
        player.attach(nodes: [gain, limiter])
        relay.deck = self
        player.delegate = relay
    }

    var progress: Double { player.progress }
    var duration: Double { player.duration }
    var isPlaying: Bool { player.state == .playing || player.state == .bufferring }
    var isIdle: Bool { player.state == .ready || player.state == .stopped || player.state == .disposed || player.state == .error }

    /// Linear output volume 0...1 (crossfade curve × sleep fade).
    var volume: Float {
        get { player.volume }
        set { player.volume = max(0, min(1, newValue)) }
    }

    /// Per-track loudness gain in dB (EQ global gain, -96...24); the limiter catches what the true-peak cap missed.
    var gainDb: Double {
        get { Double(gain.globalGain) }
        set { gain.globalGain = Float(max(-96, min(24, newValue))) }
    }

    func play(_ url: URL, trackId: String) {
        entries = [url.absoluteString: trackId]
        queuedNext = nil
        player.play(url: url)
    }

    /// Gapless: the next entry starts on the same engine the instant the current one ends.
    func queue(_ url: URL, trackId: String) {
        if let q = queuedNext { player.removeFromQueue(url: q) }
        entries[url.absoluteString] = trackId
        queuedNext = url
        player.queue(url: url)
    }

    func clearQueued() {
        guard let q = queuedNext else { return }
        player.removeFromQueue(url: q)
        entries[q.absoluteString] = nil
        queuedNext = nil
    }

    func pause() { player.pause() }
    func resume() { player.resume() }
    func seek(_ s: Double) { player.seek(to: max(0, s)) }

    func stop() {
        queuedNext = nil
        player.stop()
    }

    fileprivate func handle(_ e: Event) { onEvent?(e) }
    fileprivate func trackId(for entry: AudioEntryId) -> String? { entries[entry.id] }
    fileprivate func consumedQueued(_ entry: AudioEntryId) {
        if queuedNext?.absoluteString == entry.id { queuedNext = nil }
    }
}

/// AudioStreaming calls its delegate on the main queue (`asyncOnMain`); `@preconcurrency` checks that at runtime.
@MainActor
private final class DeckRelay: @preconcurrency AudioPlayerDelegate {
    weak var deck: MusicDeck?

    func audioPlayerDidStartPlaying(player: AudioPlayer, with entryId: AudioEntryId) {
        guard let deck, let id = deck.trackId(for: entryId) else { return }
        deck.consumedQueued(entryId)
        deck.handle(.started(id))
    }

    func audioPlayerDidFinishBuffering(player: AudioPlayer, with entryId: AudioEntryId) {}

    func audioPlayerStateChanged(player: AudioPlayer, with newState: AudioPlayerState, previous: AudioPlayerState) {}

    func audioPlayerDidFinishPlaying(player: AudioPlayer, entryId: AudioEntryId, stopReason: AudioPlayerStopReason, progress: Double, duration: Double) {
        guard let deck, let id = deck.trackId(for: entryId) else { return }
        deck.handle(.finished(id, eof: stopReason == .eof))
    }

    func audioPlayerUnexpectedError(player: AudioPlayer, error: AudioPlayerError) {
        deck?.handle(.failed(error))
    }

    func audioPlayerDidCancel(player: AudioPlayer, queuedItems: [AudioEntryId]) {}

    func audioPlayerDidReadMetadata(player: AudioPlayer, metadata: [String: String]) {}
}
