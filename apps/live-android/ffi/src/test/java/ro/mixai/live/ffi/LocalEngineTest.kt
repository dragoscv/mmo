package ro.mixai.live.ffi

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ro.mixai.live.core.ClientMsg
import ro.mixai.live.core.LiveClient
import ro.mixai.live.core.Phase
import ro.mixai.live.core.Role

/**
 * Loads the HOST build of live-ffi (jna.library.path, see build.gradle.kts) and runs the real engine on the simulated
 * "Null" loopback device, then drives it with the same :live-core [LiveClient] the app uses: proves the bindings,
 * the in-process engine and protocol v1 over 127.0.0.1 together.
 */
class LocalEngineTest {
    private val started = mutableListOf<LocalEngine>()
    private val clients = mutableListOf<LiveClient>()

    private fun nullConfig(lan: Boolean = false) = LocalEngineConfig(audioHost = "Null", bufferFrames = 64u, lan = lan)

    private fun start(cfg: LocalEngineConfig = nullConfig()): LocalEngine =
        LocalEngine.start(cfg).getOrThrow().also { started += it }

    @After fun tearDown() {
        clients.forEach { it.disconnect() }
        started.forEach { it.stop() }
    }

    private fun await(what: String, timeoutMs: Long = 5000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (!cond()) {
            if (System.currentTimeMillis() > end) throw AssertionError("timed out waiting for $what")
            Thread.sleep(10)
        }
    }

    @Test fun startsMutedAndExposesAControllerPairing() {
        val e = start()
        assertTrue(e.alive)
        assertEquals("127.0.0.1", e.paired.host)
        assertEquals(Role.CONTROLLER, e.paired.role)
        assertEquals(32, e.paired.token.length)
        assertEquals("Null", e.ready.audioHost)
        assertFalse("simulated host not offered to users", liveHosts().contains("Null"))
        assertTrue(LocalEngine.factoryPresets().contains("Natural Vocal"))
    }

    @Test fun appClientConnectsOverLoopbackAndControlsTheEngine() {
        val e = start()
        val client = LiveClient(clientId = "test-local").also { clients += it }
        client.connect(e.paired)
        await("connected + state") { client.state.value.phase == Phase.CONNECTED && client.state.value.session != null }
        assertEquals(Role.CONTROLLER, client.state.value.role)
        assertEquals("Natural Vocal", client.state.value.session?.preset)
        assertTrue("phone engines start muted", client.state.value.session?.mix?.mute == true)

        assertNotNull(client.send(ClientMsg.SetMix(mute = false)))
        await("unmuted state") { client.state.value.session?.mix?.mute == false }
        assertNotNull(client.send(ClientMsg.LoadPreset("Pop Polish")))
        await("preset change") { client.state.value.session?.preset == "Pop Polish" }
        await("meters") { client.meters.value != null }
    }

    @Test fun measuresTheLoopbackRoundTrip() {
        val e = start()
        val r = e.measureLatency(6000).getOrThrow()
        val blockMs = 64f / 48f
        assertTrue("round trip ${r.roundTripMs} ms", r.roundTripMs >= blockMs && r.roundTripMs <= blockMs * 4)
        assertEquals("done", e.meters()?.probe)
    }

    @Test fun failuresComeBackAsResultsNotCrashes() {
        val bad = LocalEngine.start(nullConfig().copy(audioHost = "NoSuchHost"))
        assertTrue(bad.isFailure)
        assertTrue(bad.exceptionOrNull() is LiveException.Audio)
        assertTrue(bad.exceptionOrNull()!!.liveReason().isNotBlank())
        val e = start()
        e.stop()
        assertFalse(e.alive)
        started.clear()
    }
}
