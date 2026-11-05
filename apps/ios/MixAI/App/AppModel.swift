import Foundation
import MixaiCore
import Observation
import SwiftUI

/// Persisted connection to one MMO Server (paired device token lives in the Keychain).
struct ServerConnection: Codable, Equatable, Sendable {
    var name: String
    var baseURL: String
}

/// App-wide state: connection, active profile, stores. Lives on the main actor.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case launching, onboarding, profiles, ready }

    var phase: Phase = .launching
    var server: ServerConnection?
    var client: MmoClient?
    var profileStore: ProfileStore?
    var activeProfile: Profile?
    var profiles: [Profile] = []
    var homeStore: HomeStore?
    var hub: HubClient?
    var account: SessionUser?
    var language: String = Prefs.language
    var origin: String = Prefs.origin
    let player = PlayerCoordinator()
    let music = MusicPlayer()

    var locale: Locale { Locale(identifier: language == "system" ? (Locale.preferredLanguages.first ?? "en") : language) }
    var lang: String { language == "system" ? (Locale.preferredLanguages.first ?? "en") : language }

    var profileId: String { activeProfile?.id ?? "default" }
    var media: MediaStore? { client.map { MediaStore(client: $0, profile: profileId) } }
    var musicStore: MusicStore? { client.map { MusicStore(client: $0, profile: profileId) } }
    var liveTv: LiveTvStore? { client.map { LiveTvStore(client: $0, profile: profileId) } }
    var progress: ProgressSync?

    static var cacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("mixai", isDirectory: true)
    }

    // MARK: lifecycle

    func boot() async {
        guard phase == .launching else { return }
        if let s = Prefs.server, let tok = Keychain.get("device-token:\(s.baseURL)"), !tok.isEmpty {
            await connect(s, token: tok, persist: false)
        } else {
            phase = .onboarding
        }
    }

    /// Adopt a server + device token, then decide profile picker vs home.
    func connect(_ s: ServerConnection, token: String, persist: Bool = true) async {
        let c = MmoClient(baseURL: s.baseURL, token: token)
        if persist {
            Prefs.server = s
            Keychain.set(token, for: "device-token:\(c.baseURL)")
        }
        server = s
        client = c
        homeStore = HomeStore(client: c, directory: Self.cacheDir)
        let ps = ProfileStore(client: c, load: { Prefs.savedProfile }, save: { Prefs.savedProfile = $0 })
        profileStore = ps
        let picker = await ps.needsPicker()
        profiles = await ps.profiles
        activeProfile = await ps.active
        rebuildProfileScoped()
        startHub()
        phase = picker ? .profiles : .ready
    }

    func rebuildProfileScoped() {
        guard let client else { return }
        progress = ProgressSync(store: MediaStore(client: client, profile: profileId),
                                queueFile: Self.cacheDir.appendingPathComponent("progress-queue-\(HomeStore.fileName(for: profileId))"))
        Task { await hub?.setProfile(activeProfile?.id) }
    }

    func choose(_ p: Profile) async {
        await profileStore?.select(p)
        activeProfile = p
        rebuildProfileScoped()
        phase = .ready
    }

    func unlocked(_ p: Profile) {
        activeProfile = p
        rebuildProfileScoped()
        phase = .ready
    }

    func switchProfile() async {
        if let ps = profileStore { profiles = (try? await ps.refresh()) ?? profiles }
        phase = .profiles
    }

    func signOutServer() {
        if let s = server { Keychain.delete("device-token:\(MmoClient.normalise(s.baseURL))") }
        Prefs.server = nil
        Prefs.savedProfile = SavedProfile()
        Task { await hub?.stop() }
        player.stop()
        music.stop()
        server = nil; client = nil; homeStore = nil; profileStore = nil; activeProfile = nil; profiles = []
        phase = .onboarding
    }

    func setLanguage(_ l: String) {
        language = l
        Prefs.language = l
        // String(localized:) and system UI follow AppleLanguages from the next launch; SwiftUI Text follows \.locale now.
        if l == "system" { UserDefaults.standard.removeObject(forKey: "AppleLanguages") } else { UserDefaults.standard.set([l], forKey: "AppleLanguages") }
    }

    func setOrigin(_ o: String) {
        origin = o
        Prefs.origin = o
    }

    private func startHub() {
        guard let client else { return }
        Task { await hub?.stop() }
        let h = HubClient(client: client, deviceId: Prefs.deviceId, deviceName: ClientIdentity.current.deviceName, profileId: activeProfile?.id)
        hub = h
        Task { await h.start() }
    }
}

/// Small UserDefaults-backed preferences (no secrets).
enum Prefs {
    private static var d: UserDefaults { .standard }

    static var server: ServerConnection? {
        get { d.data(forKey: "server").flatMap { try? JSONDecoder().decode(ServerConnection.self, from: $0) } }
        set { d.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "server") }
    }

    static var savedProfile: SavedProfile {
        get { d.data(forKey: "profile").flatMap { try? JSONDecoder().decode(SavedProfile.self, from: $0) } ?? SavedProfile() }
        set { d.set(try? JSONEncoder().encode(newValue), forKey: "profile") }
    }

    static var language: String {
        get { d.string(forKey: "language") ?? "system" }
        set { d.set(newValue, forKey: "language") }
    }

    /// Web origin for account sign-in (mixai.ro; Cloud Run while DNS is down).
    static var origin: String {
        get { d.string(forKey: "origin") ?? MixaiOrigin.cloudRun }
        set { d.set(newValue, forKey: "origin") }
    }

    static var liveNoticeAccepted: Bool {
        get { d.bool(forKey: "liveNotice") }
        set { d.set(newValue, forKey: "liveNotice") }
    }

    static var deviceId: String {
        if let id = d.string(forKey: "deviceId") { return id }
        let id = "ios-" + UUID().uuidString.lowercased()
        d.set(id, forKey: "deviceId")
        return id
    }
}
