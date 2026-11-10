import Foundation
import Synchronization
import Testing
@testable import MixaiCore

/// Answers `/media/search` the way MMO Server does: a request without `profile` is the unrestricted default
/// profile; the kid profile (max age 12) does not get the 15+ title.
private final class AgeFilteringServer: HTTPTransport, Sendable {
    static let kid = "p_kid 1/ă"
    private let seen = Mutex<[URL]>([])

    var urls: [URL] { seen.withLock { $0 } }

    func send(_ request: URLRequest, followRedirects: Bool) async throws -> HTTPResponse {
        guard let url = request.url else { throw URLError(.badURL) }
        seen.withLock { $0.append(url) }
        if url.path == "/media/library" {
            return HTTPResponse(status: 200, body: Data(#"{"revision":1,"full":true,"items":[],"removed":[],"serverId":null,"serverName":"s"}"#.utf8))
        }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let profile = items.first { $0.name == "profile" }?.value ?? "default"
        let card = #"{"kind":"movie","tmdbId":358332,"title":"Cosmos Laundromat","genreIds":[16],"age":15,"inLibrary":true}"#
        let results = profile == Self.kid ? "" : card
        return HTTPResponse(status: 200, body: Data(#"{"page":1,"totalPages":1,"results":[\#(results)]}"#.utf8))
    }
}

@Suite("MediaStore sends the active profile")
struct MediaStoreTests {
    @Test func searchIsScopedToTheActiveProfile() async throws {
        let server = AgeFilteringServer()
        let client = MmoClient(baseURL: "http://h:1", token: "x", transport: server)

        let kidPage = try await MediaStore(client: client, profile: AgeFilteringServer.kid).search("cosmos laundromat")
        let kidTitles = kidPage.results.map(\.title)
        #expect(kidTitles.isEmpty, "a kid profile must not get titles above its age limit in search")

        let adultPage = try await MediaStore(client: client, profile: "default").search("cosmos laundromat", page: 2)
        let adultTitles = adultPage.results.map(\.title)
        #expect(adultTitles == ["Cosmos Laundromat"])

        let urls = server.urls
        #expect(urls.count == 2)
        let kidURL = try #require(urls.first)
        let kidItems = URLComponents(url: kidURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let sentProfile = kidItems.first { $0.name == "profile" }?.value
        let sentQuery = kidItems.first { $0.name == "q" }?.value
        let sentPage = kidItems.first { $0.name == "page" }?.value
        #expect(kidURL.path == "/media/search")
        #expect(sentProfile == AgeFilteringServer.kid)
        #expect(sentQuery == "cosmos laundromat")
        #expect(sentPage == "1")
        // The profile id is percent-encoded like every other path/query component.
        let rawQuery = kidURL.query(percentEncoded: true) ?? ""
        #expect(rawQuery.contains("profile=p_kid%201%2F%C4%83"))

        let adultURL = try #require(urls.last)
        let adultItems = URLComponents(url: adultURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let adultProfile = adultItems.first { $0.name == "profile" }?.value
        let adultPageNo = adultItems.first { $0.name == "page" }?.value
        #expect(adultProfile == "default")
        #expect(adultPageNo == "2")
    }

    @Test func libraryIsScopedToTheActiveProfile() async throws {
        let server = AgeFilteringServer()
        let client = MmoClient(baseURL: "http://h:1", token: "x", transport: server)
        _ = try await MediaStore(client: client, profile: AgeFilteringServer.kid).library()
        let url = try #require(server.urls.first)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let sentProfile = items.first { $0.name == "profile" }?.value
        #expect(url.path == "/media/library")
        #expect(sentProfile == AgeFilteringServer.kid)
    }
}
