package ro.mixai.app.ui.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteMathTest {
    @Test
    fun classifySwipe_picksDominantAxisAndDirection() {
        assertEquals(Swipe.Left, RemoteMath.classifySwipe(-120f, 30f, 50f))
        assertEquals(Swipe.Right, RemoteMath.classifySwipe(120f, -30f, 50f))
        assertEquals(Swipe.Up, RemoteMath.classifySwipe(20f, -200f, 50f))
        assertEquals(Swipe.Down, RemoteMath.classifySwipe(-20f, 200f, 50f))
    }

    @Test
    fun classifySwipe_belowThresholdIsNone() {
        assertEquals(Swipe.None, RemoteMath.classifySwipe(10f, -20f, 50f))
        assertEquals(Swipe.None, RemoteMath.classifySwipe(0f, 0f, 50f))
        assertEquals(Swipe.None, RemoteMath.classifySwipe(49f, 49f, 50f))
    }

    @Test
    fun seekTarget_clampsToDuration() {
        assertEquals(40.0, RemoteMath.seekTarget(30.0, 10.0, 100.0), 0.0)
        assertEquals(100.0, RemoteMath.seekTarget(95.0, 10.0, 100.0), 0.0)
        assertEquals(0.0, RemoteMath.seekTarget(5.0, -10.0, 100.0), 0.0)
    }

    @Test
    fun seekTarget_unknownDurationOnlyClampsAtZero() {
        assertEquals(5010.0, RemoteMath.seekTarget(5000.0, 10.0, null), 0.0)
        assertEquals(5010.0, RemoteMath.seekTarget(5000.0, 10.0, 0.0), 0.0)
        assertEquals(0.0, RemoteMath.seekTarget(3.0, -10.0, null), 0.0)
    }

    @Test
    fun formatClock_minutesAndHours() {
        assertEquals("0:00", RemoteMath.formatClock(0.0))
        assertEquals("1:05", RemoteMath.formatClock(65.4))
        assertEquals("59:59", RemoteMath.formatClock(3599.0))
        assertEquals("1:02:03", RemoteMath.formatClock(3723.0))
        assertEquals("0:00", RemoteMath.formatClock(-4.0))
        assertEquals("0:00", RemoteMath.formatClock(Double.NaN))
    }
}
