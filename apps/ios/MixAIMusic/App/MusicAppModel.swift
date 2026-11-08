import Foundation
import MixaiCore
import MixaiUI
import Observation
import SwiftUI
import UIKit
import WidgetKit

/// Persisted connection to one MixAI Server (device token in the Keychain).
struct MusicServer: Codable, Equatable, Sendable {
    var name: String
    var baseURL: String
}

/// App-wide state of MixAI Music (ro.mixai.music, D51): server, profile, the shared music stack, hub outputs,
/// downloads and widget snapshot.
@MainActor
@Observable
final class MusicAppModel {
    static let shared = MusicAppModel()

    enum Phase: Equatable { case launching, onboarding, profiles, ready }

    var phase: Phase = .launching
    var server: MusicServer?
    var client: MmoClient?
    var profileStore: ProfileStore?
    var profiles: [Profile] = []
    var activeProfile: Profile?
    var account: SessionUser?
    var origin: String = MusicPrefs.origin
    var selectedTab = 0
    var pendingRoute: MusicRoute?
    var toast: String?

    let player = MusicPlayer()
    let downloads = MusicDownloads()
    let env: MusicEnvironment
    let keychain = KeychainStore(service: "ro.mixai.music")

    @ObservationIgnored private var hub: HubClient?
    @ObservationIgnored private var hubTasks: [Task<Void, Never>] = []
    @ObservationIgnored private var booting = false
    @ObservationIgnored private var lastHubSig = ""

    var profileId: String { activeProfile?.id ?? "default" }

    init() {
        env = MusicEnvironment(player: player, downloads: downloads)
        downloads.store = { [weak self] in self?.env.store }
        player.localURL = { [weak self] id in self?.downloads.localURL(trackId: id) }
        player.onChange = { [weak self] in self?.playerChanged() }
        player.onHandoff = { [weak self] output, input in await self?.handoff(output, input) ?? false }
    }

    // MARK: lifecycle

    func boot() async {
        guard phase == .launching, !booting else { return }
        booting = true
        account = MusicPrefs.account
        player.installRemoteCommands()
        if let s = MusicPrefs.server, let tok = keychain.get("device-token:\(s.baseURL)"), !tok.isEmpty {
            await connect(s, token: tok, persist: false)
        } else {
            phase = .onboarding
        }
    }

    /// Intents / CarPlay launched cold: boot, then wait (bounded) for a server.
    func waitUntilBooted(timeout: Duration = .seconds(8)) async -> Bool {
        if phase == .launching && !booting { await boot() }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while phase == .launching && clock.now < deadline { try? await Task.sleep(for: .milliseconds(200)) }
        return client != nil
    }

    func connect(_ s: MusicServer, token: String, persist: Bool = true) async {
        let c = MmoClient(baseURL: s.baseURL, token: token)
        if persist {
            MusicPrefs.server = s
            keychain.set(token, for: "device-token:\(c.baseURL)")
        }
        server = s
        client = c
        let ps = ProfileStore(client: c, load: { MusicPrefs.savedProfile }, save: { MusicPrefs.savedProfile = $0 })
        profileStore = ps
        let picker = await ps.needsPicker()
        profiles = await ps.profiles
        activeProfile = await ps.active
        profileChanged()
        startHub()
        phase = picker ? .profiles : .ready
    }

    func choose(_ p: Profile) async {
        await profileStore?.select(p)
        activeProfile = p
        profileChanged()
        phase = .ready
    }

    func unlocked(_ p: Profile) {
        activeProfile = p
        profileChanged()
        phase = .ready
    }

    func switchProfile() async {
        if let ps = profileStore { profiles = (try? await ps.refresh()) ?? profiles }
        phase = .profiles
    }

    func disconnect() {
        if let s = server { keychain.delete("device-token:\(MmoClient.normalise(s.baseURL))") }
        MusicPrefs.server = nil
        MusicPrefs.savedProfile = SavedProfile()
        stopHub()
        player.stop()
        env.store = nil
        server = nil; client = nil; profileStore = nil; activeProfile = nil; profiles = []
        phase = .onboarding
        MusicWidgetSnapshot.clear()
    }

