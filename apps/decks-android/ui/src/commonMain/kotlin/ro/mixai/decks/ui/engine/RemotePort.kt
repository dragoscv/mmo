package ro.mixai.decks.ui.engine

/** Who a pairing code is for (FFI `RemoteRole`). */
enum class RemoteRoleUi { CONTROLLER, VIEWER, GUEST }

/** Pairing URL + QR modules (row-major, `width × width`, true = dark). */
data class RemotePairingUi(val role: RemoteRoleUi, val url: String, val width: Int, val modules: List<Boolean>)

enum class RequestStateUi { PENDING, ACCEPTED, REJECTED, PLAYED }

data class SongRequestUi(
    val id: Long,
    val title: String,
    val artist: String,
    val note: String,
    val votes: Int,
    val state: RequestStateUi,
)

/** A mixer control moved from a phone (so the shell's knobs follow). */
sealed interface RemoteMixerUi {
    data class Volume(val deck: Int, val value: Float) : RemoteMixerUi
    data class Eq(val deck: Int, val band: Band, val db: Float) : RemoteMixerUi
    data class Filter(val deck: Int, val value: Float) : RemoteMixerUi
    data class Crossfader(val value: Float) : RemoteMixerUi
    data class MasterVolume(val value: Float) : RemoteMixerUi
}

data class RemotePumpUi(val applied: Int, val errors: List<String>, val mixer: List<RemoteMixerUi>)

/**
 * Connected mode (WP19-21): phone remote, second screen and Party DJ over the LAN. The JVM/Android
 * implementation wraps `decks-ffi` `DecksRemote`; tests use a fake. All calls are cheap.
 */
interface RemotePort : AutoCloseable {
    val port: Int
    fun pairing(role: RemoteRoleUi): RemotePairingUi?
    fun rotate(role: RemoteRoleUi): RemotePairingUi?
    fun setTrackLabels(deck: Int, title: String?, artist: String?)
    /** Apply phone commands to the engine and publish the engine state. */
    fun pump(): RemotePumpUi
    fun requests(): List<SongRequestUi>
    fun setRequestState(id: Long, state: RequestStateUi)
    fun setPartyOpen(open: Boolean)
    fun clearDone()
    fun clientCount(): Int
}
