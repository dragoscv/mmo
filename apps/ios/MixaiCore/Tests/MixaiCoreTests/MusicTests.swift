import Foundation
import Testing
@testable import MixaiCore

private func card(_ id: String, album: String = "al_1", track: Int? = nil, disc: Int? = nil, dur: Double = 200,
                  lufs: Double? = nil, peak: Double? = nil, format: String = "flac") -> TrackCard {
    TrackCard(id: id, title: id, artist: "A", artistId: "ar_1", album: "Album", albumId: album, track: track, disc: disc,
              durationSec: dur, format: format, hasLyrics: false, hasSyncedLyrics: false, loudnessLufs: lufs, truePeakDbfs: peak,
              coverArt: "c", coverUrlPath: "/rest/getCoverArt.view?id=c", streamUrlPath: "/rest/stream.view?id=\(id)")
}

/// Deterministic RNG for shuffle tests.
private struct SeededRNG: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return state
    }
}

@Suite struct AudioPlanTests {
    @Test func gainTowardsTargetCappedByTruePeak() {
        // -20 LUFS wants +6 dB; peak -3 dBFS allows only +2 dB under the -1 dBTP ceiling.
        #expect(AudioPlan.gainDb(lufs: -20, truePeak: -3) == 2)
        // Loud master: -8 LUFS → -6 dB cut regardless of peak.
        #expect(AudioPlan.gainDb(lufs: -8, truePeak: 0) == -6)
    }

    @Test func unknownPeakOnlyAttenuatesAndUnanalysedIsZero() {
        #expect(AudioPlan.gainDb(lufs: -20, truePeak: nil) == 0)
        #expect(AudioPlan.gainDb(lufs: -10, truePeak: nil) == -4)
        #expect(AudioPlan.gainDb(lufs: nil, truePeak: -1) == 0)
        #expect(AudioPlan.gainDb(for: card("t", lufs: -10, peak: -0.5), normalize: false) == 0)
    }

    @Test func gainClampedToLimits() {
        #expect(AudioPlan.gainDb(lufs: -60, truePeak: -40) == AudioPlan.maxBoostDb)
        #expect(AudioPlan.gainDb(lufs: 20, truePeak: 0) == AudioPlan.maxCutDb)
    }

    @Test func albumContinuationIsGaplessIncludingDiscChange() {
        #expect(AudioPlan.isAlbumContinuation(card("a", track: 3), card("b", track: 4)))
        #expect(AudioPlan.isAlbumContinuation(card("a", track: 12, disc: 1), card("b", track: 1, disc: 2)))
        #expect(!AudioPlan.isAlbumContinuation(card("a", track: 3), card("b", track: 5)))
        #expect(!AudioPlan.isAlbumContinuation(card("a", track: 3), card("b", album: "al_2", track: 4)))
        #expect(!AudioPlan.isAlbumContinuation(card("a"), card("b")))
    }

    @Test func fadeLengthRules() {
        let a = card("a", track: 1), b = card("b", album: "al_2", track: 1)
        #expect(AudioPlan.fadeMs(pref: 6000, curDurMs: 200_000, nextDurMs: 180_000, cur: a, next: b) == 6000)
        // Never more than a third of either track.
        #expect(AudioPlan.fadeMs(pref: 12000, curDurMs: 30_000, nextDurMs: 200_000, cur: a, next: b) == 10_000)
        #expect(AudioPlan.fadeMs(pref: 12000, curDurMs: 200_000, nextDurMs: 2_400, cur: a, next: b) == 0) // < 1 s → gapless
        #expect(AudioPlan.fadeMs(pref: 6000, curDurMs: 200_000, nextDurMs: 200_000, cur: a, next: card("c", track: 2)) == 0)
        #expect(AudioPlan.fadeMs(pref: 0, curDurMs: 200_000, nextDurMs: 200_000, cur: a, next: b) == 0)
    }

    @Test func equalPowerCurves() {
        #expect(abs(AudioPlan.fadeOut(0) - 1) < 0.0001)
        #expect(abs(AudioPlan.fadeIn(1) - 1) < 0.0001)
        let mid = AudioPlan.fadeOut(0.5) * AudioPlan.fadeOut(0.5) + AudioPlan.fadeIn(0.5) * AudioPlan.fadeIn(0.5)
        #expect(abs(mid - 1) < 0.0001)
    }
}