    func adoptAccount(_ ok: DeviceTokenOk) {
        account = ok.user
        MusicPrefs.account = ok.user
        keychain.set(ok.session_token, for: "mixai-session")
    }

    func signOutAccount() {
        account = nil
        MusicPrefs.account = nil
        keychain.delete("mixai-session")
    }

    private func profileChanged() {
        guard let client else { return }
        let store = MusicStore(client: client, profile: profileId)
        env.store = store
        Task { await hub?.setProfile(activeProfile?.id) }
        Task { await restoreQueue(store) }
    }

    /// Resume where this profile left off (server queue), paused.
    private func restoreQueue(_ store: MusicStore) async {
        guard player.queue.isEmpty, let q = try? await store.queue(), !q.trackIds.isEmpty else { return }
        let tracks = (try? await store.tracks(ids: q.trackIds)) ?? []
        guard !tracks.isEmpty else { return }
        let index = min(max(0, q.index), tracks.count - 1)
        player.restore(tracks, index: index, positionSec: q.positionSec,
                       repeatMode: RepeatMode(rawValue: q.repeat.rawValue) ?? .off, store: store)
    }

    // MARK: hub (outputs + this phone as a music output)

    private func startHub() {
        guard let client else { return }
        stopHub()
        let h = HubClient(client: client, deviceId: MusicPrefs.deviceId, deviceName: ClientIdentity.current.deviceName,
                          profileId: activeProfile?.id, caps: HubClient.musicCaps)
        hub = h
        let me = MusicPrefs.deviceId
        let (devices, devCont) = AsyncStream.makeStream(of: [HubDevice].self, bufferingPolicy: .bufferingNewest(1))
        let (commands, cmdCont) = AsyncStream.makeStream(of: HubCommand.self, bufferingPolicy: .bufferingNewest(20))
        hubTasks = [
            Task { for await list in devices { self.player.remoteOutputs = Self.outputs(list, me: me) } },
            Task { for await c in commands { await self.handle(c) } },
        ]
        Task {
            await h.onDevices { _ = devCont.yield($0) }
            await h.onCommand { _ = cmdCont.yield($0) }
            await h.start()
        }
    }

    private func stopHub() {
        let old = hub
        Task { await old?.stop() }
        hubTasks.forEach { $0.cancel() }
        hubTasks = []
        hub = nil
        player.remoteOutputs = []
    }

    /// Devices that take a music queue: MixAI TVs and other MixAI Music apps (caps `music`), never guests or me.
    nonisolated static func outputs(_ list: [HubDevice], me: String) -> [RemoteOutput] {
        list.filter { $0.deviceId != me && !$0.guest && $0.caps.contains("music") }
            .map { RemoteOutput(id: $0.deviceId, name: $0.name, platform: $0.platform) }
    }

    private func handoff(_ o: RemoteOutput, _ input: MusicQueueInput) async -> Bool {
        guard let client else { return false }
        var args: [String: JSONValue] = [
            "trackIds": .array(input.trackIds.map { .string($0) }),
            "index": .number(Double(input.index ?? 0)),
            "positionSec": .number(input.positionSec ?? 0),
            "shuffle": .bool(input.shuffle ?? false),
        ]
        if let r = input.repeat { args["repeat"] = .string(r.rawValue) }
        let ack = try? await PhoneStore(client: client, profile: profileId).command(target: o.id, action: "play", args: args)
        if ack?.ok == true { toast = String(localized: "music.handoff_ok \(o.name)") }
        return ack?.ok == true
    }

