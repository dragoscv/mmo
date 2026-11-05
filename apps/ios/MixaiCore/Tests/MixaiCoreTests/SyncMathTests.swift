import Testing
@testable import MixaiCore

/// Same vectors as apps/tv-android/core/src/test/.../SyncMathTest.kt (which mirrors server hub.test.ts).
@Suite("SyncMath port")
struct SyncMathTests {
    @Test func offsetAndRttTrustTheLowestRttSample() {
        let s = sampleFrom(t0: 1000, t1: 1540, t2: 1542, t3: 1082)
        #expect(s.offsetMs == 500)
        #expect(s.rttMs == 80)
        var est = ClockEstimator()
        est.add(ClockSample(offsetMs: 700, rttMs: 900))
        est.add(s)
        est.add(ClockSample(offsetMs: 300, rttMs: 600))
        #expect(est.best == s)
        #expect(est.rttMs == 80)
        #expect(abs(est.offsetMs - 500) < 200)
    }

    @Test func windowDropsOldSamples() {
        var est = ClockEstimator(window: 2)
        est.add(ClockSample(offsetMs: 1, rttMs: 1))
        est.add(ClockSample(offsetMs: 2, rttMs: 50))
        est.add(ClockSample(offsetMs: 3, rttMs: 60))
        #expect(est.count == 2)
        #expect(est.rttMs == 50)
    }

    @Test func rttNeverNegative() {
        #expect(sampleFrom(t0: 0, t1: 10, t2: 100, t3: 50).rttMs == 0)
    }

    @Test func expectedPositionAdvancesOnlyWhilePlaying() {
        #expect(abs(expectedPosition(PlaybackAnchor(playing: true, positionSec: 10, atServerMs: 1000), serverNowMs: 3000) - 12) < 1e-9)
        #expect(abs(expectedPosition(PlaybackAnchor(playing: false, positionSec: 10, atServerMs: 1000), serverNowMs: 3000) - 10) < 1e-9)
        #expect(abs(expectedPosition(PlaybackAnchor(playing: true, positionSec: 10, atServerMs: 5000), serverNowMs: 3000) - 10) < 1e-9)
        #expect(abs(expectedPosition(PlaybackAnchor(playing: true, positionSec: 10, atServerMs: 1000, rate: 2), serverNowMs: 3000) - 14) < 1e-9)
    }

    @Test func driftCorrectionUsesHysteresisRateClampAndSeek() {
        #expect(driftAction(actualSec: 10.1, expectedSec: 10, correcting: false) == .none)
        if case .rate(let r) = driftAction(actualSec: 10.2, expectedSec: 10, correcting: false) { #expect(r < 1) } else { Issue.record("expected rate") }
        if case .rate = driftAction(actualSec: 10.1, expectedSec: 10, correcting: true) {} else { Issue.record("expected rate") }
        #expect(driftAction(actualSec: 10.03, expectedSec: 10, correcting: true) == .none)
        #expect(driftAction(actualSec: 8, expectedSec: 10, correcting: false) == .seek(10))
        if case .rate(let r) = driftAction(actualSec: 9.5, expectedSec: 10, correcting: true) { #expect(r > 1 && r <= 1.05) } else { Issue.record("expected rate") }
        #expect(leadTimeMs([]) == 150)
        #expect(leadTimeMs([100, 400]) == 550)
        #expect(leadTimeMs([9000]) == 2000)
    }

    @Test func rateIsRoundedToThreeDecimalsLikeJs() {
        #expect(driftAction(actualSec: 10.2, expectedSec: 10, correcting: true) == .rate(0.95))
        #expect(driftAction(actualSec: 9, expectedSec: 10, correcting: true) == .rate(1.05))
        #expect(driftAction(actualSec: 10.14, expectedSec: 10, correcting: false) == .rate(0.965))
    }

    @Test func correctorKeepsHysteresisState() {
        var c = DriftCorrector()
        #expect(c.update(actualSec: 10.1, expectedSec: 10) == .none)
        #expect(!c.correcting)
        if case .rate = c.update(actualSec: 10.2, expectedSec: 10) {} else { Issue.record("expected rate") }
        #expect(c.correcting)
        if case .rate = c.update(actualSec: 10.1, expectedSec: 10) {} else { Issue.record("expected rate") }
        #expect(c.update(actualSec: 10.02, expectedSec: 10) == .none)
        #expect(!c.correcting)
    }
}