@Suite struct PlayQueueTests {
    let five = (1...5).map { card("tr_\($0)") }

    @Test func endOfTrackAdvanceRespectsRepeat() {
        var q = PlayQueue(tracks: five, index: 4)
        #expect(q.nextIndexAfterEnd() == nil)
        q.repeatMode = .all
        #expect(q.nextIndexAfterEnd() == 0)
        q.repeatMode = .one
        #expect(q.nextIndexAfterEnd() == 4)
        // Skip never traps on repeat-one.
        #expect(q.nextIndexForSkip() == 0)
        q.repeatMode = .off
        #expect(q.nextIndexForSkip() == nil)
    }

    @Test func previousWrapsOnlyWithRepeatAll() {
        var q = PlayQueue(tracks: five, index: 0)
        #expect(q.previousIndex() == nil)
        q.repeatMode = .all
        #expect(q.previousIndex() == 4)
    }

    @Test func shuffleKeepsCurrentFirstAndRestores() {
        var q = PlayQueue(tracks: five, index: 2)
        var rng = SeededRNG(state: 42)
        q.setShuffle(true, using: &rng)
        #expect(q.current?.id == "tr_3")
        #expect(q.index == 0)
        #expect(Set(q.tracks.map(\.id)) == Set(five.map(\.id)))
        q.move(to: 3)
        let playing = q.current!.id
        q.setShuffle(false, using: &rng)
        #expect(q.tracks.map(\.id) == five.map(\.id))
        #expect(q.current?.id == playing)
    }

    @Test func playNextAndAppend() {
        var q = PlayQueue(tracks: five, index: 1)
        q.playNext([card("x")])
        #expect(q.tracks.map(\.id) == ["tr_1", "tr_2", "x", "tr_3", "tr_4", "tr_5"])
        q.append([card("y")])
        #expect(q.tracks.last?.id == "y")
        #expect(q.current?.id == "tr_2")
        var empty = PlayQueue()
        empty.append([card("z")])
        #expect(empty.current?.id == "z")
    }

    @Test func removeBeforeAndCurrent() {
        var q = PlayQueue(tracks: five, index: 2)
        #expect(q.remove(at: IndexSet([0])) == false)
        #expect(q.current?.id == "tr_3")
        #expect(q.remove(at: IndexSet([q.index])) == true)
        #expect(q.current?.id == "tr_4")
        var last = PlayQueue(tracks: five, index: 4)
        #expect(last.remove(at: IndexSet([4])) == true)
        #expect(last.current?.id == "tr_4")
    }

    @Test func dragReorderKeepsCurrent() {
        var q = PlayQueue(tracks: five, index: 1) // tr_2 playing
        q.move(fromOffsets: IndexSet([4]), toOffset: 0)
        #expect(q.tracks.map(\.id) == ["tr_5", "tr_1", "tr_2", "tr_3", "tr_4"])
        #expect(q.current?.id == "tr_2")
        q.move(fromOffsets: IndexSet([0]), toOffset: 5)
        #expect(q.tracks.map(\.id) == ["tr_1", "tr_2", "tr_3", "tr_4", "tr_5"])
        #expect(q.index == 1)
    }

    @Test func clearUpcomingAndServerInput() {
        var q = PlayQueue(tracks: five, index: 1, repeatMode: .all)
        q.clearUpcoming()
        #expect(q.tracks.map(\.id) == ["tr_1", "tr_2"])
        let body = q.input(positionSec: 12)
        #expect(body.trackIds == ["tr_1", "tr_2"])
        #expect(body.index == 1)
        #expect(body.repeat == .all)
        let json = String(decoding: try! JSON.encoder.encode(body), as: UTF8.self)
        #expect(json.contains("\"trackIds\""))
    }
}

@Suite struct SleepTimerTests {
    @Test func timedSleepExpiresAndFades() {
        let t0 = Date(timeIntervalSince1970: 1000)
        let s = SleepTimer.start(minutes: 15, now: t0)
        #expect(s.remaining(now: t0) == 900)
        #expect(!s.expired(now: t0.addingTimeInterval(899)))
        #expect(s.expired(now: t0.addingTimeInterval(900)))
        #expect(s.fadeFactor(now: t0.addingTimeInterval(800)) == 1)
        #expect(abs(s.fadeFactor(now: t0.addingTimeInterval(890)) - 0.5) < 0.001)
    }

