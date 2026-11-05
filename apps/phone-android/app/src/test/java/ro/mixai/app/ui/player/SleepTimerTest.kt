package ro.mixai.app.ui.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SleepTimerTest {
    private var clock = 1_000_000L
    private val timer = SleepTimer { clock }

    @Test
    fun offByDefault() {
        assertFalse(timer.active)
        assertNull(timer.remainingMs())
        assertFalse(timer.shouldPause(0L, 60_000L))
        assertEquals(1f, timer.fadeVolume(), 0.0001f)
    }

    @Test
    fun timedSleepCountsDownAndPauses() {
        timer.start(15)
        assertTrue(timer.active)
        assertEquals(15 * 60_000L, timer.remainingMs())
        clock += 10 * 60_000L
        assertEquals(5 * 60_000L, timer.remainingMs())
        assertFalse(timer.shouldPause(0L, 0L))
        clock += 5 * 60_000L
        assertTrue(timer.shouldPause(0L, 0L))
        assertEquals(0L, timer.remainingMs())
    }

    @Test
    fun fadeStartsInLastThirtySeconds() {
        timer.start(1)
        assertEquals(1f, timer.fadeVolume(), 0.0001f)
        clock += 30_000L
        assertEquals(1f, timer.fadeVolume(), 0.0001f)
        clock += 15_000L
        assertEquals(0.6f, timer.fadeVolume(), 0.0001f)
        clock += 15_000L
        assertEquals(0.2f, timer.fadeVolume(), 0.0001f)
    }

    @Test
    fun endOfEpisodePausesNearTheEnd() {
        timer.startEndOfEpisode()
        assertTrue(timer.active)
        assertNull(timer.remainingMs())
        assertFalse(timer.shouldPause(50_000L, 60_000L))
        assertTrue(timer.shouldPause(58_600L, 60_000L))
        assertFalse(timer.shouldPause(58_600L, 0L))
        assertEquals(1f, timer.fadeVolume(), 0.0001f)
    }

    @Test
    fun cancelClearsEverything() {
        timer.start(30)
        timer.cancel()
        assertFalse(timer.active)
        assertEquals(0, timer.minutes)
        clock += 60 * 60_000L
        assertFalse(timer.shouldPause(0L, 0L))
        timer.start(0)
        assertFalse(timer.active)
    }
}
