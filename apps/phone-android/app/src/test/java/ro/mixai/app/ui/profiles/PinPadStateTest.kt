package ro.mixai.app.ui.profiles

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PinPadStateTest {
    @Test
    fun pressAddsDigitsUntilComplete() {
        var s = PinPadState()
        listOf(1, 2, 3).forEach { s = s.press(it) }
        assertEquals("123", s.digits)
        assertFalse(s.isComplete)
        s = s.press(4)
        assertTrue(s.isComplete)
        assertEquals("1234", s.press(5).digits)
    }

    @Test
    fun rejectsNonDigits() {
        val s = PinPadState().press(10).press(-1)
        assertEquals("", s.digits)
    }

    @Test
    fun backspaceAndClear() {
        val s = PinPadState().press(7).press(0)
        assertEquals("7", s.backspace().digits)
        assertEquals("", s.backspace().backspace().backspace().digits)
        assertEquals("", s.clear().digits)
    }

    @Test
    fun customLength() {
        var s = PinPadState(length = 6)
        repeat(6) { s = s.press(it) }
        assertTrue(s.isComplete)
        assertEquals("012345", s.digits)
    }
}
