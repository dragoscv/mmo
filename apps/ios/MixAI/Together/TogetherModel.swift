import Foundation
import MixaiCore
import Observation

/// Watch Together on the phone: room state from hub `room:*` messages, synced playback with drift correction,
/// chat + reactions + moderation (report / block / kick).
@MainActor
@Observable
final class TogetherModel {
    static let reactions = ["👍", "😂", "😮", "❤️", "🔥", "👏"]

    private(set) var state = RoomState()
    var error: String?

    @ObservationIgnored weak var app: AppModel?
    @ObservationIgnored private var drift = DriftCorrector()
    @ObservationIgnored private var syncTask: Task<Void, Never>?
    @ObservationIgnored private var loadedFileId: String?
    @ObservationIgnored private var correctingRate = false

    var inRoom: Bool { state.inRoom }

    func apply(_ v: JSONValue) {
        let before = state
        guard state.apply(v) else { return }
        if let e = state.lastError, e != before.lastError { error = String(localized: "together.error \(e)") }
        if state.media != before.media || state.anchor != before.anchor { followRoom() }
        if state.inRoom && syncTask == nil { startSync() }
        if !state.inRoom { stopSync() }
    }

    func reset() {
        stopSync()
        state = RoomState()
        loadedFileId = nil
    }

    // MARK: room lifecycle

    func create(name: String) async {
        await send(RoomMessage.create(name: name.isEmpty ? nil : name))
    }

    func join(invite: String) async {
        let raw = invite.trimmingCharacters(in: .whitespacesAndNewlines)
        // Accept a pasted link, a full invite (<roomId>.<exp>.<mac>) or a bare room id.
        if let url = URL(string: raw), let link = parseTogetherLink(url) {
            if let s = app?.server, MmoClient.normalise(link.server) != MmoClient.normalise(s.baseURL) {
                error = String(localized: "together.other_server")
                return
            }
            await join(roomId: roomId(fromInvite: link.invite) ?? link.invite)
        } else {
            await join(roomId: roomId(fromInvite: raw) ?? raw)
        }
    }

    func join(roomId: String) async {
        guard !roomId.isEmpty else { return }
        error = nil
        await send(RoomMessage.join(roomId))
    }

    func leave() async {
        await send(RoomMessage.leave)
        reset()
    }

    /// Host: load what plays locally (or the given request) for everyone.
    func loadCurrent() async {
        guard let app, let req = app.player.request, case .file(let fid, let ref, _) = req.source else {
            error = String(localized: "together.nothing_playing")
            return
        }
        let media = HubMedia(fileId: fid, kind: ref?.kind.rawValue, tmdbId: ref?.tmdbId, season: ref?.season, episode: ref?.episode, title: req.title,
                             durationSec: app.player.duration > 0 ? app.player.duration : nil)
        loadedFileId = fid
        await send(RoomMessage.load(media, at: app.player.position))
    }

    // MARK: local controls → room

    func localPlay() async {
        guard let p = app?.player else { return }
        p.play()
        await send(RoomMessage.play(at: p.position))
    }

    func localPause() async {
        guard let p = app?.player else { return }
        p.pause()
        await send(RoomMessage.pause(at: p.position))
    }

    func localSeek(_ sec: Double) async {
        guard let p = app?.player else { return }
        let target = max(0, sec)
        p.seek(to: target)
        await send(RoomMessage.seek(target))
    }

    // MARK: chat / moderation

    func sendChat(_ text: String) async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        await send(RoomMessage.chat(t))
    }

    func react(_ emoji: String) async {
        await send(RoomMessage.react(emoji, mediaSec: app?.player.position ?? 0))
    }

    func report(messageId: String, reason: String) async {
        await send(RoomMessage.reportMessage(messageId, reason: reason, roomId: state.roomId))
    }

    func block(_ member: RoomState.Member) async { await send(RoomMessage.block(memberConnId: member.connId)) }

    /// Block the author of a chat line (by connId).
    func block(connId: String) async { await send(RoomMessage.block(memberConnId: connId)) }

    func unblock(deviceId: String) async { await send(RoomMessage.unblock(deviceId: deviceId)) }

    func kick(_ member: RoomState.Member) async {
        guard state.isHost else { return }
        await send(RoomMessage.kick(memberConnId: member.connId))
    }

    private func send(_ m: [String: JSONValue]) async {
        guard let hub = app?.hub else {
            error = String(localized: "together.no_server")
            return
        }
        await hub.sendRaw(m)
    }

    // MARK: synced playback

    /// New media / anchor from the room: start the title if it is not the one playing; apply play/pause.
    private func followRoom() {
        guard let app, state.inRoom, let m = state.media, let fid = m.fileId else { return }
        let anchor = state.anchor
        var playingFid: String?
        if let r = app.player.request, case .file(let f, _, _) = r.source { playingFid = f }
        if playingFid != fid {
            var ref: MediaRef?
            if let k = m.kind.flatMap(MediaKind.init(rawValue:)), let id = m.tmdbId { ref = MediaRef(kind: k, tmdbId: id, season: m.season, episode: m.episode) }
            loadedFileId = fid
            drift.reset()
            app.player.start(PlayRequest(source: .file(fileId: fid, ref: ref, startSec: anchor?.positionSec ?? 0), title: m.title ?? "MixAI TV", subtitle: nil, artwork: nil), app: app)
            let pos = anchor?.positionSec ?? 0
            Task { await self.send(RoomMessage.ready(true, positionSec: pos)) }
        }
        if let a = anchor {
            if a.playing && !app.player.playing { app.player.play() }
            if !a.playing && app.player.playing { app.player.pause() }
        }
    }

    private func startSync() {
        syncTask?.cancel()
        syncTask = Task {
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                tick += 1
                await self.correct(reportNow: tick % 5 == 0)
            }
        }
    }

    private func stopSync() {
        syncTask?.cancel()
        syncTask = nil
        if correctingRate { app?.player.setSpeed(1); correctingRate = false }
        drift.reset()
    }

    private func correct(reportNow: Bool) async {
        guard let app, let hub = app.hub, state.inRoom, let a = state.anchor, let fid = state.media?.fileId else { return }
        guard let r = app.player.request, case .file(let f, _, _) = r.source, f == fid else { return }
        let now = await hub.serverNowMs()
        if a.playing && !app.player.buffering {
            let expected = expectedPosition(a, serverNowMs: now)
            switch drift.update(actualSec: app.player.position, expectedSec: expected) {
            case .seek(let x):
                app.player.seek(to: x)
                if correctingRate { app.player.setSpeed(1); correctingRate = false }
            case .rate(let rate):
                app.player.setSpeed(Float(rate))
                correctingRate = true
            case .none:
                if correctingRate { app.player.setSpeed(1); correctingRate = false }
            }
        }
        if reportNow {
            let rtt = await hub.clock.rttMs
            await hub.sendRaw(RoomMessage.report(positionSec: app.player.position, rttMs: rtt))
        }
    }
}
