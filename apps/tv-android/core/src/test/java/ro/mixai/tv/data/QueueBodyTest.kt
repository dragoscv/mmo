package ro.mixai.tv.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import ro.mixai.tv.data.generated.MusicQueueInput

/** The server rejects a queue body without `trackIds` (400 "trackIds must be an array"). */
class QueueBodyTest {
    private val bodyJson = Json { encodeDefaults = true; explicitNulls = false }

    @Test fun emptyQueueStillSendsTrackIdsAndNoNulls() {
        val s = bodyJson.encodeToString(MusicQueueInput.serializer(), MusicQueueInput())
        assertEquals("""{"trackIds":[]}""", s)
        assertFalse(s.contains("null"))
    }

    @Test fun defaultJsonWouldDropTheEmptyList() {
        // Documents the trap the repository avoids.
        assertEquals("{}", Json { explicitNulls = false }.encodeToString(MusicQueueInput.serializer(), MusicQueueInput()))
    }
}
