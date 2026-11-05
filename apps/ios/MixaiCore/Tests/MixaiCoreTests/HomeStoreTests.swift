import Foundation
import Testing
@testable import MixaiCore

@Suite("HomeStore stale-while-revalidate")
struct HomeStoreTests {
    private func collect(_ s: AsyncThrowingStream<HomeStore.Update, Error>) async throws -> [HomeStore.Update] {
        var out: [HomeStore.Update] = []
        for try await u in s { out.append(u) }
        return out
    }

    @Test func realServerFixturesDecode() throws {
        for (name, type) in [("home", MediaHome.self), ("etag", MediaEtag.self), ("title", MediaTitleResponse.self),
                             ("titletv", MediaTitleResponse.self), ("season", MediaSeasonResponse.self), ("musichome", MusicHome.self),
                             ("health", Health.self), ("pairinfo", PairInfo.self), ("profiles", ProfilesPage.self),
                             ("channels", LiveTvChannelList.self)] as [(String, any Decodable.Type)] {
            do { _ = try JSON.decoder.decode(type, from: try Fixture.data(name)) } catch { Issue.record("\(name): \(error)") }
        }
    }

    @Test func coldStartFetchesAndPersists() async throws {
        let dir = tempDir()
        let t = StubTransport()
        t.on("GET", "/media/home", HTTPResponse(status: 200, body: try Fixture.data("home")))
        let store = HomeStore(client: MmoClient(baseURL: "http://h:1", token: "x", transport: t), directory: dir)
        let ups = try await collect(await store.updates(profile: "default"))
        #expect(ups.count == 1)
        guard case .fresh(_, let changed) = ups[0] else { Issue.record("expected fresh"); return }
        #expect(changed)
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("home-default.json").path))
    }

    @Test func warmStartWithSameEtagSkipsHomeFetch() async throws {
        let dir = tempDir()
        let home = try JSON.decoder.decode(MediaHome.self, from: try Fixture.data("home"))
        try Fixture.data("home").write(to: dir.appendingPathComponent(HomeStore.fileName(for: "p 1")))
        let t = StubTransport()
        t.json("GET", "/media/etag", #"{"revision":\#(home.revision),"libraryEtag":\#(home.libraryEtag)}"#)
        let store = HomeStore(client: MmoClient(baseURL: "http://h:1", token: "x", transport: t), directory: dir)
        let clock = ContinuousClock()
        let t0 = clock.now
        let ups = try await collect(await store.updates(profile: "p 1"))
        guard case .cached(let c) = ups.first else { Issue.record("expected cached first"); return }
        #expect(c.rows.count == home.rows.count)
        #expect(clock.now - t0 < .seconds(1))
        guard case .fresh(_, let changed) = ups.last else { Issue.record("expected confirmation"); return }
        #expect(!changed)
        #expect(!t.paths.contains("GET /media/home"))
    }

    @Test func movedEtagRefetches() async throws {
        let dir = tempDir()
        try Fixture.data("home").write(to: dir.appendingPathComponent(HomeStore.fileName(for: "default")))
        let t = StubTransport()
        t.json("GET", "/media/etag", #"{"revision":999999,"libraryEtag":1}"#)
        t.on("GET", "/media/home", HTTPResponse(status: 200, body: try Fixture.data("home")))
        let store = HomeStore(client: MmoClient(baseURL: "http://h:1", token: "x", transport: t), directory: dir)
        let ups = try await collect(await store.updates(profile: "default"))
        #expect(ups.count == 2)
        guard case .fresh(_, let changed) = ups.last else { Issue.record("expected fresh"); return }
        #expect(changed)
    }

    @Test func offlineWithCacheDoesNotThrow() async throws {
        let dir = tempDir()
        try Fixture.data("home").write(to: dir.appendingPathComponent(HomeStore.fileName(for: "default")))
        let t = StubTransport() // every route 404
        let store = HomeStore(client: MmoClient(baseURL: "http://h:1", token: "x", transport: t), directory: dir)
        let ups = try await collect(await store.updates(profile: "default"))
        #expect(ups.count == 1)
    }

    @Test func offlineWithoutCacheThrows() async {
        let store = HomeStore(client: MmoClient(baseURL: "http://h:1", token: "x", transport: StubTransport()), directory: tempDir())
        await #expect(throws: APIStatusError.self) { _ = try await collect(await store.updates(profile: "default")) }
    }

    @Test func profileFileNamesAreSafe() {
        #expect(HomeStore.fileName(for: "a/b ă") == "home-a_b__.json")
        #expect(HomeStore.fileName(for: "") == "home-default.json")
    }

    @Test func rowTitlesFollowLanguage() throws {
        let row = HomeRow(id: "continue", title: ["ro": .string("Continuă"), "en": .string("Continue")], kind: .mixed, items: [])
        #expect(row.localizedTitle("ro-RO") == "Continuă")
        #expect(row.localizedTitle("en") == "Continue")
        #expect(HomeRow(id: "x", title: [:], kind: .mixed, items: []).localizedTitle("en") == "x")
    }
}
