package ro.mixai.music.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class TvSeekTest {
    @Test fun stepsTenSecondsAndClampsToTheTrack() {
        assertEquals(40_000L, tvSeekTarget(30_000L, 200_000L, +1))
        assertEquals(20_000L, tvSeekTarget(30_000L, 200_000L, -1))
        assertEquals(0L, tvSeekTarget(4_000L, 200_000L, -1))
        assertEquals(199_000L, tvSeekTarget(195_000L, 200_000L, +1)) // never lands on the very end
        assertEquals(0L, tvSeekTarget(0L, 500L, +1)) // sub-second track
    }
}