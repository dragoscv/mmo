package ro.mixai.live.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTest {
    private val tok = "0123456789abcdef0123456789abcdef"

    @Test fun parsesQrSchemeLink() {
        val e = Pairing.parse("mixai-live://pair?host=192.168.1.20&port=17930&t=$tok&name=Stage%20Left")!!
        assertEquals("192.168.1.20", e.host)
        assertEquals(17930, e.port)
        assertEquals(tok, e.token)
        assertEquals("Stage Left", e.name)
    }

    @Test fun parsesWebRemoteLink() {
        val e = Pairing.parse("http://10.0.0.7:17920/?t=$tok")!!
        assertEquals("10.0.0.7", e.host)
        assertEquals(17920, e.port)
        assertEquals("ws://10.0.0.7:17920/ws?t=$tok&c=x", e.wsUrl("x"))
        assertEquals("http://10.0.0.7:17920", e.httpBase)
    }

    @Test fun parsesHandTypedForms() {
        assertEquals(17920, Pairing.parse("10.0.0.7/?t=$tok")!!.port)
        assertEquals(18000, Pairing.parse("  10.0.0.7:18000 t=$tok ")!!.port)
    }

    @Test fun ipv6Bracketing() {
        val e = Pairing.parse("http://[fe80::1]:17920/?t=$tok")!!
        assertEquals("fe80::1", e.host)
        assertEquals("http://[fe80::1]:17920", e.httpBase)
    }

    @Test fun rejectsBadInput() {
        assertNull(Pairing.parse(""))
        assertNull(Pairing.parse("http://10.0.0.7:17920/"))
        assertNull(Pairing.parse("http://10.0.0.7:17920/?t=zz"))
        assertNull(Pairing.parse("ftp://10.0.0.7/?t=$tok"))
        assertNull(Pairing.parse("mixai-live://pair?t=$tok"))
    }

    @Test fun jsonRoundTripForWatch() {
        val e = PairedEngine(name = "Ș stage", host = "h", port = 1, token = tok, role = Role.PERFORMER)
        assertEquals(e, PairedEngine.fromJson(e.toJson()))
        assertNull(PairedEngine.fromJson("{"))
    }
}
