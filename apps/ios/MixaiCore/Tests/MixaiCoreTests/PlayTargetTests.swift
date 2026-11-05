import Foundation
import Testing
@testable import MixaiCore

@Suite("Play target resolution")
struct PlayTargetTests {
    func file(_ id: String, rank: Int, s: Int? = nil, e: Int? = nil, res: VersionInfoResolution? = nil) -> VersionedFile {
        VersionedFile(serverFileId: id, kind: s == nil ? .movie : .tv, tmdbId: 1, season: s, episode: e, path: "/x", size: 1, mtime: 0, updatedAt: 0,
                      version: VersionInfo(resolution: res, remux: false, label: id, rank: rank))
    }

    @Test func bestFilePrefersRankOrPreferred() {
        let fs = [file("a", rank: 1), file("b", rank: 5), file("c", rank: 3)]
        #expect(PlayResolver.bestFile(fs)?.serverFileId == "b")
        #expect(PlayResolver.bestFile(fs, preferred: "c")?.serverFileId == "c")
    }

    @Test func movieFromRealFixtureResolves() throws {
        let d = try JSON.decoder.decode(MediaTitleResponse.self, from: try Fixture.data("title"))
        let t = PlayResolver.movie(d)
        if !d.files.isEmpty { #expect(t != nil) }
    }

    @Test func formatChipsAndYear() {
        #expect(PlayResolver.formatChips([file("a", rank: 1, res: ._2160p)]) == ["4K"])
        #expect(PlayResolver.formatChips([file("a", rank: 1, res: ._1080p)]) == ["HD"])
        #expect(PlayResolver.year("2024-05-01") == "2024")
        #expect(PlayResolver.year("x") == nil)
    }

    @Test func resumeIgnoresCompleted() {
        let p = ProgressEntry(profileId: "p", kind: .tv, tmdbId: 1, season: 1, episode: 2, positionSec: 600, durationSec: 1800, completed: false, updatedAt: 0)
        let t = PlayResolver.episode(tmdbId: 1, season: 1, episode: 2, files: [file("e", rank: 1, s: 1, e: 2)], progress: p)
        #expect(t?.resumeSec == 600)
        #expect(t?.leftMin == 20)
        let done = ProgressEntry(profileId: "p", kind: .tv, tmdbId: 1, season: 1, episode: 2, positionSec: 1790, durationSec: 1800, completed: true, updatedAt: 0)
        #expect(PlayResolver.episode(tmdbId: 1, season: 1, episode: 2, files: [file("e", rank: 1, s: 1, e: 2)], progress: done)?.resumeSec == nil)
    }

    @Test func progressQueueSurvivesFailure() async throws {
        let qf = tempDir().appendingPathComponent("q.json")
        let failing = StubTransport()
        let sync1 = ProgressSync(store: MediaStore(client: MmoClient(baseURL: "http://h:1", token: "x", transport: failing), profile: "p"), queueFile: qf)
        await sync1.save(MediaRef(kind: .movie, tmdbId: 7), positionSec: 30, durationSec: 100)
        #expect(await sync1.queued == 1)
        let ok = StubTransport()
        ok.json("PUT", "/media/progress", #"{"revision":5}"#)
        let sync2 = ProgressSync(store: MediaStore(client: MmoClient(baseURL: "http://h:1", token: "x", transport: ok), profile: "p"), queueFile: qf)
        #expect(await sync2.queued == 1)
        await sync2.save(MediaRef(kind: .movie, tmdbId: 8), positionSec: 10, durationSec: 100)
        #expect(await sync2.queued == 0)
        let body = try #require(ok.requests.first?.httpBody)
        #expect(try JSON.decoder.decode([ProgressInput].self, from: body).count == 2)
    }
}
