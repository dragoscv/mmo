package ro.mixai.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/** Mirrors the "sync math" block of server/src/hub/hub.test.ts so Kotlin and TS agree. */
class SyncMathTest {
    @Test
    fun offsetAndRttTrustTheLowestRttSample() {
        // client clock 500 ms behind server, 40 ms each way, 2 ms processing
        val s = sampleFrom(1000.0, 1540.0, 1542.0, 1082.0)
        assertEquals(500.0, s.offsetMs, 0.0)
        assertEquals(80.0, s.rttMs, 0.0)
        val est = ClockEstimator()
        est.add(ClockSample(700.0, 900.0))
        est.add(s)
        est.add(ClockSample(300.0, 600.0))
        assertEquals(s, est.best())
        assertEquals(80.0, est.rttMs, 0.0)
        assertTrue(abs(est.offsetMs - 500) < 200)
    }

    @Test
    fun windowDropsOldSamples() {
        val est = ClockEstimator(window = 2)
        est.add(ClockSample(1.0, 1.0))
        est.add(ClockSample(2.0, 50.0))
        est.add(ClockSample(3.0, 60.0))
        assertEquals(2, est.count)
        assertEquals(50.0, est.rttMs, 0.0)
    }

    @Test
    fun rttNeverNegative() {
        assertEquals(0.0, sampleFrom(0.0, 10.0, 100.0, 50.0).rttMs, 0.0)
    }

    @Test
    fun expectedPositionAdvancesOnlyWhilePlaying() {
        assertEquals(12.0, expectedPosition(PlaybackAnchor(true, 10.0, 1000.0), 3000.0), 1e-9)
        assertEquals(10.0, expectedPosition(PlaybackAnchor(false, 10.0, 1000.0), 3000.0), 1e-9)
        assertEquals(10.0, expectedPosition(PlaybackAnchor(true, 10.0, 5000.0), 3000.0), 1e-9)
        assertEquals(14.0, expectedPosition(PlaybackAnchor(true, 10.0, 1000.0, rate = 2.0), 3000.0), 1e-9)
    }

    @Test
    fun driftCorrectionUsesHysteresisRateClampAndSeek() {
        assertEquals(DriftAction.None, driftAction(10.1, 10.0, false))
        val r = driftAction(10.2, 10.0, false)
        assertTrue(r is DriftAction.Rate && r.rate < 1)
        assertTrue(driftAction(10.1, 10.0, true) is DriftAction.Rate)
        assertEquals(DriftAction.None, driftAction(10.03, 10.0, true))
        assertEquals(DriftAction.Seek(10.0), driftAction(8.0, 10.0, false))
        val behind = driftAction(9.5, 10.0, true)
        assertTrue(behind is DriftAction.Rate && behind.rate > 1 && behind.rate <= 1.05)
        assertEquals(150L, leadTimeMs(emptyList()))
        assertEquals(550L, leadTimeMs(listOf(100.0, 400.0)))
        assertEquals(2000L, leadTimeMs(listOf(9000.0)))
    }

    @Test
    fun rateIsRoundedToThreeDecimalsLikeJs() {
        // drift 200 ms ahead → 1 - 0.05 = 0.95
        assertEquals(DriftAction.Rate(0.95), driftAction(10.2, 10.0, true))
        // drift 1 s behind → clamp to +5 %
        assertEquals(DriftAction.Rate(1.05), driftAction(9.0, 10.0, true))
        // 140 ms ahead → 1 - 0.035 = 0.965
        assertEquals(DriftAction.Rate(0.965), driftAction(10.14, 10.0, false))
    }

    @Test
    fun correctorKeepsHysteresisState() {
        val c = DriftCorrector()
        assertEquals(DriftAction.None, c.update(10.1, 10.0))
        assertFalse(c.correcting)
        assertTrue(c.update(10.2, 10.0) is DriftAction.Rate)
        assertTrue(c.correcting)
        assertTrue(c.update(10.1, 10.0) is DriftAction.Rate) // still correcting between 40 and 120 ms
        assertEquals(DriftAction.None, c.update(10.02, 10.0))
        assertFalse(c.correcting)
    }
}
