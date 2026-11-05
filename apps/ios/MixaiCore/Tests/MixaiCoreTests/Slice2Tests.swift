import Foundation
import Testing
@testable import MixaiCore

@Suite("Account API")
struct AccountTests {
    @Test func nonceHashIsSha256Hex() {
        // sha256("abc") reference vector.
        #expect(AppleNonce.sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        let n = AppleNonce.random()
        #expect(n.raw.count == 32)
        #expect(n.hashed.count == 64)
        #expect(AppleNonce.random() != n)
    }

    @Test func signInPostsNonceAndDecodesSession() async throws {
        let t = StubTransport()
        t.json("POST", "/api/auth/native/apple", #"{"session_token":"s1","sessionToken":"s1","expires":"2027-01-01T00:00:00Z","user":{"id":"u1","name":"Ana","email":null,"image":null},"created":true}"#)
        let api = AccountAPI(origin: "https://mixai.example/", transport: t)
        let s = try await api.signInWithApple(identityToken: "header.payload.sig", nonce: "raw-nonce", authorizationCode: "code1", givenName: "Ana", familyName: nil)
        #expect(s.sessionToken == "s1")
        #expect(s.user.id == "u1")
        #expect(s.created == true)
        let body = try #require(t.requests.first?.httpBody)
        let o = try JSON.decoder.decode(JSONValue.self, from: body)
        #expect(o["nonce"]?.stringValue == "raw-nonce")
        #expect(o["authorizationCode"]?.stringValue == "code1")
        #expect(o["fullName"]?["givenName"]?.stringValue == "Ana")
        #expect(t.requests.first?.url?.absoluteString == "https://mixai.example/api/auth/native/apple")
    }

    @Test func errorsMapToCodes() async {
        let t = StubTransport()
        t.json("POST", "/api/auth/native/apple", status: 401, #"{"error":"nonce_mismatch"}"#)
        t.json("POST", "/api/push/register", status: 503, #"{"error":"push_unavailable"}"#)
        t.json("DELETE", "/api/account", status: 400, #"{"error":"confirmation_required","expected":"DELETE"}"#)
        let api = AccountAPI(origin: "https://x", transport: t)
        await #expect(throws: AccountError(code: "nonce_mismatch", status: 401)) {
            _ = try await api.signInWithApple(identityToken: "a.b.c.d.e.f.g.h.i.j.k", nonce: "n", authorizationCode: nil, givenName: nil, familyName: nil)
        }
        await #expect(throws: AccountError(code: "push_unavailable", status: 503)) {
            try await api.registerPush(PushRegistration(token: String(repeating: "a", count: 64), environment: .sandbox, deviceName: nil, profileId: nil, liveActivityToken: nil), session: "s")
        }
        await #expect(throws: AccountError(code: "confirmation_required", status: 400)) {
            try await api.deleteAccount(confirmation: "nope", session: "s")
        }
    }

    @Test func pushRegisterSendsBearerAndPlatform() async throws {
        let t = StubTransport()
        t.json("POST", "/api/push/register", #"{"ok":true}"#)
        try await AccountAPI(origin: "https://x", transport: t)
            .registerPush(PushRegistration(token: "ab12", environment: .production, deviceName: "iPhone", profileId: "p1", liveActivityToken: nil), session: "tok")
        let r = try #require(t.requests.first)
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        let o = try JSON.decoder.decode(JSONValue.self, from: r.httpBody ?? Data())
        #expect(o["platform"]?.stringValue == "ios")
        #expect(o["environment"]?.stringValue == "production")
        #expect(o["liveActivityToken"] == nil)
    }

    @Test func tokenHexAndEnvironment() {
        #expect(apnsTokenHex(Data([0x00, 0xab, 0xff])) == "00abff")
        #expect(pushEnvironment(embeddedProfile: nil) == .production)
        let dev = Data("<plist><key>aps-environment</key>\n<string>development</string></plist>".utf8)
        #expect(pushEnvironment(embeddedProfile: dev) == .sandbox)
        let prod = Data("<key>aps-environment</key><string>production</string>".utf8)
        #expect(pushEnvironment(embeddedProfile: prod) == .production)
    }
}

@Suite("Phone store")
struct PhoneStoreTests {
    @Test func kickInterpretation() throws {
        let job = #"{"jobId":"j1","fileId":"f1","audio":0,"state":"running","progress":0.4,"error":null,"sizeBytes":null,"createdAt":1,"finishedAt":null}"#
        let prep = try PhoneStore.interpretKick(status: 202, body: Data(job.utf8), retryAfter: "5", readyURL: "u")
        guard case .preparing(let j, let ra) = prep else { Issue.record("not preparing"); return }
        #expect(j.progress == 0.4)
        #expect(ra == 5)
        #expect(try PhoneStore.interpretKick(status: 206, body: Data(), retryAfter: nil, readyURL: "u") == .ready(url: "u", sizeBytes: nil))
        let failed = #"{"jobId":"j1","fileId":"f1","audio":0,"state":"failed","progress":0,"error":"ffmpeg exit 1","sizeBytes":null,"createdAt":1,"finishedAt":2}"#
        #expect(try PhoneStore.interpretKick(status: 500, body: Data(failed.utf8), retryAfter: nil, readyURL: "u") == .failed("ffmpeg exit 1"))
        #expect(throws: APIStatusError.self) { try PhoneStore.interpretKick(status: 403, body: Data(#"{"error":"daily_cap"}"#.utf8), retryAfter: nil, readyURL: "u") }
    }

    @Test func downloadURLCarriesTokenAndProfile() {
        let s = PhoneStore(client: MmoClient(baseURL: "http://10.0.0.2:17899", token: "tk"), profile: "kid 1")
        #expect(s.downloadURL(fileId: "a/b", audio: 2) == "http://10.0.0.2:17899/video/download/a%2Fb?container=mp4&audio=2&profile=kid%201&t=tk")
    }

    @Test func dailyCapParse() {
        let e = APIStatusError(status: 403, body: #"{"error":"daily_cap","profileId":"k","dailyCapMin":60}"#)
        #expect(DailyCapError.parse(e)?.dailyCapMin == 60)
        #expect(DailyCapError.parse(APIStatusError(status: 403, body: #"{"error":"profile_locked"}"#)) == nil)
    }

    @Test func bookmarkKeysAndClamp() {
        let r = MediaRef(kind: .tv, tmdbId: 1399, season: 1, episode: 2)
        #expect(BookmarkInput.titleKey(ref: r, fileId: "f") == "tv:1399:s1e2")
        #expect(BookmarkInput.titleKey(ref: MediaRef(kind: .movie, tmdbId: 603), fileId: nil) == "movie:603")
        #expect(BookmarkInput.titleKey(ref: nil, fileId: "f9") == "file:f9")
        let b = BookmarkInput(ref: nil, fileId: "f9", sec: 999_999, label: String(repeating: "x", count: 300))
        #expect(b.sec == 172_800)
        #expect(b.label?.count == 120)
        #expect(b.fileId == "f9")
    }

    @Test func togetherLinks() throws {
        let u = try #require(togetherInviteURL(origin: "https://mixai.ro", serverBaseURL: "http://192.168.1.5:17899", invite: "r1.123.mac"))
        #expect(u.absoluteString.hasPrefix("https://mixai.ro/together?server=http://192.168.1.5:17899&inv=r1.123.mac"))
        let p = try #require(parseTogetherLink(u))
        #expect(p.server == "http://192.168.1.5:17899")
        #expect(p.invite == "r1.123.mac")
        #expect(parseTogetherLink(URL(string: "mixai://together?server=s&inv=i")!)?.invite == "i")
        #expect(parseTogetherLink(URL(string: "https://mixai.ro/media")!) == nil)
        #expect(roomId(fromInvite: "abc.1700.mac") == "abc")
        #expect(roomId(fromInvite: "bad") == nil)
    }
}

@Suite("Offline library")
struct OfflineLibraryTests {
    func ep(_ s: Int, _ e: Int, show: Int = 1399, added: TimeInterval = 0) -> DownloadItem {
        var i = DownloadItem(fileId: "f\(show)-\(s)-\(e)", ref: MediaRef(kind: .tv, tmdbId: show, season: s, episode: e), title: "E\(e)", show: "Show \(show)",
                             addedAt: Date(timeIntervalSince1970: added))
        i.state = .done
        i.bytesTotal = 100
        return i
    }

    @Test func groupsShowsBySeasonAndMoviesAlone() {
        var movie = DownloadItem(fileId: "m1", ref: MediaRef(kind: .movie, tmdbId: 603), title: "Matrix", addedAt: Date(timeIntervalSince1970: 50))
        movie.state = .done
        movie.bytesTotal = 1000
        let groups = OfflineLibrary.group([ep(1, 2), ep(2, 1), ep(1, 1), movie])
        #expect(groups.count == 2)
        #expect(groups[0].title == "Matrix")
        #expect(groups[0].isShow == false)
        let show = groups[1]
        #expect(show.isShow)
        #expect(show.seasons.map(\.number) == [1, 2])
        #expect(show.seasons[0].items.map { $0.ref?.episode } == [1, 2])
        #expect(show.bytes == 300)
    }

    @Test func autoDeleteOnlyWatchedOlderThan24h() {
        let now = Date(timeIntervalSince1970: 100_000)
        var a = ep(1, 1); a.watchedAt = now.addingTimeInterval(-25 * 3600); a.smart = true
        var b = ep(1, 2); b.watchedAt = now.addingTimeInterval(-2 * 3600); b.smart = true
        var c = ep(1, 3); c.watchedAt = now.addingTimeInterval(-30 * 3600); c.smart = false
        #expect(OfflineLibrary.expired([a, b, c], now: now, all: false).map(\.id) == [a.id])
        #expect(Set(OfflineLibrary.expired([a, b, c], now: now, all: true).map(\.id)) == [a.id, c.id])
    }

    @Test func smartNextEpisodes() {
        let avail = [(1, 3, "c"), (1, 1, "a"), (2, 1, "d"), (1, 2, "b"), (0, 1, "special"), (2, 2, "e")].map { (season: $0.0, episode: $0.1, fileId: $0.2) }
        let next = OfflineLibrary.nextEpisodes(available: avail, watchedUpTo: (1, 1), have: ["c"])
        #expect(next.map(\.fileId) == ["b", "d", "e"])
        #expect(OfflineLibrary.nextEpisodes(available: avail, watchedUpTo: nil, have: [], count: 2).map(\.fileId) == ["a", "b"])
    }

    @Test func gauge() {
        let g = OfflineLibrary.gauge(items: [ep(1, 1), ep(1, 2)], freeBytes: 800)
        #expect(g.used == 200)
        #expect(abs(g.fraction - 0.2) < 1e-9)
    }
}

@Suite("Room state")
struct RoomStateTests {
    func v(_ s: String) -> JSONValue { try! JSON.decoder.decode(JSONValue.self, from: Data(s.utf8)) }

    @Test func joinStateMembersChatBlock() {
        var r = RoomState()
        r.apply(v(#"{"type":"welcome","you":{"connId":"c1"}}"#))
        r.apply(v(#"{"type":"room:created","roomId":"R","invite":"R.1.m"}"#))
        r.apply(v(#"{"type":"room:joined","roomId":"R","name":"Movie night","invite":"R.1.m"}"#))
        r.apply(v(#"{"type":"room:members","roomId":"R","hostConnId":"c1","members":[{"connId":"c1","deviceId":"d1","name":"Me","ready":true,"guest":false},{"connId":"c2","deviceId":"d2","name":"Ion","ready":false,"guest":true}]}"#))
        r.apply(v(#"{"type":"room:state","roomId":"R","phase":"playing","media":{"fileId":"f1","title":"River"},"anchor":{"playing":true,"positionSec":12.5,"atServerMs":1000},"serverTime":1000}"#))
        #expect(r.inRoom)
        #expect(r.isHost)
        #expect(r.name == "Movie night")
        #expect(r.members.count == 2)
        #expect(r.phase == .playing)
        #expect(r.media?.fileId == "f1")
        #expect(r.anchor == PlaybackAnchor(playing: true, positionSec: 12.5, atServerMs: 1000))
        r.apply(v(#"{"type":"room:chat","id":"m1","from":{"connId":"c2","deviceId":"d2","name":"Ion"},"text":"salut ***","masked":true,"ts":5}"#))
        r.apply(v(#"{"type":"room:react","id":"r1","from":{"connId":"c2","deviceId":"d2","name":"Ion"},"emoji":"🔥","mediaSec":13,"ts":6}"#))
        #expect(r.chat.count == 2)
        #expect(r.chat[0].masked)
        r.apply(v(#"{"type":"report:ok","messageId":"m1","reportId":"x"}"#))
        #expect(r.reported.contains("m1"))
        r.apply(v(#"{"type":"block:ok","deviceId":"d2","blocked":true}"#))
        #expect(r.chat.isEmpty)
        r.apply(v(#"{"type":"room:chat","id":"m2","from":{"connId":"c2","deviceId":"d2","name":"Ion"},"text":"hidden","ts":7}"#))
        #expect(r.chat.isEmpty)
        r.apply(v(#"{"type":"room:left","roomId":"R"}"#))
        #expect(!r.inRoom)
        #expect(r.blockedDeviceIds.contains("d2"))
        #expect(r.me == "c1")
    }

    @Test func kickAndErrors() {
        var r = RoomState()
        r.apply(v(#"{"type":"room:joined","roomId":"R","name":"x"}"#))
        r.apply(v(#"{"type":"room:kicked","roomId":"R"}"#))
        #expect(r.kicked)
        #expect(!r.inRoom)
        var s = RoomState()
        let handled = s.apply(v(#"{"type":"error","error":"room_not_found"}"#))
        #expect(handled)
        #expect(s.lastError == "room_not_found")
        let other = s.apply(v(#"{"type":"devices","devices":[]}"#))
        #expect(!other)
    }

    @Test func outgoingShapes() {
        #expect(RoomMessage.kick(memberConnId: "c2")["type"]?.stringValue == "kick")
        #expect(RoomMessage.reportMessage("m1", reason: "spam", roomId: "R")["roomId"]?.stringValue == "R")
        #expect(RoomMessage.chat(String(repeating: "a", count: 900))["text"]?.stringValue?.count == 500)
        let load = RoomMessage.load(HubMedia(fileId: "f1", title: "River"), at: 3)
        #expect(load["media"]?["fileId"]?.stringValue == "f1")
        #expect(RoomMessage.play(at: nil)["positionSec"] == nil)
    }
}

@Suite("Player math")
struct PlayerMathTests {
    @Test func sleepFade() {
        #expect(sleepFadeVolume(remainingSec: 120) == 1)
        #expect(sleepFadeVolume(remainingSec: 15) == 0.5)
        #expect(sleepFadeVolume(remainingSec: 0) == 0)
        #expect(sleepFadeVolume(remainingSec: 10, fadeSec: 0) == 1)
    }

    @Test func compressorReducesLoudAndLiftsQuiet() {
        let c = NightCompressor()
        let quiet = c.targetGain(rms: NightCompressor.linear(-40))
        let loud = c.targetGain(rms: NightCompressor.linear(-6))
        #expect(abs(NightCompressor.db(quiet) - 6) < 0.01)            // below threshold: make-up only
        #expect(abs(NightCompressor.db(loud) - (6 - 13.5)) < 0.01)     // 18 dB over → 13.5 dB reduction
        #expect(c.targetGain(rms: 0.9) * 0.9 <= 1.0001)
        var s = NightCompressor()
        let g1 = s.process(rms: NightCompressor.linear(-6))
        #expect(g1 < 1 && g1 > c.targetGain(rms: NightCompressor.linear(-6)))   // smoothed towards the target
    }

    @Test func dualAndSearch() {
        let a = [SubtitleCue(start: 1, end: 3, text: "Hello there"), SubtitleCue(start: 5, end: 7, text: "Ce mai faci, Ștefan?")]
        #expect(dualSubtitleLine(primary: "x", secondaryCues: a, at: 2) == "Hello there")
        #expect(dualSubtitleLine(primary: "Hello there", secondaryCues: a, at: 2) == nil)
        #expect(dualSubtitleLine(primary: nil, secondaryCues: a, at: 4) == nil)
        #expect(searchCues(a, query: "stefan FACI").map(\.start) == [5])
        #expect(searchCues(a, query: "  ").isEmpty)
    }

    @Test func dataSaver() {
        #expect(dataSaverDecision(expensive: false, saverOn: true, acknowledged: false, isDownload: true) == .play)
        #expect(dataSaverDecision(expensive: true, saverOn: true, acknowledged: false, isDownload: false) == .ask)
        #expect(dataSaverDecision(expensive: true, saverOn: true, acknowledged: true, isDownload: false) == .play)
        #expect(dataSaverDecision(expensive: true, saverOn: true, acknowledged: true, isDownload: true) == .blockDownload)
        #expect(dataSaverDecision(expensive: true, saverOn: false, acknowledged: false, isDownload: true) == .play)
    }

    @Test func vlcFallbackRule() {
        #expect(shouldFallBackToVLC(errorDomain: "AVFoundationErrorDomain", errorCode: -11828, underlyingCodes: []))
        #expect(shouldFallBackToVLC(errorDomain: "AVFoundationErrorDomain", errorCode: -11800, underlyingCodes: [-12847]))
        #expect(!shouldFallBackToVLC(errorDomain: "AVFoundationErrorDomain", errorCode: -11800, underlyingCodes: [-1009]))
        #expect(!shouldFallBackToVLC(errorDomain: "NSURLErrorDomain", errorCode: -1009, underlyingCodes: []))
    }
}

@Suite("Intents parsing")
struct IntentParsingTests {
    @Test func bestTitleMatch() {
        let titles = ["The Matrix", "Matrix Reloaded", "Școala de șoferi", "River"]
        #expect(bestMatch("matrix", in: titles) == "The Matrix")
        #expect(bestMatch("scoala", in: titles) == "Școala de șoferi")
        #expect(bestMatch("reloaded", in: titles) == "Matrix Reloaded")
        #expect(bestMatch("zzz", in: titles) == nil)
    }
}