    /// Another device sends its queue here (`play {trackIds,index,positionSec}`) or remote-controls playback.
    private func handle(_ c: HubCommand) async {
        var ok = true
        var err: String?
        switch c.action {
        case "play":
            if let ids = c.args["trackIds"]?.arrayValue?.compactMap(\.stringValue), !ids.isEmpty, let store = env.store {
                let tracks = (try? await store.tracks(ids: ids)) ?? []
                if tracks.isEmpty { ok = false; err = "no_tracks"; break }
                let i = Int(c.args["index"]?.doubleValue ?? 0)
                player.play(tracks, at: min(max(0, i), tracks.count - 1), store: store)
                if let p = c.args["positionSec"]?.doubleValue, p > 1 { player.seek(p) }
            } else if player.current != nil {
                player.play()
            } else {
                ok = false; err = "nothing_to_play"
            }
        case "pause": player.pause()
        case "resume": player.play()
        case "stop": player.stop()
        case "next": player.next()
        case "previous": player.previous()
        case "seek":
            if let p = c.args["positionSec"]?.doubleValue { player.seek(p) } else { ok = false; err = "bad_args" }
        default:
            ok = false; err = "unsupported"
        }
        let h = hub, seq = c.seq, success = ok, error = err
        Task { await h?.ack(seq: seq, ok: success, error: error) }
    }

    // MARK: player side effects

    private func playerChanged() {
        downloads.syncUpcoming(queue: player.queue)
        reportHubState()
        Task { await MusicWidgetSnapshot.write(player: player, store: env.store, serverName: server?.name) }
    }

    private func reportHubState() {
        guard let h = hub else { return }
        guard let t = player.current else {
            if lastHubSig != "idle" { lastHubSig = "idle"; Task { await h.reportIdle() } }
            return
        }
        let sig = "\(t.id)|\(player.playing)"
        guard sig != lastHubSig else { return }
        lastHubSig = sig
        let media = HubMedia(kind: "music", title: t.title, durationSec: t.durationSec, trackId: t.id, artist: t.artist, album: t.album,
                             coverUrlPath: t.coverUrlPath)
        let playing = player.playing, pos = player.position
        Task { await h.reportState(playing: playing, positionSec: pos, durationSec: t.durationSec, media: media) }
    }

    // MARK: deep links (`mixai-music://album/<id>`, `artist/<id>`, `nowplaying`, `mix`, `downloads`)

    func handle(url: URL) {
        guard url.scheme == "mixai-music" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host {
        case "album": if let id = parts.first { selectedTab = 0; pendingRoute = .album(id) }
        case "artist": if let id = parts.first { selectedTab = 0; pendingRoute = .artist(id) }
        case "nowplaying": if player.current != nil { player.showNowPlaying = true }
        case "downloads": selectedTab = 2
        case "mix": if let s = env.store { Task { await player.startMix(store: s) } }
        case "play":
            // From MixAI TV / web: `mixai-music://play?ids=tr_1,tr_2&index=0`.
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let ids = q.first { $0.name == "ids" }?.value?.split(separator: ",").map(String.init) ?? []
            let index = Int(q.first { $0.name == "index" }?.value ?? "0") ?? 0
            if !ids.isEmpty, let s = env.store {
                Task {
                    let tracks = (try? await s.tracks(ids: ids)) ?? []
                    if !tracks.isEmpty { player.play(tracks, at: min(index, tracks.count - 1), store: s); player.showNowPlaying = true }
                }
            }
        default: break
        }
    }
}

/// UserDefaults preferences of MixAI Music (no secrets).
enum MusicPrefs {
    private static var d: UserDefaults { .standard }

    static var server: MusicServer? {
        get { d.data(forKey: "server").flatMap { try? JSONDecoder().decode(MusicServer.self, from: $0) } }
        set { d.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "server") }
    }

    static var savedProfile: SavedProfile {
        get { d.data(forKey: "profile").flatMap { try? JSONDecoder().decode(SavedProfile.self, from: $0) } ?? SavedProfile() }
        set { d.set(try? JSONEncoder().encode(newValue), forKey: "profile") }
    }

    static var account: SessionUser? {
        get { d.data(forKey: "account").flatMap { try? JSONDecoder().decode(SessionUser.self, from: $0) } }
        set { d.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "account") }
    }

    static var origin: String {
        get { d.string(forKey: "origin") ?? MixaiOrigin.cloudRun }
        set { d.set(newValue, forKey: "origin") }
    }

    static var deviceId: String {
        if let id = d.string(forKey: "deviceId") { return id }
        let id = "ios-music-" + UUID().uuidString.lowercased()
        d.set(id, forKey: "deviceId")
        return id
    }
}
