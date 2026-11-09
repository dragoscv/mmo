package ro.mixai.keybpm.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class StageFormatTest {
    @Test
    fun setTimerFormats() {
        assertEquals("0:00", formatElapsed(0))
        assertEquals("4:05", formatElapsed(245_000))
        assertEquals("1:02:03", formatElapsed(3_723_000))
        assertEquals("0:00", formatElapsed(-5))
    }
}
