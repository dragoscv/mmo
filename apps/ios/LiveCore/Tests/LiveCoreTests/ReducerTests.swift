import Foundation
import Testing
@testable import LiveCore

@Suite struct ReducerTests {
    private func connected(role: String = "controller", protocolVersion: Int = 1) -> LiveModel {
        var m = LiveModel()
        LiveReducer.reduce(&m, .connecting(attempt: 0))
        let h = #"{"type":"hello","protocol":\#(protocolVersion),"role":"\#(role)","engine_name":"E"}"#
        LiveReducer.reduce(&m, .received(ServerMessage.decode(h)!))
        return m
    }

    private func state(_ frame: String = Frames.state) -> ServerMessage { ServerMessage.decode(frame)! }

    @Test func helloConnectsAndGatesByRole() {
        let viewer = connected(role: "viewer")
        #expect(viewer.connected)
        #expect(!viewer.can(.next))
        #expect(viewer.can(.subscribe(meters: true)))
        let perf = connected(role: "performer")
        #expect(perf.can(.panic))
        #expect(!perf.can(.setEnabled(insert: 1, on: true)))
        #expect(connected().can(.setEnabled(insert: 1, on: true)))
        #expect(!LiveModel().can(.next))
    }

    @Test func newerProtocolFailsWithoutRetry() {
        let m = connected(protocolVersion: 2)
        #expect(m.phase == .failed(.protocolTooNew))
        #expect(!LiveReducer.shouldRetry(m.phase))
    }

    @Test func unauthorizedCloseStops() {
        var m = LiveModel()
        LiveReducer.reduce(&m, .connecting(attempt: 0))
        LiveReducer.reduce(&m, .closed(httpStatus: 401))
        #expect(m.phase == .failed(.unauthorized))
        LiveReducer.reduce(&m, .waiting(attempt: 1, seconds: 1))
        #expect(m.phase == .failed(.unauthorized))
    }

    @Test func dropClearsMetersAndRetries() {
        var m = connected()
        LiveReducer.reduce(&m, .received(ServerMessage.decode(Frames.meters)!))
        #expect(m.meters != nil)
        LiveReducer.reduce(&m, .closed(httpStatus: nil))
        #expect(m.meters == nil)
        #expect(m.phase == .idle)
        #expect(LiveReducer.shouldRetry(m.phase))
        LiveReducer.reduce(&m, .waiting(attempt: 1, seconds: 0.5))
        #expect(m.phase == .waiting(attempt: 1, seconds: 0.5))
    }

    @Test func sceneChangeCountsOnlyMoves() {
        var m = connected()
        LiveReducer.reduce(&m, .received(state()))
        #expect(m.sceneChanges == 0)
        LiveReducer.reduce(&m, .received(state()))
        #expect(m.sceneChanges == 0)
        let moved = Frames.state.replacingOccurrences(of: #""position":{"song":0,"part":0}"#, with: #""position":{"song":0,"part":1}"#)
            .replacingOccurrences(of: #""revision":7"#, with: #""revision":8"#)
        LiveReducer.reduce(&m, .received(state(moved)))
        #expect(m.sceneChanges == 1)
        #expect(m.state?.currentPart?.name == "Chorus")
    }

    @Test func staleRevisionIgnored() {
        var m = connected()
        let newer = Frames.state.replacingOccurrences(of: #""revision":7"#, with: #""revision":9"#)
        LiveReducer.reduce(&m, .received(state(newer)))
        LiveReducer.reduce(&m, .received(state()))
        #expect(m.state?.revision == 9)
    }

    @Test func optimisticMixAndErrors() {
        var m = connected()
        LiveReducer.reduce(&m, .received(state()))
        LiveReducer.reduce(&m, .optimisticMix(MixChange(inputDb: 4, mute: true)))
        #expect(m.state?.mix.inputDb == 4)
        #expect(m.state?.mix.mute == true)
        #expect(m.state?.mix.mainDb == -3)
        LiveReducer.reduce(&m, .received(.error(id: 2, code: "forbidden", message: "no")))
        #expect(m.lastError?.key == "live.error.forbidden")
        #expect(LiveError(code: "weird", message: "").key == "live.error.generic")
        LiveReducer.reduce(&m, .clearError)
        #expect(m.lastError == nil)
    }

    @Test func meterSmoothingAttackAndRelease() {
        var lv = MeterLevels()
        lv = lv.next(Meters(inPeak: 1), dt: 0)
        #expect(lv.inDb == 0)
        lv = lv.next(Meters(inPeak: 0), dt: 0.5)
        #expect(lv.inDb == -10)
        #expect(MeterLevels.db(0) == -60)
        #expect(MeterLevels.fraction(-60) == 0)
        #expect(MeterLevels.fraction(6) == 1)
    }

    @Test func backoffDoublesAndCaps() {
        #expect(LiveReducer.backoff(attempt: 0) == 0.5)
        #expect(LiveReducer.backoff(attempt: 2) == 2)
        #expect(LiveReducer.backoff(attempt: 9) == 10)
    }

    @Test func userDisconnectResets() {
        var m = connected()
        LiveReducer.reduce(&m, .received(state()))
        LiveReducer.reduce(&m, .disconnectedByUser)
        #expect(m == LiveModel())
    }
}

@Suite struct ThrottleTests {
    @Test func leadingThenTrailingNewestWins() {
        var t = Throttle<Int>(interval: 0.03)
        #expect(t.offer(key: "a", value: 1, now: 0) == 1)
        #expect(t.offer(key: "a", value: 2, now: 0.01) == nil)
        #expect(t.offer(key: "a", value: 3, now: 0.02) == nil)
        #expect(t.offer(key: "b", value: 9, now: 0.02) == 9)
        #expect(t.due(now: 0.025).isEmpty)
        #expect(t.due(now: 0.031) == [3])
        #expect(!t.hasPending)
        #expect(t.offer(key: "a", value: 4, now: 0.05) == nil)
        #expect(t.offer(key: "a", value: 5, now: 0.07) == 5)
    }

    @Test func mergeCombinesFields() {
        var t = Throttle<MixChange>(interval: 0.03)
        _ = t.offer(key: "mix", value: MixChange(inputDb: 1), now: 0)
        _ = t.offer(key: "mix", value: MixChange(mainDb: -2), now: 0.01) { $0.merged(with: $1) }
        _ = t.offer(key: "mix", value: MixChange(inputDb: 3), now: 0.02) { $0.merged(with: $1) }
        #expect(t.due(now: 0.04) == [MixChange(inputDb: 3, mainDb: -2)])
    }
}
