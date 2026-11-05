import Foundation
import MixaiCore
import Network
import Observation
import SwiftUI
import UIKit

/// Persisted connection to one MMO Server (paired device token lives in the Keychain).
struct ServerConnection: Codable, Equatable, Sendable {
    var name: String
    var baseURL: String
}

/// App-wide state: connection, active profile, stores. Lives on the main actor.
@MainActor
@Observable
final class AppModel {
    /// One per process: the app delegate (push, background downloads, BG tasks), intents and CarPlay reach it here.
    static let shared = AppModel()

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
    let offline = OfflineStore()
    let accountStore = AccountStore()
    let push = PushManager()
    let activities = LiveActivityCenter()
    let together = TogetherModel()
    let watch = WatchBridge()

    /// Data saver: on an expensive network ask before streaming the original and refuse downloads.
    var dataSaver: Bool = Prefs.flag("dataSaver", default: true) { didSet { Prefs.setFlag("dataSaver", dataSaver) } }
    /// Cellular / personal hotspot / Low Data Mode (NWPathMonitor).
    var networkExpensive = false
    var networkOnline = true
    /// Other devices on the hub (this iPhone excluded); TVs carry `playbackTarget == true`.
    var hubDevices: [HubDevice] = []
    var selectedTab = 0
    /// Deep link / intent / menu target, consumed by the selected tab's NavigationStack.
    var pendingRoute: Route?
    var showPlayOn = false
    var playOnRequest: PlayRequest?
    /// Short banner over the tabs ("Continue on Living room TV", link errors).
    var toast: String?
    /// Remote volume level sent to TVs (they take an absolute 0...100).
    var remoteVolume = 50

    var phone: PhoneStore? { client.map { PhoneStore(client: $0, profile: profileId) } }
    var playbackTargets: [HubDevice] { hubDevices.filter { $0.playbackTarget == true } }

    private let pathMonitor = NWPathMonitor()
    @ObservationIgnored private var hubTasks: [Task<Void, Never>] = []
    @ObservationIgnored private var platformLoop: Task<Void, Never>?
    @ObservationIgnored private var lastHubState = ""
    @ObservationIgnored private var lastHubStateAt = Date.distantPast
    @ObservationIgnored private var booting = false