    @Test func endOfTrackHasNoClock() {
        #expect(SleepTimer.endOfTrack.remaining() == nil)
        #expect(!SleepTimer.endOfTrack.expired())
        #expect(!SleepTimer.off.isActive)
    }
}

@Suite struct MusicOfflineTests {
    private func dl(_ id: String, bytes: Int64, auto: Bool, at: Double) -> MusicDownload {
        var d = MusicDownload(track: card(id), state: .done, addedAt: Date(timeIntervalSince1970: at), auto: auto)
        d.bytes = bytes
        return d
    }

    @Test func coverage() {
        let tracks = [card("a"), card("b")]
        #expect(MusicOffline.coverage(of: tracks, in: []) == .none)
        #expect(MusicOffline.coverage(of: tracks, in: [dl("a", bytes: 1, auto: false, at: 0)]) == .partial(1, 2))
        #expect(MusicOffline.coverage(of: tracks, in: [dl("a", bytes: 1, auto: false, at: 0), dl("b", bytes: 1, auto: false, at: 0)]) == .all)
    }

    @Test func evictsOldestAutoNeverManual() {
        let items = [dl("m", bytes: 600, auto: false, at: 0), dl("a1", bytes: 300, auto: true, at: 1), dl("a2", bytes: 300, auto: true, at: 2)]
        #expect(MusicOffline.evictions(items, incoming: 200, limitBytes: 1200) == ["a1"])
        #expect(MusicOffline.evictions(items, incoming: 0, limitBytes: 1200) == [])
        #expect(MusicOffline.evictions(items, incoming: 900, limitBytes: 1200) == ["a1", "a2"])
        #expect(MusicOffline.evictions(items, incoming: 900, limitBytes: 0) == [])
    }

    @Test func upcomingPlanFetchesWindowDropsStaleAuto() {
        let q = PlayQueue(tracks: (1...6).map { card("tr_\($0)") }, index: 1)
        let have = [dl("tr_3", bytes: 1, auto: true, at: 0), dl("tr_1", bytes: 1, auto: true, at: 0), dl("tr_6", bytes: 1, auto: false, at: 0)]
        let plan = MusicOffline.upcomingPlan(queue: q, count: 3, items: have)
        #expect(plan.fetch.map(\.id) == ["tr_4", "tr_5"])
        #expect(plan.drop == ["tr_1"])
        #expect(MusicOffline.upcomingPlan(queue: q, count: 0, items: have).drop == ["tr_3", "tr_1"])
    }

    @Test func fileNamesAndConversion() {
        #expect(MusicOffline.fileName(id: "tr_1/../x", ext: "flac") == "tr_1____x.flac")
        #expect(MusicDownload(track: card("a", format: "FLAC")).fileExtension == "flac")
        #expect(MusicStore.needsConversion(card("a", format: "opus")))
        #expect(!MusicStore.needsConversion(card("a", format: "mp3")))
    }

    @Test func storeBuildsUrlsAndQueue() async throws {
        let stub = StubTransport()
        let client = MmoClient(baseURL: "http://srv:17899", token: "tok", transport: stub)
        let store = MusicStore(client: client, profile: "p1")
        #expect(store.downloadURL("tr_1")?.absoluteString == "http://srv:17899/rest/download.view?id=tr_1&v=1.16.1&c=mixai-ios&apiKey=tok")
        #expect(store.streamURL(card("tr_2"), format: "mp3")?.absoluteString.contains("stream.view?id=tr_2&format=mp3&v=1.16.1") == true)
        stub.json("GET", "/media/music/radio", #"{"seed":"tr_1","tracks":[]}"#)
        #expect(try await store.radio(seed: "tr_1").isEmpty)
        stub.json("PUT", "/media/music/queue", #"{"profileId":"p1","trackIds":[],"index":0,"positionSec":0,"shuffle":false,"repeat":"off","updatedAt":1}"#)
        let q = try await store.putQueue(PlayQueue().input(positionSec: 0))
        #expect(q.profileId == "p1")
        let put = stub.requests.last { $0.httpMethod == "PUT" }
        let body = String(decoding: put?.httpBody ?? Data(), as: UTF8.self)
        #expect(body.contains("\"trackIds\":[]"))
    }
}
