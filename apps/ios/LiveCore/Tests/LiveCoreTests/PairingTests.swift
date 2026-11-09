import Foundation
import Testing
@testable import LiveCore

private let tok = "0123456789abcdef0123456789abcdef"

@Suite struct PairingTests {
    @Test func appLink() throws {
        let l = try #require(PairingLink.parse("mixai-live://pair?host=192.168.1.20&port=17920&t=\(tok)&name=Studio%20PC"))
        #expect(l.endpoint == EngineEndpoint(host: "192.168.1.20", port: 17920))
        #expect(l.token == tok)
        #expect(l.name == "Studio PC")
    }

    @Test func webRemoteLink() throws {
        let l = try #require(PairingLink.parse("  http://10.0.0.5:17920/?t=\(tok)\n"))
        #expect(l.endpoint.host == "10.0.0.5")
        #expect(l.name == nil)
        let d = try #require(PairingLink.parse("http://pc.local/?t=\(tok)"))
        #expect(d.endpoint.port == 17920)
    }

    @Test func rejectsBadLinks() {
        #expect(PairingLink.parse("mixai-live://pair?host=1.2.3.4&t=short") == nil)
        #expect(PairingLink.parse("mixai-live://pair?t=\(tok)") == nil)
        #expect(PairingLink.parse("mixai-live://pair?host=a&port=99999&t=\(tok)") == nil)
        #expect(PairingLink.parse("ftp://a/?t=\(tok)") == nil)
        #expect(PairingLink.parse("http://a/?t=zz\(tok)") == nil)
        #expect(PairingLink.parse("hello") == nil)
    }

    @Test func webSocketURL() throws {
        let u = try #require(EngineEndpoint(host: "192.168.1.20").webSocketURL(token: tok, clientId: "iphone-1"))
        #expect(u.absoluteString == "ws://192.168.1.20:17920/ws?t=\(tok)&c=iphone-1")
        let v6 = try #require(EngineEndpoint(host: "fe80::1%en0", port: 17920).webSocketURL(token: tok, clientId: "w"))
        #expect(v6.absoluteString.hasPrefix("ws://[fe80::1%25en0]:17920/ws"))
    }

    @Test func clientIds() {
        let c = ClientId.make(prefix: "iphone")
        #expect(ClientId.isValid(c))
        #expect(c.hasPrefix("iphone-"))
        #expect(ClientId.isValid(ClientId.make(prefix: "<bad prefix that is way too long for the limit>")))
        #expect(!ClientId.isValid("<x>"))
    }

    @Test func pairedListUpsertAndTouch() {
        let a = PairedEngine(id: "a", name: "A", endpoint: EngineEndpoint(host: "1.1.1.1"))
        let b = PairedEngine(id: "b", name: "B", endpoint: EngineEndpoint(host: "2.2.2.2"))
        var (list, _) = PairedList.upsert([], a)
        (list, _) = PairedList.upsert(list, b)
        #expect(list.map(\.id) == ["b", "a"])
        let again = PairedEngine(id: "new", name: "A2", endpoint: EngineEndpoint(host: "1.1.1.1"))
        let (l2, id) = PairedList.upsert(list, again)
        #expect(id == "a")
        #expect(l2.map(\.id) == ["a", "b"])
        #expect(l2[0].name == "A2")
        let t = PairedList.touch(l2, id: "b", role: .performer, name: "Bee", at: Date(timeIntervalSince1970: 5))
        #expect(t[0].id == "b" && t[0].role == .performer && t[0].name == "Bee")
        #expect(PairedList.touch(t, id: "zzz", role: nil, name: nil, at: .now) == t)
    }
}

@Suite struct WatchLinkTests {
    @Test func roundTripAllMessages() {
        let snap = WatchLink.Snapshot(engineName: "E", connected: true, role: .performer, song: "S", part: "Chorus", nextPart: "Bridge",
                                      mute: true, bypass: false, inLevel: 0.4, position: Position(song: 1, part: 2))
        let cfg = WatchLink.EngineConfig(name: "E", endpoint: EngineEndpoint(host: "10.0.0.2"), token: tok)
        for m in [WatchLink.Message.config(cfg, snap), .config(nil, snap), .snapshot(snap), .command(.panic)] {
            #expect(WatchLink.decode(WatchLink.encode(m)) == m)
        }
        #expect(WatchLink.decode(["v": 2, "k": "snap", "p": Data()]) == nil)
    }

    @Test func snapshotFromModel() {
        var m = LiveModel()
        LiveReducer.reduce(&m, .received(ServerMessage.decode(#"{"type":"hello","protocol":1,"role":"performer","engine_name":"Rig"}"#)!))
        LiveReducer.reduce(&m, .received(ServerMessage.decode(Frames.state)!))
        let s = WatchLink.Snapshot(model: m, engineName: "fallback")
        #expect(s.engineName == "Rig")
        #expect(s.song == "Song A" && s.part == "Verse" && s.nextPart == "Chorus")
        #expect(s.connected && s.role == .performer)
    }

    @Test func sendPolicy() {
        let a = WatchLink.Snapshot(part: "A", inLevel: 0.1)
        var b = a; b.part = "B"
        #expect(WatchLink.shouldSend(prev: nil, next: a, sinceLast: 0))
        #expect(!WatchLink.shouldSend(prev: a, next: b, sinceLast: 0.1))
        #expect(WatchLink.shouldSend(prev: a, next: b, sinceLast: 0.2))
        var c = a; c.inLevel = 0.12
        #expect(!WatchLink.shouldSend(prev: a, next: c, sinceLast: 1))
        c.inLevel = 0.5
        #expect(WatchLink.shouldSend(prev: a, next: c, sinceLast: 0.3))
    }

    @Test func commandsMapToProtocol() {
        #expect(WatchLink.Command.mute.client == .setMix(MixChange(mute: true)))
        #expect(WatchLink.Command.tap.client == .tapTempo)
    }
}

@Suite struct TeleprompterTests {
    @Test func splitsSectionsAndFindsPart() {
        let s = Teleprompter.sections("Intro line\n\n[Verse 1]\na\nb\n\nRefren:\nla la\n\n[Chorus]\nx")
        #expect(s.map(\.title) == [nil, "Verse 1", "Refren", "Chorus"])
        #expect(s[1].lines == ["a", "b"])
        #expect(Teleprompter.section(for: "chorus", in: s) == 3)
        #expect(Teleprompter.section(for: "Verse", in: s) == 1)
        #expect(Teleprompter.section(for: "Refrén", in: s) == 2)
        #expect(Teleprompter.section(for: "Bridge", in: s) == nil)
        #expect(Teleprompter.sections(nil).isEmpty)
        #expect(Teleprompter.sections("  \n").isEmpty)
    }
}