    init() {
        offline.app = self
        together.app = self
        startPathMonitor()
    }

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
        guard phase == .launching, !booting else { return }
        booting = true
        accountStore.restore(app: self)
        watch.activate()
        activities.observePushToStart(app: self)
        startPlatformLoop()
        Task { await push.refresh(app: self) }
        if let s = Prefs.server, let tok = Keychain.get("device-token:\(s.baseURL)"), !tok.isEmpty {
            await connect(s, token: tok, persist: false)
        } else {
            phase = .onboarding
        }
    }

    /// Intents launched cold (possibly without a UI scene, so RootView never booted): boot, then wait (bounded).
    func waitUntilBooted(timeout: Duration = .seconds(8)) async -> Bool {
        if phase == .launching && !booting { await boot() }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while phase == .launching && clock.now < deadline { try? await Task.sleep(for: .milliseconds(200)) }
        return client != nil
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
        offline.resumePending()
        Task { await offline.flushProgress() }
    }

    func rebuildProfileScoped() {
        guard let client else { return }
        progress = ProgressSync(store: MediaStore(client: client, profile: profileId),
                                queueFile: Self.cacheDir.appendingPathComponent("progress-queue-\(HomeStore.fileName(for: profileId))"))
        Task { await hub?.setProfile(activeProfile?.id) }
        Task { await push.register(app: self) }
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
        let old = hub
        Task { await old?.stop() }
        hubTasks.forEach { $0.cancel() }
        hubTasks = []
        together.reset()
        player.stop()
        music.stop()
        server = nil; client = nil; homeStore = nil; profileStore = nil; activeProfile = nil; profiles = []; hub = nil; hubDevices = []
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
        let old = hub
        Task { await old?.stop() }
        hubTasks.forEach { $0.cancel() }
        together.reset()
        let h = HubClient(client: client, deviceId: Prefs.deviceId, deviceName: ClientIdentity.current.deviceName, profileId: activeProfile?.id)
        hub = h
        let me = Prefs.deviceId
        // Streams keep hub order (one Task per message would not) and hop to the main actor once.
        let (messages, msgCont) = AsyncStream.makeStream(of: JSONValue.self, bufferingPolicy: .bufferingNewest(500))
        let (commands, cmdCont) = AsyncStream.makeStream(of: HubCommand.self, bufferingPolicy: .bufferingNewest(50))
        let (devices, devCont) = AsyncStream.makeStream(of: [HubDevice].self, bufferingPolicy: .bufferingNewest(1))
        hubTasks = [
            Task { for await v in messages { self.together.apply(v) } },
            Task { for await c in commands { self.handleHubCommand(c) } },
            Task { for await list in devices { self.hubDevices = list.filter { $0.deviceId != me } } },
        ]
        Task {
            await h.onMessage { _ = msgCont.yield($0) }
            await h.onCommand { _ = cmdCont.yield($0) }
            await h.onDevices { _ = devCont.yield($0) }
            await h.start()
        }
    }

    // MARK: network

    private func startPathMonitor() {
        // @Sendable: a closure formed here would otherwise be inferred @MainActor and trap on the monitor queue.
        pathMonitor.pathUpdateHandler = { @Sendable path in
            let expensive = path.isExpensive || path.isConstrained
            let online = path.status == .satisfied
            Task { @MainActor in AppModel.shared.networkChanged(expensive: expensive, online: online) }
        }
        pathMonitor.start(queue: DispatchQueue(label: "ro.mixai.app.path"))
    }

    private func networkChanged(expensive: Bool, online: Bool) {
        let cameOnline = online && !networkOnline
        networkExpensive = expensive
        networkOnline = online
        if cameOnline {
            Task { await offline.flushProgress() }
        }
        if online { offline.resumePaused() }
    }

    // MARK: this iPhone as a "Play on" target (hub commands)

    private func handleHubCommand(_ c: HubCommand) {
        var ok = true
        var err: String?
        let video = player.request != nil
        switch c.action {
        case "play":
            if let fid = c.args["fileId"]?.stringValue {
                let start = c.args["startSec"]?.doubleValue ?? 0
                var ref: MediaRef?
                if let k = c.args["kind"]?.stringValue.flatMap(MediaKind.init(rawValue:)), let id = c.args["tmdbId"]?.doubleValue {
                    ref = MediaRef(kind: k, tmdbId: Int(id), season: c.args["season"]?.doubleValue.map { Int($0) }, episode: c.args["episode"]?.doubleValue.map { Int($0) })
                }
                player.start(PlayRequest(source: .file(fileId: fid, ref: ref, startSec: start), title: c.args["title"]?.stringValue ?? "MixAI", subtitle: nil, artwork: nil), app: self)
            } else if video {
                player.play()
            } else if music.current != nil {
                music.play()
            } else {
                ok = false
                err = "nothing_to_play"
            }
        case "pause":
            if video { player.pause() } else { music.pause() }
        case "resume":
            if video { player.play() } else { music.play() }
        case "seek":
            if let p = c.args["positionSec"]?.doubleValue {
                if video { player.seek(to: p) } else { music.seek(p) }
            } else {
                ok = false
                err = "bad_args"
            }
        case "stop":
            if video { player.dismiss() } else { music.stop() }
        case "next":
            if video { player.skip(30) } else { music.next() }
        case "previous":
            if video { player.skip(-10) } else { music.previous() }
        default:
            ok = false
            err = "unsupported"
        }
        let h = hub, seq = c.seq, success = ok, error = err
        Task { await h?.ack(seq: seq, ok: success, error: error) }
    }

    /// TV position now (`at` = server ms of `positionSec`).
    nonisolated static func livePosition(_ np: HubNowPlaying) -> Double {
        guard np.playing else { return np.positionSec }
        return np.positionSec + max(0, Date().timeIntervalSince1970 - Double(np.at) / 1000)
    }

    // MARK: watch / widgets / hub state (2 s loop)

    private func startPlatformLoop() {
        platformLoop?.cancel()
        platformLoop = Task {
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                tick += 1
                self.watch.push(self.watchContext())
                self.reportHubState()
                if tick % 15 == 1 { await WidgetWriter.update(app: self) }
            }
        }
    }

    private func watchContext() -> WatchContext {
        let tvs = playbackTargets.map { d in
            WatchContext.Tv(id: d.deviceId, name: d.name, nowPlaying: d.nowPlaying?.media?.title, playing: d.nowPlaying?.playing ?? false)
        }
        if let r = player.request {
            let live: Bool
            if case .live = r.source { live = true } else { live = false }
            return WatchContext(title: r.title, subtitle: r.subtitle, playing: player.playing, positionSec: player.position, durationSec: player.duration,
                                source: live ? "live" : "video", tvs: tvs, serverName: server?.name)
        }
        if let t = music.current {
            return WatchContext(title: t.title, subtitle: t.artist, playing: music.playing, positionSec: music.position, durationSec: t.durationSec,
                                source: "music", tvs: tvs, serverName: server?.name)
        }
        return WatchContext(tvs: tvs, serverName: server?.name)
    }

    /// `state` to the hub on change (or every 10 s while playing) so other devices can "Continue here".
    private func reportHubState() {
        guard let h = hub else { return }
        if let r = player.request, case .file(let fid, let ref, _) = r.source {
            let sig = "v|\(fid)|\(player.playing)"
            guard sig != lastHubState || (player.playing && Date().timeIntervalSince(lastHubStateAt) > 10) else { return }
            lastHubState = sig
            lastHubStateAt = .now
            let media = HubMedia(fileId: fid, kind: ref?.kind.rawValue, tmdbId: ref?.tmdbId, season: ref?.season, episode: ref?.episode, title: r.title,
                                 durationSec: player.duration > 0 ? player.duration : nil)
            let playing = player.playing, pos = player.position, dur: Double? = player.duration > 0 ? player.duration : nil
            Task { await h.reportState(playing: playing, positionSec: pos, durationSec: dur, media: media) }
        } else if player.request == nil, music.current == nil, lastHubState != "idle" {
            lastHubState = "idle"
            Task { await h.reportIdle() }
        }
    }

    /// Watch → phone (target nil) or → a TV (target = hub deviceId).
    func applyWatch(_ cmd: WatchCommand) {
        if let target = cmd.target {
            Task { await remote(target, action: cmd.action) }
            return
        }
        let video = player.request != nil
        switch cmd.action {
        case .toggle: if video { player.togglePlay() } else { music.toggle() }
        case .play: if video { player.play() } else { music.play() }
        case .pause: if video { player.pause() } else { music.pause() }
        case .next: if video { player.skip(30) } else { music.next() }
        case .previous: if video { player.skip(-10) } else { music.previous() }
        case .skipForward: if video { player.skip(30) } else { music.seek(music.position + 30) }
        case .skipBack: if video { player.skip(-10) } else { music.seek(max(0, music.position - 10)) }
        case .volumeUp, .volumeDown, .navigateHome: break
        }
    }

    private func remote(_ target: String, action a: WatchCommand.Action) async {
        guard let phone else { return }
        let np = hubDevices.first { $0.deviceId == target }?.nowPlaying
        let pos = np.map(Self.livePosition) ?? 0
        let action: String
        var args: [String: JSONValue] = [:]
        switch a {
        case .toggle: action = (np?.playing ?? false) ? "pause" : "resume"
        case .play: action = "resume"
        case .pause: action = "pause"
        case .next: action = "next"
        case .previous: action = "previous"
        case .skipForward: action = "seek"; args["positionSec"] = .number(pos + 30)
        case .skipBack: action = "seek"; args["positionSec"] = .number(max(0, pos - 10))
        case .volumeUp: remoteVolume = min(100, remoteVolume + 10); action = "volume"; args["level"] = .number(Double(remoteVolume))
        case .volumeDown: remoteVolume = max(0, remoteVolume - 10); action = "volume"; args["level"] = .number(Double(remoteVolume))
        case .navigateHome: action = "navigate"; args["to"] = .string("home")
        }
        _ = try? await phone.command(target: target, action: action, args: args)
    }

    // MARK: deep links

    /// `mixai://title/<kind>/<id>`, `nowplaying`, `live`, `downloads`, `remote`, `together[?server=&inv=]` and the
    /// https `/together?server=&inv=` universal link.
    func handle(url: URL) {
        if let link = parseTogetherLink(url) {
            openTogether(server: link.server, invite: link.invite)
            return
        }
        guard url.scheme == "mixai" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host {
        case "title":
            if parts.count >= 2, let k = MediaKind(rawValue: parts[0]), let id = Int(parts[1]) {
                selectedTab = 0
                pendingRoute = .title(kind: k, tmdbId: id, posterPath: nil)
            }
        case "nowplaying":
            if player.request != nil { player.presented = true } else if music.current != nil { music.showNowPlaying = true }
        case "live":
            selectedTab = 4
        case "downloads":
            pendingRoute = .downloads
        case "remote":
            pendingRoute = .remote
        case "together":
            pendingRoute = .together
        default:
            break
        }
    }

    func openTogether(server link: String, invite: String) {
        guard let s = server else {
            toast = String(localized: "together.no_server")
            return
        }
        guard MmoClient.normalise(link) == MmoClient.normalise(s.baseURL) else {
            toast = String(localized: "together.other_server")
            return
        }
        selectedTab = 0
        pendingRoute = .together
        Task { await together.join(invite: invite) }
    }

    /// Notification tap / action (`url`, optional `fileId` + `title` for "Download").
    func handleNotification(action: String, url: String?, fileId: String?, title: String?) {
        if action == "DOWNLOAD", let fileId {
            offline.enqueue(fileId: fileId, audio: 0, ref: nil, title: title ?? "MixAI", show: nil, posterPath: nil, smart: false)
            pendingRoute = .downloads
            return
        }
        if let url, let u = URL(string: url) { handle(url: u) }
    }

    // MARK: intents

    /// First item of the cached "continue" row → resolve → play.
    @discardableResult
    func resumeLast() async -> Bool {
        guard let store = homeStore, let media else { return false }
        var home = await store.cached(profile: profileId)
        if home == nil { home = try? await store.fetch(profile: profileId) }
        guard let card = home?.rows.first(where: { $0.id == "continue" })?.items.first,
              let detail = try? await media.title(kind: card.kind, tmdbId: card.tmdbId),
              let target = await PlayResolver.resolve(detail, store: media) else { return false }
        var subtitle: String?
        if let s = target.ref.season, let e = target.ref.episode { subtitle = "S\(s) E\(e)" }
        player.start(PlayRequest(source: .file(fileId: target.fileId, ref: target.ref, startSec: target.resumeSec ?? 0),
                                 title: detail.title.title, subtitle: subtitle, artwork: nil), app: self)
        return true
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

    static func flag(_ key: String, default value: Bool) -> Bool {
        d.object(forKey: key) == nil ? value : d.bool(forKey: key)
    }

    static func setFlag(_ key: String, _ value: Bool) { d.set(value, forKey: key) }

    static var deviceId: String {
        if let id = d.string(forKey: "deviceId") { return id }
        let id = "ios-" + UUID().uuidString.lowercased()
        d.set(id, forKey: "deviceId")
        return id
    }
}
