package ro.mixai.tv

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BrandSoundTest {
    @Test fun theFirstStartPlaysOnceWhenTheSettingIsOn() {
        val gate = StartGate()
        assertTrue(gate.take(enabled = true))
        assertFalse(gate.take(enabled = true))
    }

    @Test fun aStartWithTheSettingOffStaysSilent() {
        assertFalse(StartGate().take(enabled = false))
    }

    @Test fun aSettingTurnedOnLaterDoesNotPlayInTheSameProcess() {
        val gate = StartGate()
        assertFalse(gate.take(enabled = false))
        assertFalse(gate.take(enabled = true))
    }
}
