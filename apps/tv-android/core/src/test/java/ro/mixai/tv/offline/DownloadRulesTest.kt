package ro.mixai.tv.offline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import ro.mixai.tv.data.generated.TrackCard

class DownloadRulesTest {
    private fun t(id: String) = TrackCard(id = id)

    @Test fun capZeroIsUnlimitedOtherwiseStrictlyBelow() {
        assertTrue(canQueue(10L shl 30, 0))
        assertTrue(canQueue(1, 2))
        assertFalse(canQueue(2, 2))
        assertFalse(canQueue(3, 2))
    }

    @Test fun upcomingSkipsCurrentKnownAndDuplicates() {
        val q = listOf(t("1"), t("2"), t("3"), t("2"), t("4"), t("5"))
        assertEquals(listOf("3", "4"), upcoming(q, 0, 2, setOf("2")).map { it.id })
        assertEquals(listOf("5"), upcoming(q, 4, 3, emptySet()).map { it.id })
        assertEquals(emptyList<TrackCard>(), upcoming(q, 5, 3, emptySet()))
        assertEquals(emptyList<TrackCard>(), upcoming(q, 0, 0, emptySet()))
        assertEquals(emptyList<TrackCard>(), upcoming(q, -1, 3, emptySet()))
    }
}
