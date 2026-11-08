package ro.mixai.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairLinkTest {
    private fun q(vararg kv: Pair<String, String>): (String) -> String? = mapOf(*kv)::get

    @Test fun approveUrlFromConnectPage() {
        val l = parsePairLink("https", "mixai.ro", "/pair", q("host" to "192.168.1.50", "port" to "17899", "code" to "123456"))
        assertEquals(PairLink("123456", "192.168.1.50", 17899), l)
    }

    @Test fun mixaiSchemeAndMusicHost() {
        assertEquals("654321", parsePairLink("mixai", "pair", "", q("code" to "654321"))?.code)
        assertEquals("111222", parsePairLink("https", "music.mixai.ro", "/pair/", q("code" to "111 222"))?.code)
    }

    @Test fun rejectsOtherPathsHostsAndBadCodes() {
        assertNull(parsePairLink("https", "mixai.ro", "/media/movie/1", q("code" to "123456")))
        assertNull(parsePairLink("https", "evil.example", "/pair", q("code" to "123456")))
        assertNull(parsePairLink("http", "mixai.ro", "/pair", q("code" to "123456")))
        assertNull(parsePairLink("https", "mixai.ro", "/pair", q("code" to "12345")))
        assertNull(parsePairLink("mixai", "title", "/movie/1", q("code" to "123456")))
    }

    @Test fun otherServerDetection() {
        val l = PairLink("123456", "192.168.1.50", 17899)
        assertFalse(l.namesOtherServer("http://192.168.1.50:17899"))
        assertTrue(l.namesOtherServer("http://192.168.1.61:17899"))
        assertTrue(l.namesOtherServer("http://192.168.1.50:18000"))
        assertFalse(PairLink("123456", "demo.mixai.ro", 443).namesOtherServer("https://demo.mixai.ro"))
        assertFalse(PairLink("123456", null, null).namesOtherServer("https://x"))
    }
}
