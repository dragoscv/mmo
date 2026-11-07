package ro.mixai.tv.data

import androidx.media3.common.Player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HubMusicTest {
    @Test fun `repeat keys map to player modes`() {
        assertEquals(Player.REPEAT_MODE_OFF, RepeatMode.of("off")?.playerMode)
        assertEquals(Player.REPEAT_MODE_ALL, RepeatMode.of("all")?.playerMode)
        assertEquals(Player.REPEAT_MODE_ONE, RepeatMode.of("one")?.playerMode)
        assertNull(RepeatMode.of("loop"))
        assertNull(RepeatMode.of(null))
    }
}
