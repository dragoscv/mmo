package ro.mixai.decks.ui.engine

import ro.mixai.decks.ffi.DecksEngine
import ro.mixai.decks.ffi.DecksRemote
import ro.mixai.decks.ffi.EqBand
import ro.mixai.decks.ffi.RemoteMixerChange
import ro.mixai.decks.ffi.RemotePairing
import ro.mixai.decks.ffi.RemoteRole
import ro.mixai.decks.ffi.SongRequestState

/** [RemotePort] over `decks-ffi` `DecksRemote`. Every FFI failure is swallowed (UI never crashes). */
class FfiRemote private constructor(private val remote: DecksRemote, private val engine: DecksEngine) : RemotePort {
    override val port: Int = runCatching { remote.port().toInt() }.getOrDefault(0)

    /** The controls lock as the binding last reported it: a pump that failed must not read as "unlocked". */
    private var locked = false

    private fun RemoteRoleUi.ffi() = when (this) {
        RemoteRoleUi.CONTROLLER -> RemoteRole.CONTROLLER
        RemoteRoleUi.VIEWER -> RemoteRole.VIEWER
        RemoteRoleUi.GUEST -> RemoteRole.GUEST
    }

    private fun RemotePairing.ui(r: RemoteRoleUi) = RemotePairingUi(r, url, qrWidth.toInt(), qrModules)

    override fun pairing(role: RemoteRoleUi) = runCatching { remote.pairing(role.ffi()).ui(role) }.getOrNull()
    override fun rotate(role: RemoteRoleUi) = runCatching { remote.rotate(role.ffi()).ui(role) }.getOrNull()

    override fun setTrackLabels(deck: Int, title: String?, artist: String?) {
        runCatching { remote.setTrackLabels(deck.toUByte(), title, artist) }
    }

    private fun EqBand.ui() = when (this) { EqBand.LOW -> Band.LOW; EqBand.MID -> Band.MID; EqBand.HIGH -> Band.HIGH }

    override fun pump(): RemotePumpUi = runCatching {
        val r = remote.pump(engine)
        locked = r.controlsLocked
        RemotePumpUi(
            applied = r.applied.toInt(),
            errors = r.errors,
            mixer = r.mixerChanges.map { c ->
                when (c) {
                    is RemoteMixerChange.Volume -> RemoteMixerUi.Volume(c.deck.toInt(), c.value)
                    is RemoteMixerChange.Eq -> RemoteMixerUi.Eq(c.deck.toInt(), c.band.ui(), c.db)
                    is RemoteMixerChange.Filter -> RemoteMixerUi.Filter(c.deck.toInt(), c.value)
                    is RemoteMixerChange.Crossfader -> RemoteMixerUi.Crossfader(c.value)
                    is RemoteMixerChange.MasterVolume -> RemoteMixerUi.MasterVolume(c.value)
                }
            },
            controlsLocked = r.controlsLocked,
        )
    }.getOrElse { RemotePumpUi(0, listOf(it.message ?: it.toString()), emptyList(), locked) }

    override fun requests(): List<SongRequestUi> = runCatching {
        remote.requests().map {
            SongRequestUi(
                it.id.toLong(), it.title, it.artist, it.note, it.votes.toInt(),
                when (it.state) {
                    SongRequestState.PENDING -> RequestStateUi.PENDING
                    SongRequestState.ACCEPTED -> RequestStateUi.ACCEPTED
                    SongRequestState.REJECTED -> RequestStateUi.REJECTED
                    SongRequestState.PLAYED -> RequestStateUi.PLAYED
                },
            )
        }
    }.getOrDefault(emptyList())

    override fun setRequestState(id: Long, state: RequestStateUi) {
        runCatching {
            remote.setRequestState(
                id.toULong(),
                when (state) {
                    RequestStateUi.PENDING -> SongRequestState.PENDING
                    RequestStateUi.ACCEPTED -> SongRequestState.ACCEPTED
                    RequestStateUi.REJECTED -> SongRequestState.REJECTED
                    RequestStateUi.PLAYED -> SongRequestState.PLAYED
                },
            )
        }
    }

    override fun setPartyOpen(open: Boolean) { runCatching { remote.setPartyOpen(open) } }

    override fun setControlsLocked(locked: Boolean) {
        runCatching { remote.setControlsLocked(locked) }
        // What the server holds now, whether or not it took the change (a stopped server refuses it).
        this.locked = runCatching { remote.controlsLocked() }.getOrDefault(this.locked)
    }

    override fun clearDone() { runCatching { remote.clearDoneRequests() } }
    override fun clientCount(): Int = runCatching { remote.clients().size }.getOrDefault(0)

    override fun close() {
        runCatching { remote.stop() }
        runCatching { remote.close() }
    }

    companion object {
        /** Start on every LAN interface (port 0 = any free port). Null when the port cannot open. */
        fun start(engine: DecksEngine, port: Int = 0): FfiRemote? = runCatching {
            FfiRemote(DecksRemote.start(port.toUShort(), true), engine)
        }.onFailure { System.err.println("[decks] remote start failed: $it") }.getOrNull()
    }
}
