@preconcurrency import AVFoundation
import Foundation
#if canImport(ShazamKit)
@preconcurrency import ShazamKit
#endif

/// A Song ID result (ShazamKit) plus the optional MMO library match.
struct SongMatch: Codable, Equatable, Sendable {
    var title: String
    var artist: String?
    var isrc: String?
    var shazamId: String?
    var appleMusicId: String?
    var artworkUrl: String?
    var appleMusicUrl: String?
    var webUrl: String?
    var libraryTrackId: String?
    var libraryCamelot: String?
    var libraryBpm: Double?
    var libraryPath: String?

    private var query: String { [artist, title].compactMap { $0 }.joined(separator: " ") }
    var spotifyURL: URL? {
        URL(string: "https://open.spotify.com/search/" + (query.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""))
    }
    var youTubeMusicURL: URL? {
        var c = URLComponents(string: "https://music.youtube.com/search")
        c?.queryItems = [URLQueryItem(name: "q", value: query)]
        return c?.url
    }
}

enum SongIdResult: Sendable {
    case match(SongMatch)
    case noMatch
    /// No network: the signature is queued and matched later.
    case queued
    case failed(String)
}

/// Offline fingerprint waiting to be matched (signature data only — no audio). Max 50, 7 days.
struct PendingSignature: Codable, Equatable, Sendable {
    var data: Data
    var durationMs: Int
    var createdAt: Date
    var entryAt: Date?
}

/// ShazamKit Song ID (WP18-05 / WP18-06): signature generated from OUR mic ring (SHManagedSession would own a second
/// mic), matched with SHSession against the Shazam catalog; offline signatures queued (`dataRepresentation`) and
/// retried. Matches are added to the user's Shazam library (SHLibrary). Needs the ShazamKit App Service on the App ID.
final class SongIdEngine: @unchecked Sendable {
    private let lock = NSLock()
    private let queueURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("shazam-pending.json")
    }()

    var available: Bool {
        #if canImport(ShazamKit)
        true
        #else
        false
        #endif
    }

    var pendingCount: Int { loadPending().count }

    func identify(pcm: [Float], sampleRate: Double, entryAt: Date?) async -> SongIdResult {
        #if canImport(ShazamKit)
        guard pcm.count > Int(sampleRate * 3) else { return .noMatch }
        let sig: SHSignature
        do { sig = try Self.signature(pcm: pcm, sampleRate: sampleRate) } catch { return .failed("signature") }
        return await match(sig, entryAt: entryAt, queueOnOffline: true)
        #else
        return .failed("unavailable")
        #endif
    }

    func takePending(max: Int) -> [PendingSignature] {
        lock.lock(); defer { lock.unlock() }
        var all = loadPendingUnlocked()
        let take = Array(all.prefix(max))
        all.removeFirst(take.count)
        savePendingUnlocked(all)
        return take
    }

    func retry(_ p: PendingSignature) async -> SongIdResult {
        #if canImport(ShazamKit)
        guard let sig = try? SHSignature(dataRepresentation: p.data) else { return .failed("signature") }
        let r = await match(sig, entryAt: p.entryAt, queueOnOffline: false)
        if case .queued = r { enqueue(p) }
        return r
        #else
        return .failed("unavailable")
        #endif
    }

    #if canImport(ShazamKit)
    private func match(_ sig: SHSignature, entryAt: Date?, queueOnOffline: Bool) async -> SongIdResult {
        let session = SHSession()
        switch await session.result(from: sig) {
        case .match(let m):
            guard let item = m.mediaItems.first, let title = item.title else { return .noMatch }
            Task { try? await SHLibrary.default.addItems([item]) }
            return .match(SongMatch(
                title: title, artist: item.artist, isrc: item.isrc, shazamId: item.shazamID, appleMusicId: item.appleMusicID,
                artworkUrl: item.artworkURL?.absoluteString, appleMusicUrl: item.appleMusicURL?.absoluteString,
                webUrl: item.webURL?.absoluteString))
        case .noMatch:
            return .noMatch
        case .error(let error, _):
            let ns = error as NSError
            let offline = ns.domain == NSURLErrorDomain || (ns.domain == SHErrorDomain && ns.code == SHError.Code.matchAttemptFailed.rawValue)
            if offline {
                if queueOnOffline {
                    enqueue(PendingSignature(data: sig.dataRepresentation, durationMs: Int(sig.duration * 1000), createdAt: .now, entryAt: entryAt))
                }
                return .queued
            }
            return .failed(ns.localizedDescription)
        }
    }

    /// Mono float PCM → SHSignature (ShazamKit accepts 16/32/44.1/48 kHz mono).
    static func signature(pcm: [Float], sampleRate: Double) throws -> SHSignature {
        guard let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
              let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(pcm.count)) else { throw CocoaError(.featureUnsupported) }
        buf.frameLength = AVAudioFrameCount(pcm.count)
        pcm.withUnsafeBufferPointer { src in buf.floatChannelData![0].update(from: src.baseAddress!, count: pcm.count) }
        let gen = SHSignatureGenerator()
        try gen.append(buf, at: nil)
        return gen.signature()
    }
    #endif

    private func enqueue(_ p: PendingSignature) {
        lock.lock(); defer { lock.unlock() }
        var all = loadPendingUnlocked()
        all.append(p)
        savePendingUnlocked(Array(all.suffix(50)))
    }

    private func loadPending() -> [PendingSignature] { lock.lock(); defer { lock.unlock() }; return loadPendingUnlocked() }

    private func loadPendingUnlocked() -> [PendingSignature] {
        guard let d = try? Data(contentsOf: queueURL), let all = try? JSONDecoder().decode([PendingSignature].self, from: d) else { return [] }
        let cutoff = Date.now.addingTimeInterval(-7 * 86_400)
        return all.filter { $0.createdAt > cutoff }
    }

    private func savePendingUnlocked(_ all: [PendingSignature]) {
        if all.isEmpty { try? FileManager.default.removeItem(at: queueURL); return }
        try? JSONEncoder().encode(all).write(to: queueURL, options: .atomic)
    }
}
