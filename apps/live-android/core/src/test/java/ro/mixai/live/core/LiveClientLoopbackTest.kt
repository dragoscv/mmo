package ro.mixai.live.core

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** End-to-end over a real loopback WebSocket: hello/state/meters in, subscribe/controls out, role gate, 401 stop. */
class LiveClientLoopbackTest {
    private lateinit var server: MockWebServer
    private val received = LinkedBlockingQueue<String>()
    private val tok = "ab".repeat(16)

    private fun engineSide(role: String) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send("""{"type":"hello","protocol":1,"version":"0.1.0","role":"$role","engine_name":"Loop"}""")
            webSocket.send(
                """{"type":"state","state":{"preset":"P1","chain":[],"mix":{"input_db":0,"main_db":0,"monitor_db":0,
                   "monitor_dry":0,"bypass":false,"mute":false},"setlist":null,"position":null,"presets":["P1"],"bpm":null,"revision":1}}""",
            )
            webSocket.send("""{"type":"meters","in_peak":0.25,"out_peak":[0.1,0.1],"tune":null,"latency_probe":"idle"}""")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            received += text
            if (text.contains("\"panic\"")) webSocket.send("""{"type":"ack","id":${Regex("\"id\":(\\d+)").find(text)?.groupValues?.get(1)}}""")
        }

        // Like tungstenite on the engine: answer the client's close frame.
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }
    }

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After fun tearDown() {
        server.close()
    }

    private fun engine() = PairedEngine(name = "Loop", host = server.hostName, port = server.port, token = tok)

    private var probe: LiveClient? = null

    private fun await(timeoutMs: Long = 5000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (!cond()) {
            if (System.currentTimeMillis() > end) {
                throw AssertionError("timed out: state=${probe?.state?.value} requests=${server.requestCount}")
            }
            Thread.sleep(10)
        }
    }

    @Test fun performerRoundTrip() {
        server.enqueue(MockResponse.Builder().webSocketUpgrade(engineSide("performer")).build())
        val client = LiveClient(clientId = "test-1")
        client.connect(engine())
        await { client.state.value.session != null && client.meters.value != null }
        val s = client.state.value
        assertEquals(Phase.CONNECTED, s.phase)
        assertEquals(Role.PERFORMER, s.role)
        assertEquals("P1", s.session?.preset)
        assertEquals(0.25f, client.meters.value!!.inPeak)

        val req = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/ws?t=$tok&c=test-1", req.target)

        val sub = received.poll(5, TimeUnit.SECONDS)
        assertTrue(sub, sub!!.contains("\"subscribe\"") && sub.contains("\"meters\":true"))

        assertNull(client.send(ClientMsg.SetParam(1, "gain", 1f)))
        val id = client.send(ClientMsg.Panic)
        assertNotNull(id)
        val panic = received.poll(5, TimeUnit.SECONDS)!!
        assertTrue(panic, panic.contains("\"type\":\"panic\"") && panic.contains("\"id\":$id"))

        client.disconnect()
        assertEquals(Phase.IDLE, client.state.value.phase)
        assertNull(client.meters.value)
    }

    @Test fun unauthorizedStopsReconnecting() {
        server.enqueue(MockResponse.Builder().code(401).body("token").build())
        val client = LiveClient(clientId = "test-2")
        client.connect(engine())
        await { client.state.value.phase == Phase.UNAUTHORIZED }
        Thread.sleep(800)
        assertEquals(1, server.requestCount)
        client.disconnect()
    }

    @Test fun reconnectsAfterServerDrop() {
        val drop = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.close(1001, "restart")
            }
        }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(drop).build())
        server.enqueue(MockResponse.Builder().webSocketUpgrade(engineSide("viewer")).build())
        val client = LiveClient(clientId = "test-3")
        probe = client
        client.connect(engine())
        await(8000) { client.state.value.phase == Phase.CONNECTED && client.state.value.session != null }
        assertEquals(2, server.requestCount)
        assertEquals(Role.VIEWER, client.state.value.role)
        assertNull(client.send(ClientMsg.Next))
        client.disconnect()
    }
}
