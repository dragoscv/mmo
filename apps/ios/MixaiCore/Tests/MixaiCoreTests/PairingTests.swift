import Foundation
import Testing
@testable import MixaiCore

@Suite("Quick Connect pairing + device auth")
struct PairingTests {
    let req = PairRequestResponse(code: "123456", secret: String(repeating: "a", count: 64), expiresAt: 10_000, qr: "", approveUrl: "")

    @Test func requestEntersWaiting() {
        #expect(PairMachine.onRequest(req) == .waiting(code: "123456", expiresAtMs: 10_000))
    }

    @Test func pendingStaysThenExpiresByClock() {
        let w = PairMachine.onRequest(req)
        #expect(PairMachine.onPoll(w, PairPollResponse(status: .pending), nowMs: 5_000) == w)
        #expect(PairMachine.onPoll(w, PairPollResponse(status: .pending), nowMs: 10_000) == .expired)
    }

    @Test func approvedNeedsToken() {
        let w = PairMachine.onRequest(req)
        #expect(PairMachine.onPoll(w, PairPollResponse(status: .approved, deviceToken: "dt", userId: "u"), nowMs: 1) == .approved(deviceToken: "dt", userId: "u"))
        if case .failed = PairMachine.onPoll(w, PairPollResponse(status: .approved), nowMs: 1) {} else { Issue.record("expected failed") }
    }

    @Test func serverExpiryAndGoneCode() {
        let w = PairMachine.onRequest(req)
        #expect(PairMachine.onPoll(w, PairPollResponse(status: .expired), nowMs: 1) == .expired)
        #expect(PairMachine.onPollError(w, status: 404) == .expired)
        #expect(PairMachine.onPollError(w, status: 500) == w)
        #expect(PairMachine.onPoll(.expired, PairPollResponse(status: .approved, deviceToken: "x"), nowMs: 1) == .expired)
    }

    @Test func unknownStatusFromNewerServerIsPending() throws {
        let poll = try JSON.decoder.decode(PairPollResponse.self, from: Data(#"{"status":"denied-later"}"#.utf8))
        #expect(poll.status == .unknown)
        let w = PairMachine.onRequest(req)
        #expect(PairMachine.onPoll(w, poll, nowMs: 1) == w)
    }

    @Test func endToEndAgainstStub() async throws {
        let t = StubTransport()
        t.json("POST", "/pair/request", #"{"code":"654321","secret":"s","expiresAt":\#(Int(Date().timeIntervalSince1970 * 1000) + 60_000),"qr":"","approveUrl":""}"#)
        t.on("GET", "/pair/poll",
             HTTPResponse(status: 200, body: Data(#"{"status":"pending"}"#.utf8)),
             HTTPResponse(status: 200, body: Data(#"{"status":"approved","deviceToken":"tok","userId":"u1"}"#.utf8)))
        var qc = QuickConnect(baseURL: "http://h:1", transport: t)
        qc.pollInterval = .milliseconds(5)
        var states: [PairState] = []
        for await s in qc.run(deviceName: "iPhone") { states.append(s) }
        #expect(states.first == .requesting)
        #expect(states.contains(.waiting(code: "654321", expiresAtMs: { if case .waiting(_, let e) = states[1] { return e }; return 0 }())))
        #expect(states.last == .approved(deviceToken: "tok", userId: "u1"))
        let body = try #require(t.requests.first?.httpBody)
        let sent = try JSON.decoder.decode(PairRequest.self, from: body)
        #expect(sent.platform == "ios")
    }

    @Test func deviceTokenAnswers() throws {
        #expect(try DeviceAuth.interpret(status: 428, body: Data(#"{"error":"authorization_pending"}"#.utf8), host: "h") == .pending)
        #expect(try DeviceAuth.interpret(status: 403, body: Data(#"{"error":"slow_down"}"#.utf8), host: "h") == .slowDown)
        #expect(try DeviceAuth.interpret(status: 403, body: Data(#"{"error":"access_denied"}"#.utf8), host: "h") == .accessDenied)
        #expect(try DeviceAuth.interpret(status: 410, body: Data(), host: "h") == .expired)
        let ok = try DeviceAuth.interpret(status: 200, body: Data(#"{"session_token":"s","user":{"id":"u"},"companions":[{"id":"c","token":"t","lanUrl":"http://1.2.3.4:17899"}]}"#.utf8), host: "h")
        guard case .ok(let b) = ok else { Issue.record("expected ok"); return }
        #expect(b.companions?.first?.lanUrl == "http://1.2.3.4:17899")
        #expect(throws: DeviceAuthError.self) { try DeviceAuth.interpret(status: 500, body: Data(), host: "h") }
    }

    @Test func pinPad() {
        var p = PinPad()
        #expect(p.press(1) == nil)
        #expect(p.press(2) == nil)
        p.backspace()
        #expect(p.press(3) == nil)
        #expect(p.press(4) == nil)
        #expect(p.press(5) == "1345")
        #expect(p.press(6) == nil)
    }

    @Test func profileUnlockMapsErrors() async {
        let t = StubTransport()
        t.json("POST", "/media/profiles/p1/unlock", status: 401, #"{"error":"wrong_pin","triesLeft":2}"#)
        t.json("POST", "/media/profiles/p2/unlock", status: 429, #"{"error":"locked","retryAfterMs":1000}"#)
        let store = ProfileStore(client: MmoClient(baseURL: "http://h:1", token: "x", transport: t), load: { SavedProfile() }, save: { _ in })
        let p1 = Profile(id: "p1", name: "A", kind: .adult, hasPin: true, prefs: [:], sort: 0, createdAt: 0, updatedAt: 0)
        let p2 = Profile(id: "p2", name: "B", kind: .kid, hasPin: true, prefs: [:], sort: 1, createdAt: 0, updatedAt: 0)
        #expect(await store.unlock(p1, pin: "0000") == .wrongPin(triesLeft: 2))
        #expect(await store.unlock(p2, pin: "0000") == .locked(retryAfterMs: 1000))
    }
}
