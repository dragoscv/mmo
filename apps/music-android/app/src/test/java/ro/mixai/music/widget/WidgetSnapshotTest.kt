package ro.mixai.music.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetSnapshotTest {
    @Test fun `round trip keeps the track but never restores playing`() {
        val s = WidgetSnapshot("One More Time", "Daft Punk", "https://x/cover", playing = true, hasNext = true, hasPrevious = false)
        val back = WidgetSnapshot.decode(s.encode())
        assertEquals(s.copy(playing = false), back)
    }

    @Test fun `missing or corrupt storage is idle`() {
        assertTrue(WidgetSnapshot.decode(null).idle)
        assertTrue(WidgetSnapshot.decode("").idle)
        assertTrue(WidgetSnapshot.decode("{not json").idle)
        assertFalse(WidgetSnapshot(title = "x").idle)
    }
}
