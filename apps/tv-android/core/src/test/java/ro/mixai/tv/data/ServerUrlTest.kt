package ro.mixai.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A TLS server (public demo `https://demo.mixai.ro`) must keep https/443 through manual entry and Quick Connect. */
class ServerUrlTest {
    @Test fun normalizeKeepsLanDefaults() {
        assertEquals("http://192.168.1.5:17899", Settings.normalizeBaseUrl("192.168.1.5"))
        assertEquals("http://10.0.0.2:8080", Settings.normalizeBaseUrl("http://10.0.0.2:8080/"))
    }

    @Test fun normalizeLeavesHttpsOnDefaultPort() {
        assertEquals("https://demo.mixai.ro", Settings.normalizeBaseUrl("https://demo.mixai.ro/"))
        assertEquals("https://demo.mixai.ro:8443", Settings.normalizeBaseUrl("https://demo.mixai.ro:8443"))
    }

    @Test fun discoveredServerRoundTripsHttps() {
        val s = DiscoveredServer.fromBaseUrl("https://demo.mixai.ro", "demo")!!
        assertEquals(443, s.port)
        assertEquals("https://demo.mixai.ro", s.baseUrl)
        assertEquals("demo", s.name)
    }

    @Test fun discoveredServerLanStaysHttp() {
        val s = DiscoveredServer.fromBaseUrl("http://192.168.1.5:17899")!!
        assertEquals("http://192.168.1.5:17899", s.baseUrl)
        assertEquals("192.168.1.5", s.name)
        assertEquals("http://10.0.0.9:17899", DiscoveredServer("10.0.0.9", 17899, "x").baseUrl)
        assertNull(DiscoveredServer.fromBaseUrl("not a url"))
    }
}
