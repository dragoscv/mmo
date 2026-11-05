import Foundation
import Testing
@testable import MixaiCore

/// Fixtures are shaped like real MMO Server responses (server/openapi.yaml).
@Suite("Generated models decode server JSON")
struct ModelsDecodeTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test("GET /media/home decodes rows and cards")
    func mediaHome() throws {
        let json = """
        {
          "region": "RO",
          "profile": "p_1",
          "configured": true,
          "revision": 42,
          "libraryEtag": 1730800000000,
          "serverId": null,
          "serverName": "homepi",
          "rows": [
            {
              "id": "continue",
              "title": { "ro": "Continuă", "en": "Continue watching" },
              "kind": "mixed",
              "items": [
                {
                  "kind": "tv",
                  "tmdbId": 1399,
                  "title": "Game of Thrones",
                  "posterPath": "/u3bZgnGQ9T01sWNhyveQz0wH0Hl.jpg",
                  "backdropPath": null,
                  "genreIds": [18, 10765],
                  "voteAverage": 8.4,
                  "inLibrary": true,
                  "progress": 0.35,
                  "age": 16,
                  "nextEpisode": { "season": 2, "episode": 3, "positionSec": 812.5 }
                }
              ]
            }
          ]
        }
        """
        let home = try decode(MediaHome.self, json)
        #expect(home.serverName == "homepi")
        #expect(home.serverId == nil)
        #expect(home.libraryEtag == 1_730_800_000_000)
        let row = try #require(home.rows.first)
        #expect(row.kind == .mixed)
        #expect(row.title["en"] == .string("Continue watching"))
        let card = try #require(row.items.first)
        #expect(card.kind == .tv)
        #expect(card.backdropPath == nil)
        #expect(card.genreIds == [18, 10765])
        #expect(card.nextEpisode?.episode == 3)
        #expect(card.reason == nil)
    }

    @Test("TitleDetails merges TitleCard (allOf) with details")
    func titleDetails() throws {
        let json = """
        {
          "kind": "movie",
          "tmdbId": 1339713,
          "title": "Example",
          "posterPath": null,
          "backdropPath": "/b.jpg",
          "genreIds": [28],
          "runtime": 121,
          "genres": [{ "id": 28, "name": "Action" }],
          "keywords": [],
          "cast": [{ "id": 1, "name": "Actor", "role": "Hero", "profilePath": null }],
          "crew": [],
          "collectionId": null,
          "externalIds": { "imdb_id": "tt0000001" },
          "videos": [{ "key": "abc", "site": "YouTube", "type": "Trailer", "name": "Trailer" }],
          "logoPath": null,
          "ratings": { "RO": "AP-12", "US": "PG-13" },
          "recommendations": [],
          "similar": [],
          "watchProviders": { "RO": { "flatrate": [{ "provider_id": 8 }] } }
        }
        """
        let details = try decode(TitleDetails.self, json)
        #expect(details.kind == .movie)
        #expect(details.runtime == 121)
        #expect(details.cast.first?.role == "Hero")
        #expect(details.ratings?["RO"] == "AP-12")
        #expect(details.externalIds["imdb_id"] == .string("tt0000001"))
        guard case .object(let ro)? = details.watchProviders["RO"] else {
            Issue.record("watchProviders.RO should be an object")
            return
        }
        #expect(ro["flatrate"] != nil)
    }

    @Test("Profile decodes nullable fields and free-form prefs")
    func profile() throws {
        let json = """
        {
          "id": "p_kid",
          "name": "Ana",
          "avatar": null,
          "color": "#7c5cff",
          "kind": "kid",
          "maxAge": 12,
          "hasPin": false,
          "prefs": { "subtitles": "ro", "autoplay": true, "volume": 0.8 },
          "sort": 1,
          "createdAt": 1730800000000,
          "updatedAt": 1730800000001
        }
        """
        let p = try decode(Profile.self, json)
        #expect(p.kind == .kid)
        #expect(p.maxAge == 12)
        #expect(p.avatar == nil)
        #expect(p.prefs["autoplay"] == .bool(true))
        #expect(p.prefs["volume"] == .number(0.8))
    }

    @Test("LiveTvChannel list decodes")
    func liveTvChannels() throws {
        let json = """
        [
          {
            "id": "ch_1", "sourceId": "src_1", "number": "101", "name": "TVR 1",
            "logo": "https://example.invalid/tvr1.png", "group": "Generaliste", "tvgId": "TVR1.ro",
            "archiveDays": 3, "catchup": true, "hidden": false, "sort": null, "favourite": true
          },
          {
            "id": "ch_2", "sourceId": "src_1", "name": "Radio",
            "archiveDays": 0, "catchup": false, "hidden": true, "favourite": false
          }
        ]
        """
        let channels = try decode([LiveTvChannel].self, json)
        #expect(channels.count == 2)
        #expect(channels[0].catchup)
        #expect(channels[0].sort == nil)
        #expect(channels[1].number == nil)
        #expect(channels[1].logo == nil)
    }

    @Test("Unknown enum values from a newer server decode to .unknown")
    func unknownEnum() throws {
        #expect(try decode(MediaKind.self, "\"podcast\"") == .unknown)
        #expect(try decode(ProfileKind.self, "\"teen\"") == .unknown)
        #expect(try decode(HomeRowKind.self, "\"movie\"") == .movie)
        let row = try decode(HomeRow.self, """
        { "id": "x", "title": { "ro": "R", "en": "E" }, "kind": "shorts", "items": [] }
        """)
        #expect(row.kind == .unknown)
    }

    @Test("JSONValue round-trips through encode/decode")
    func jsonValueRoundTrip() throws {
        let value: JSONValue = .object(["a": .array([.null, .bool(false), .number(1.5), .string("x")])])
        let data = try JSONEncoder().encode(value)
        #expect(try JSONDecoder().decode(JSONValue.self, from: data) == value)
    }
}
