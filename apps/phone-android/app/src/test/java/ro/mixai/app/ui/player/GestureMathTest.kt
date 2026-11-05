package ro.mixai.app.ui.player

import org.junit.Assert.assertEquals
import org.junit.Test

class GestureMathTest {
    private val hour = 3_600_000L

    @Test
    fun fullWidthDragSpansTenMinutesOnLongMedia() {
        assertEquals(600_000L + 60_000L, seekTargetMs(60_000L, 1000f, 1000f, hour))
        assertEquals(60_000L + 300_000L, seekTargetMs(60_000L, 500f, 1000f, hour))
    }

    @Test
    fun fullWidthDragSpansWholeShortMedia() {
        // 2 min clip: half width = 1 min.
        assertEquals(60_000L, seekTargetMs(0L, 500f, 1000f, 120_000L))
    }

    @Test
    fun seekTargetIsClamped() {
        assertEquals(0L, seekTargetMs(10_000L, -1000f, 1000f, hour))
        assertEquals(hour - 1_000L, seekTargetMs(hour - 5_000L, 1000f, 1000f, hour))
        assertEquals(5_000L, seekTargetMs(5_000L, 300f, 0f, hour))
    }

    @Test
    fun doubleTapSeeksTenSecondsPerTap() {
        assertEquals(40_000L, doubleTapSeek(10_000L, 3, forward = true, durationMs = hour))
        assertEquals(30_000L, doubleTapSeek(50_000L, 2, forward = false, durationMs = hour))
    }

    @Test
    fun doubleTapIsClamped() {
        assertEquals(0L, doubleTapSeek(5_000L, 1, forward = false, durationMs = hour))
        assertEquals(hour - 1_000L, doubleTapSeek(hour - 2_000L, 4, forward = true, durationMs = hour))
    }

    @Test
    fun dragUpRaisesLevelAndClamps() {
        assertEquals(1f, levelAfterDrag(0f, -800f, 800f), 0.0001f)
        assertEquals(0.75f, levelAfterDrag(0.5f, -200f, 800f), 0.0001f)
        assertEquals(0.25f, levelAfterDrag(0.5f, 200f, 800f), 0.0001f)
        assertEquals(0f, levelAfterDrag(0.3f, 2000f, 800f), 0.0001f)
        assertEquals(1f, levelAfterDrag(0.9f, -2000f, 800f), 0.0001f)
    }
}
