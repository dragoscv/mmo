import Foundation
import MixaiCore
import Observation
import Security
import SwiftUI

/// Persisted connection to one MixAI Server (the device token lives in the Keychain).
struct TVServer: Codable, Equatable, Sendable {
    var name: String
    var baseURL: String
}

/// App-wide state for MixAI TV on Apple TV (WP17-24). Same server contract as the iPhone app (MixaiCore); no account
/// session, downloads, widgets, CarPlay or Live Activities — those APIs do not exist on tvOS.
@MainActor
@Observable
final class TVModel {
    enum Phase: Equatable { case launching, onboarding, profiles, ready }

    var phase: Phase = .launching
    var server: TVServer?
    var client: MmoClient?
    var profileStore: ProfileStore?
    var profiles: [Profile] = []
    var activeProfile: Profile?
    var homeStore: HomeStore?
    var progress: ProgressSync?
    /// Video being played full screen (AVPlayerViewController).
    var playing: TVPlayRequest?
    /// Deep link (Top Shelf, `mixai://title/...`) consumed by the Home tab's NavigationStack.
    var pendingRoute: TVRoute?
    /// Built-in music player of the Music tab (WP17-45).
    let musicPlayer = TVMusicPlayer()

    var profileId: String { activeProfile?.id ?? "default" }
    var media: MediaStore? { client.map { MediaStore(client: $0, profile: profileId) } }
    var music: MusicStore? { client.map { MusicStore(client: $0, profile: profileId) } }
    var liveTv: LiveTvStore? { client.map { LiveTvStore(client: $0, profile: profileId) } }
    var lang: String { Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "en" }

    static var cacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("mixai", isDirectory: true)
    }

    func boot() async {
        guard phase == .launching else { return }
        if let s = TVPrefs.server, let tok = TVKeychain.get("device-token:\(s.baseURL)"), !tok.isEmpty {
            await connect(s, token: tok, persist: false)
        } else {
            phase = .onboarding
        }
    }

    func connect(_ s: TVServer, token: String, persist: Bool = true) async {
        let c = MmoClient(baseURL: s.baseURL, token: token)
        if persist {
            TVPrefs.server = s
            TVKeychain.set(token, for: "device-token:\(c.baseURL)")
        }
        server = s
        client = c
        homeStore = HomeStore(client: c, directory: Self.cacheDir)
        let ps = ProfileStore(client: c, load: { TVPrefs.savedProfile }, save: { TVPrefs.savedProfile = $0 })
        profileStore = ps
        let picker = await ps.needsPicker()
        profiles = await ps.profiles
        activeProfile = await ps.active
        rebuildProgress()
        phase = picker ? .profiles : .ready
    }

    func choose(_ p: Profile) async {
        await profileStore?.select(p)
        activeProfile = p
        rebuildProgress()
        phase = .ready
    }

    func unlocked(_ p: Profile) {
        activeProfile = p
        rebuildProgress()
        phase = .ready
    }

    func switchProfile() async {
        if let ps = profileStore { profiles = (try? await ps.refresh()) ?? profiles }
        phase = .profiles
    }

    func disconnect() {
        if let s = server { TVKeychain.delete("device-token:\(MmoClient.normalise(s.baseURL))") }
        musicPlayer.stop()
        TVPrefs.server = nil
        TVPrefs.savedProfile = SavedProfile()
        playing = nil
        server = nil; client = nil; homeStore = nil; profileStore = nil; activeProfile = nil; profiles = []; progress = nil
        phase = .onboarding
    }

    private func rebuildProgress() {
        guard let client else { return }
        progress = ProgressSync(store: MediaStore(client: client, profile: profileId),
                                queueFile: Self.cacheDir.appendingPathComponent("progress-queue-\(HomeStore.fileName(for: profileId))"))
    }

    /// Resolve the best local file of a title and play it (resume where the profile left off).
    func play(kind: MediaKind, tmdbId: Int) async -> Bool {
        guard let store = media, let d = try? await store.title(kind: kind, tmdbId: tmdbId),
              let t = await PlayResolver.resolve(d, store: store) else { return false }
        play(t, title: d.title.title, subtitle: t.ref.season.map { "S\($0) E\(t.ref.episode ?? 0)" })
        return true
    }

    func play(_ t: PlayTarget, title: String, subtitle: String?) {
        TVStartupSound.finish()
        musicPlayer.pause() // video takes over the audio
        playing = TVPlayRequest(source: .file(fileId: t.fileId, ref: t.ref, startSec: t.resumeSec ?? 0), title: title, subtitle: subtitle)
    }

    func playLive(_ channel: LiveTvChannel) {
        TVStartupSound.finish()
        musicPlayer.pause()
        playing = TVPlayRequest(source: .live(channelId: channel.id), title: channel.name, subtitle: nil)
    }
}

struct TVPlayRequest: Identifiable, Equatable {
    enum Source: Equatable {
        case file(fileId: String, ref: MediaRef, startSec: Double)
        case live(channelId: String)
    }

    let id = UUID()
    let source: Source
    let title: String
    let subtitle: String?
}

/// UserDefaults preferences (no secrets).
enum TVPrefs {
    private static var d: UserDefaults { .standard }

    static var server: TVServer? {
        get { d.data(forKey: "server").flatMap { try? JSONDecoder().decode(TVServer.self, from: $0) } }
        set { d.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "server") }
    }

    static var savedProfile: SavedProfile {
        get { d.data(forKey: "profile").flatMap { try? JSONDecoder().decode(SavedProfile.self, from: $0) } ?? SavedProfile() }
        set { d.set(try? JSONEncoder().encode(newValue), forKey: "profile") }
    }

    /// Brand sound at cold start (Settings › Sound, `TVStartupSound`). On until the user turns it off.
    static let startupSoundKey = "startupSound"
    static var startupSound: Bool { d.object(forKey: startupSoundKey) as? Bool ?? true }
}

/// Generic-password Keychain items for device tokens.
enum TVKeychain {
    private static let service = "ro.mixai.app"

    static func set(_ value: String, for key: String) {
        delete(key)
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(value.utf8),
        ]
        SecItemAdd(q as CFDictionary, nil)
    }

    static func get(_ key: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(_ key: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
    }
}
