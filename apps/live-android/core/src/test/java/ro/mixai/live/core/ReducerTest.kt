package ro.mixai.live.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReducerTest {
    private val engine = PairedEngine(name = "Stage", host = "192.168.1.5", token = "ab".repeat(16))

    private fun hello(role: Role, protocol: Int = 1) =
        ClientEvent.Message(ServerMsg.HelloMsg(Hello(protocol = protocol, role = role, engineName = "Stage")), 0)

    private fun state(pos: Position?) = ClientEvent.Message(ServerMsg.StateMsg(SessionState(position = pos)), 0)

    @Test fun connectHelloStateFlow() {
        var s = reduce(ClientState(), ClientEvent.Connect(engine))
        assertEquals(Phase.CONNECTING, s.phase)
        assertFalse(s.can(Role.VIEWER))
        s = reduce(s, ClientEvent.Opened)
        s = reduce(s, hello(Role.PERFORMER))
        assertEquals(Phase.CONNECTED, s.phase)
        assertTrue(s.can(Role.PERFORMER))
        assertFalse(s.can(Role.CONTROLLER))
        s = reduce(s, state(Position(0, 0)))
        assertEquals(0, s.sceneChanges)
        s = reduce(s, state(Position(0, 1)))
        assertEquals(1, s.sceneChanges)
        s = reduce(s, state(Position(0, 1)))
        assertEquals(1, s.sceneChanges)
    }

    @Test fun errorsAreKeptUntilCleared() {
        var s = reduce(reduce(ClientState(), ClientEvent.Connect(engine)), hello(Role.CONTROLLER))
        s = reduce(s, ClientEvent.Message(ServerMsg.Error(3, "unknown_preset", "nope"), 1234))
        assertEquals("unknown_preset", s.lastError?.code)
        assertEquals(1234L, s.lastError?.atMillis)
        assertEquals(Phase.CONNECTED, s.phase)
        s = reduce(s, ClientEvent.ClearError)
        assertNull(s.lastError)
    }

    @Test fun closeReconnectsAndUnauthorizedStops() {
        var s = reduce(reduce(ClientState(), ClientEvent.Connect(engine)), hello(Role.VIEWER))
        s = reduce(s, ClientEvent.Closed(unauthorized = false, attempt = 1))
        assertEquals(Phase.RECONNECTING, s.phase)
        assertEquals(1, s.attempt)
        assertFalse(s.can(Role.VIEWER))
        s = reduce(s, hello(Role.VIEWER))
        assertEquals(0, s.attempt)
        s = reduce(s, ClientEvent.Closed(unauthorized = true, attempt = 1))
        assertEquals(Phase.UNAUTHORIZED, s.phase)
    }

    @Test fun newerProtocolAsksForUpdateAndStays() {
        var s = reduce(reduce(ClientState(), ClientEvent.Connect(engine)), hello(Role.CONTROLLER, protocol = 2))
        assertEquals(Phase.UPDATE_REQUIRED, s.phase)
        assertFalse(s.can(Role.VIEWER))
        s = reduce(s, ClientEvent.Closed(false, 1))
        assertEquals(Phase.UPDATE_REQUIRED, s.phase)
    }

    @Test fun disconnectResets() {
        var s = reduce(reduce(ClientState(), ClientEvent.Connect(engine)), hello(Role.CONTROLLER))
        s = reduce(s, ClientEvent.Disconnect)
        assertEquals(ClientState(), s)
        assertEquals(s, reduce(s, ClientEvent.Closed(false, 3)))
    }

    @Test fun roleFallsBackToStoredEngine() {
        val s = reduce(ClientState(), ClientEvent.Connect(engine.copy(role = Role.PERFORMER)))
        assertEquals(Role.PERFORMER, s.role)
    }

    @Test fun backoffGrowsAndCaps() {
        assertEquals(500L, backoffMillis(0))
        assertEquals(1000L, backoffMillis(1))
        assertEquals(8000L, backoffMillis(4))
        assertEquals(10_000L, backoffMillis(9))
        assertEquals(400L, backoffMillis(0, 0.0))
        assertEquals(600L, backoffMillis(0, 1.0))
    }

    @Test fun throttleSendsLeadingAndTrailing() {
        val sent = mutableListOf<Int>()
        val t = Throttle<Int>(30) { sent += it }
        t.offer(1, 0)
        t.offer(2, 10)
        t.offer(3, 20)
        assertEquals(listOf(1), sent)
        t.offer(4, 31)
        assertEquals(listOf(1, 4), sent)
        t.offer(5, 40)
        t.flush(45)
        assertEquals(listOf(1, 4, 5), sent)
        t.flush(50)
        assertEquals(listOf(1, 4, 5), sent)
    }
}
