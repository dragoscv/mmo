package ro.mixai.listen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearLinkTest {
    private val r = WearLink.Reading(
        listening = true, keyIndex = 21, keyLocked = true, bpm = 124.5, tempoLocked = true,
        nextBeatMs = 230, atMillis = 1_700_000_000_000, title = "Endless Summer — The Midnight",
    )

    @Test fun roundTrip() {
        assertEquals(r, WearLink.decode(WearLink.encode(r)))
        val idle = WearLink.Reading(listening = false, atMillis = 5)
        assertEquals(idle, WearLink.decode(WearLink.encode(idle)))
    }

    @Test fun semicolonInTitleDoesNotBreakTheLine() {
        val d = WearLink.decode(WearLink.encode(r.copy(title = "A; B")))!!
        assertEquals("A, B", d.title)
        assertEquals(124.5, d.bpm!!, 1e-9)
    }

    @Test fun unknownVersionOrGarbageIsIgnored() {
        assertNull(WearLink.decode("v9;1;21;1;124;1;0;0"))
        assertNull(WearLink.decode("nonsense"))
        assertNull(WearLink.decode(WearLink.encode(r).replace(";21;", ";99;"))?.keyIndex)
    }

    @Test fun throttling() {
        assertTrue(WearLink.shouldSend(null, r, 0))
        assertFalse(WearLink.shouldSend(r, r.copy(bpm = 124.6), 600))
        assertTrue(WearLink.shouldSend(r, r.copy(bpm = 125.0), 600))
        assertFalse(WearLink.shouldSend(r, r.copy(keyIndex = 16), 100))
        assertTrue(WearLink.shouldSend(r, r.copy(keyIndex = 16), 600))
        assertTrue(WearLink.shouldSend(r, r.copy(listening = false), 10))
        assertTrue(WearLink.shouldSend(r, r, 2_100))
    }

    @Test fun beatClockFollowsTheGrid() {
        val c = BeatClock()
        c.update(120.0, 100.0, 0.0) // beats at 100, 600, 1100…
        assertEquals(100.0, c.untilNext(0.0)!!, 1e-9)
        assertEquals(0L, c.consume())
        assertEquals(500.0, c.untilNext(100.0)!!, 1e-9)
        // Jittered observation (+8 ms) is smoothed, not jumped to.
        c.update(120.0, 508.0, 100.0)
        assertEquals(502.0, c.untilNext(100.0)!!, 1e-6)
        // A shift of more than a quarter beat resyncs only once a second observation >= 250 ms later agrees.
        c.update(120.0, 350.0, 100.0)
        assertEquals(502.0, c.untilNext(100.0)!!, 1e-6)
        c.update(120.0, 0.0, 450.0) // same shifted grid (beat at 450), 350 ms later
        assertEquals(0.0, c.untilNext(450.0)!!, 1e-6)
        assertEquals(1L, c.jumps)
        c.stop()
        assertNull(c.untilNext(200.0))
    }

    @Test fun transientPhaseSwingDoesNotMoveTheGrid() {
        val c = BeatClock()
        c.update(126.0, 100.0, 0.0) // grid 100, 576, …
        // The engine's phase swings -150 ms for one observation (next beat 426 instead of 100+476), then comes back.
        c.update(126.0, 376.0, 50.0)
        c.update(126.0, 40.0, 60.0)
        assertEquals(0L, c.jumps)
        assertEquals(40.0, c.untilNext(60.0)!!, 1.0)
        // A timer that wakes 120 ms late (< 40 % of 476 ms) still plays the beat instead of skipping it.
        assertEquals(0.0, c.untilNext(220.0)!!, 1e-9)
        assertEquals(0L, c.consume())
        assertEquals(0L, c.skips)
    }

    @Test fun lateWakeupStillPlaysTheBeat() {
        val c = BeatClock()
        c.update(126.0, 100.0, 0.0)
        // Timer fires 7 ms late: the beat is due now, not skipped.
        assertEquals(0.0, c.untilNext(107.0)!!, 1e-9)
        assertEquals(0L, c.consume())
        // A snapshot arriving between due and consume does not drop the pending beat.
        val p = 60_000.0 / 126.0
        c.update(126.0, 0.0, 100.0 + p + 5)
        assertEquals(0.0, c.untilNext(100.0 + p + 5)!!, 1e-6)
        assertEquals(1L, c.consume())
        // Missed by far more than the tolerance (app suspended): skipped.
        val wait = c.untilNext(100.0 + 5 * p)!!
        assertEquals(true, wait < p)
    }
}
