package ro.mixai.music.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class OfflineUiTest {
    @Test fun listStateAggregatesPerTrackStates() {
        val ids = listOf("a", "b")
        assertEquals(ListOffline.None, listOffline(ids, emptyMap()))
        assertEquals(ListOffline.None, listOffline(emptyList(), mapOf("a" to OfflineState.Done)))
        assertEquals(ListOffline.Done, listOffline(ids, mapOf("a" to OfflineState.Done, "b" to OfflineState.Done)))
        assertEquals(ListOffline.Busy, listOffline(ids, mapOf("a" to OfflineState.Done, "b" to OfflineState.Downloading)))
        assertEquals(ListOffline.Busy, listOffline(ids, mapOf("a" to OfflineState.Queued)))
        assertEquals(ListOffline.Partial, listOffline(ids, mapOf("a" to OfflineState.Done)))
        assertEquals(ListOffline.Partial, listOffline(ids, mapOf("a" to OfflineState.Failed, "b" to OfflineState.Done)))
        assertEquals(ListOffline.Partial, listOffline(ids, mapOf("a" to OfflineState.Waiting)))
    }
}
