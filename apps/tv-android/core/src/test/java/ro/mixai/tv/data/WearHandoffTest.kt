package ro.mixai.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearHandoffTest {
    @Test fun `round trip keeps connection and profile`() {
        val p = WearHandoff.Payload("https://demo.mixai.ro", "tok", "u1", "p2")
        assertEquals(p, WearHandoff.fromMap(WearHandoff.toMap(p, now = 1)))
    }

    @Test fun `trailing slash is trimmed`() {
        assertEquals("http://10.0.0.2:17899", WearHandoff.fromMap(mapOf("baseUrl" to "http://10.0.0.2:17899/", "token" to "t"))?.baseUrl)
    }

    @Test fun `missing token or non-http base is rejected`() {
        assertNull(WearHandoff.fromMap(mapOf("baseUrl" to "https://x", "token" to " ")))
        assertNull(WearHandoff.fromMap(mapOf("baseUrl" to "ftp://x", "token" to "t")))
        assertNull(WearHandoff.fromMap(emptyMap()))
    }
}
