import Foundation
import Testing
@testable import MixaiCore

@Suite("MmoClient URL building + auth headers")
struct ClientTests {
    let client = MmoClient(baseURL: "192.168.1.5:17899/", token: "tok en/1")

    @Test func normalisesBaseURL() {
        #expect(client.baseURL == "http://192.168.1.5:17899")
        #expect(MmoClient.normalise("https://mixai.ro//") == "https://mixai.ro")
    }

    @Test func percentEncodesTokenAndPaths() {
        #expect(MmoClient.enc("a b/ă") == "a%20b%2F%C4%83")
        #expect(client.withToken("/video/x") == "http://192.168.1.5:17899/video/x?t=tok%20en%2F1")
        #expect(client.withToken("/video/x?y=1") == "http://192.168.1.5:17899/video/x?y=1&t=tok%20en%2F1")
    }

    @Test func hlsUrlMatchesAndroidShape() {
        #expect(client.hlsURL(fileId: "f1") == "http://192.168.1.5:17899/video/stream/f1?q=original&caps=\(iosPlaybackCaps)&t=tok%20en%2F1")
        #expect(client.hlsURL(fileId: "f1", startSec: 125, audio: 2) ==
            "http://192.168.1.5:17899/video/stream/f1?q=original&caps=\(iosPlaybackCaps)&start=125&audio=2&t=tok%20en%2F1")
    }

    @Test func hubAndSubsonicUrls() {
        #expect(client.hubURL() == "ws://192.168.1.5:17899/hub?t=tok%20en%2F1")
        #expect(MmoClient(baseURL: "https://x.y", token: "t").hubURL() == "wss://x.y/hub?t=t")
        #expect(client.withApiKey("/rest/getCoverArt.view?id=7").hasSuffix("id=7&v=1.16.1&c=mixai-ios&apiKey=tok%20en%2F1"))
        #expect(client.tmdbImageURL(size: "w342", path: "/p.jpg")?.absoluteString == "http://192.168.1.5:17899/video/tmdb-image/w342/p.jpg?t=tok%20en%2F1")
        #expect(client.tmdbImageURL(size: "w342", path: nil) == nil)
    }

    @Test func sendsDeviceAndProfileTokens() async throws {
        let t = StubTransport()
        t.json("GET", "/media/etag", #"{"revision":1,"libraryEtag":2}"#)
        let c = MmoClient(baseURL: "http://h:1", token: "dev", transport: t)
        c.setProfileToken("prof")
        _ = try await c.get(MediaEtag.self, "/media/etag")
        let r = try #require(t.requests.first)
        #expect(r.value(forHTTPHeaderField: "x-device-token") == "dev")
        #expect(r.value(forHTTPHeaderField: "x-profile-token") == "prof")
    }

    @Test func non2xxThrowsStatus() async {
        let t = StubTransport()
        t.json("GET", "/video/flags", status: 401, #"{"error":"unauthorized"}"#)
        let c = MmoClient(baseURL: "http://h:1", token: "x", transport: t)
        #expect(try! await c.checkToken() == false)
    }

    @Test func hlsDetection() {
        #expect(looksLikeHls("http://a/b/index.m3u8"))
        #expect(looksLikeHls("http://a/live.php?type=m3u8&x=1"))
        #expect(!looksLikeHls("http://a/stream.ts"))
    }

    @Test func liveResolverReadsRedirect() async throws {
        let t = StubTransport()
        t.on("GET", "/livetv/stream/ch1", HTTPResponse(status: 302, headers: ["Location": "https://cdn.example/x/index.m3u8"]))
        t.on("GET", "/livetv/stream/ch2", HTTPResponse(status: 302, headers: ["location": "http://iptv.example/1.ts"]))
        let live = LiveTvStore(client: MmoClient(baseURL: "http://h:1", token: "x", transport: t), profile: "p")
        #expect(try await live.resolve("ch1") == LiveStream(url: "https://cdn.example/x/index.m3u8", hls: true, proxied: false))
        #expect(try await live.resolve("ch2") == LiveStream(url: "http://h:1/livetv/stream/ch2?proxy=1", hls: false, proxied: true))
    }

    @Test func lyricIndex() {
        let l = [LyricLine(timeMs: 1000, text: "a"), LyricLine(timeMs: 2000, text: "b"), LyricLine(timeMs: 5000, text: "c")]
        #expect(activeLyricIndex(l, ms: 500) == nil)
        #expect(activeLyricIndex(l, ms: 2000) == 1)
        #expect(activeLyricIndex(l, ms: 99_000) == 2)
    }
}
