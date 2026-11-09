package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.Band
import ro.mixai.decks.ui.engine.DecksBackend
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.RemoteMixerUi
import ro.mixai.decks.ui.engine.RemotePairingUi
import ro.mixai.decks.ui.engine.RemotePort
import ro.mixai.decks.ui.engine.RemotePumpUi
import ro.mixai.decks.ui.engine.RemoteRoleUi
import ro.mixai.decks.ui.engine.RequestStateUi
import ro.mixai.decks.ui.engine.SongRequestUi

private class FakeRemote : RemotePort {
    override val port = 47321
    var rotations = 0
    var open = true
    var closed = false
    val labels = mutableMapOf<Int, Pair<String?, String?>>()
    val pending = ArrayDeque<RemotePumpUi>()
    val reqs = mutableListOf(SongRequestUi(1, "Strobe", "deadmau5", "", 3, RequestStateUi.PENDING))
    override fun pairing(role: RemoteRoleUi) =
        RemotePairingUi(role, "http://10.0.0.2:$port/?t=$role$rotations", 21, List(21 * 21) { it % 2 == 0 })
    override fun rotate(role: RemoteRoleUi): RemotePairingUi { rotations++; return pairing(role) }
    override fun setTrackLabels(deck: Int, title: String?, artist: String?) { labels[deck] = title to artist }
    override fun pump() = pending.removeFirstOrNull() ?: RemotePumpUi(0, emptyList(), emptyList())
    override fun requests() = reqs.toList()
    override fun setRequestState(id: Long, state: RequestStateUi) {
        val i = reqs.indexOfFirst { it.id == id }
        if (i >= 0) reqs[i] = reqs[i].copy(state = state)
    }
    override fun setPartyOpen(open: Boolean) { this.open = open }
    override fun clearDone() { reqs.removeAll { it.state == RequestStateUi.PLAYED || it.state == RequestStateUi.REJECTED } }
    override fun clientCount() = 2
    override fun close() { closed = true }
}

private class RemoteBackend(val fake: FakeRemote, inner: DecksBackend = DemoBackend { 0.0 }) : DecksBackend by inner {
    override fun startRemote(): RemotePort = fake
}

class RemoteTest {
    @Test fun demoEngineHasNoRemoteAndReportsIt() {
        val ctl = DecksController(DemoBackend { 0.0 })
        assertFalse(ctl.setRemoteEnabled(true))
        assertTrue(ctl.remoteError)
        assertFalse(ctl.remoteOn)
    }

    @Test fun enablingPublishesPairingsAndLabelsLoadedDecks() {
        val fake = FakeRemote()
        val ctl = DecksController(RemoteBackend(fake))
        ctl.startEngine()
        ctl.loadToDeck(0, DemoBackend.DEMO_TRACKS[0])
        repeat(12) { ctl.tick() }
        assertTrue(ctl.setRemoteEnabled(true))
        assertEquals(RemoteRoleUi.entries.toSet(), ctl.pairings.keys)
        assertEquals(21, ctl.pairings.getValue(RemoteRoleUi.GUEST).width)
        assertEquals("Night Drive" to "MixAI", fake.labels[0])
        val before = ctl.pairings.getValue(RemoteRoleUi.VIEWER).url
        ctl.rotatePairing(RemoteRoleUi.VIEWER)
        assertTrue(ctl.pairings.getValue(RemoteRoleUi.VIEWER).url != before)
    }

    @Test fun phoneMixerChangesMoveTheShellKnobs() {
        val fake = FakeRemote()
        val ctl = DecksController(RemoteBackend(fake))
        ctl.startEngine()
        ctl.setRemoteEnabled(true)
        fake.pending += RemotePumpUi(
            3, emptyList(),
            listOf(
                RemoteMixerUi.Eq(1, Band.LOW, -26f),
                RemoteMixerUi.Volume(0, 0.4f),
                RemoteMixerUi.Crossfader(-1f),
            ),
        )
        repeat(4) { ctl.tick() }
        assertEquals(-26f, ctl.controls[1].eqLow)
        assertEquals(0.4f, ctl.controls[0].volume)
        assertEquals(-1f, ctl.crossfader)
    }

    @Test fun moderationAndPartySwitchAndShutdown() {
        val fake = FakeRemote()
        val ctl = DecksController(RemoteBackend(fake))
        ctl.setRemoteEnabled(true)
        repeat(24) { ctl.tick() }
        assertEquals(2, ctl.remoteClients)
        assertEquals(1, ctl.requests.size)
        ctl.moderate(1, RequestStateUi.PLAYED)
        assertEquals(RequestStateUi.PLAYED, ctl.requests.single().state)
        ctl.clearDoneRequests()
        assertTrue(ctl.requests.isEmpty())
        ctl.changePartyOpen(false)
        assertFalse(fake.open)
        assertTrue(ctl.setRemoteEnabled(false))
        assertTrue(fake.closed)
        assertNull(ctl.remote)
        assertTrue(ctl.pairings.isEmpty())
    }
}
