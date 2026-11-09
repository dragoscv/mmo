package ro.mixai.keybpm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MixNextTest {
    @Test
    fun nextKeysSkipSameAndClashAndKeepEngineOrder() {
        val candidates = listOf(
            "same" to 21, "relative" to 0, "clash" to 3, "adjacent" to 16, "adjacent" to 14, "energy_boost" to 23,
        )
        assertEquals(listOf(0, 16, 14), MixNext.nextKeysForNotification(candidates))
    }

    @Test
    fun nextKeysDeduplicateAndRespectMax() {
        val candidates = listOf("relative" to 0, "diagonal" to 0, "adjacent" to 16)
        assertEquals(listOf(0, 16), MixNext.nextKeysForNotification(candidates))
        assertEquals(listOf(0), MixNext.nextKeysForNotification(candidates, max = 1))
        assertEquals(emptyList<Int>(), MixNext.nextKeysForNotification(listOf("same" to 21, "clash" to 3)))
    }

    @Test
    fun joinLabelsFormatsTheNextLine() {
        assertEquals("9A · 7A · 8B", MixNext.joinLabels(listOf("9A", "7A", "8B")))
        assertNull(MixNext.joinLabels(emptyList()))
    }

    @Test
    fun boothChipNeedsChargingLandscapeAndListening() {
        assertTrue(MixNext.showBoothChip(charging = true, landscape = true, listening = true))
        assertFalse(MixNext.showBoothChip(charging = false, landscape = true, listening = true))
        assertFalse(MixNext.showBoothChip(charging = true, landscape = false, listening = true))
        assertFalse(MixNext.showBoothChip(charging = true, landscape = true, listening = false))
    }
}
