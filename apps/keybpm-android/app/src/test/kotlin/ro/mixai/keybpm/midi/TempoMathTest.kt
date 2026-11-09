package ro.mixai.keybpm.midi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TempoMathTest {
    @Test
    fun clockTickIs24PerQuarterNote() {
        // 120 BPM = 500 ms per beat = 20.833 ms per tick.
        assertEquals(20_833_333L, TempoMath.tickNanos(120.0))
        assertEquals(TempoMath.tickNanos(300.0), TempoMath.tickNanos(999.0))
    }

    @Test
    fun steadyTapsGiveTheTempo() {
        val taps = (0 until 6).map { it * 500L }
        assertEquals(120.0, TempoMath.tapBpm(taps)!!, 0.01)
    }

    @Test
    fun aMissedTapIsIgnored() {
        // 125 BPM = 480 ms, one tap missed (960 ms gap).
        val taps = listOf(0L, 480, 960, 1920, 2400, 2880)
        assertEquals(125.0, TempoMath.tapBpm(taps)!!, 0.01)
    }

    @Test
    fun aLongPauseStartsANewTempo() {
        val old = listOf(0L, 600, 1200, 1800)
        val new = listOf(6000L, 6400, 6800, 7200)
        assertEquals(150.0, TempoMath.tapBpm(old + new)!!, 0.01)
    }

    @Test
    fun tooFewTapsGiveNothing() {
        assertNull(TempoMath.tapBpm(listOf(0L, 500)))
        assertNull(TempoMath.tapBpm(emptyList()))
    }
}
