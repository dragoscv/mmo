package ro.mixai.live.core

/** Connection phase of [LiveClient]. */
enum class Phase { IDLE, CONNECTING, CONNECTED, RECONNECTING, UNAUTHORIZED, UPDATE_REQUIRED }

data class LastError(val code: String, val message: String, val atMillis: Long)

/**
 * Everything the UI needs, produced only by [reduce] (pure, unit-tested). Meters are NOT here on purpose: they arrive
 * at 10-30 Hz and live in their own StateFlow so screens read them in the draw phase without recomposing.
 */
data class ClientState(
    val phase: Phase = Phase.IDLE,
    val engine: PairedEngine? = null,
    val hello: Hello? = null,
    val session: SessionState? = null,
    val lastError: LastError? = null,
    val attempt: Int = 0,
    val rttMs: Long? = null,
    /** Bumps when the setlist position changes (scene change haptic). */
    val sceneChanges: Int = 0,
) {
    val role: Role get() = hello?.role ?: engine?.role ?: Role.VIEWER
    val connected: Boolean get() = phase == Phase.CONNECTED
    fun can(required: Role): Boolean = connected && role.atLeast(required)
}

sealed interface ClientEvent {
    data class Connect(val engine: PairedEngine) : ClientEvent
    data object Opened : ClientEvent
    data class Message(val msg: ServerMsg, val nowMillis: Long) : ClientEvent
    data class Closed(val unauthorized: Boolean, val attempt: Int) : ClientEvent
    data object Disconnect : ClientEvent
    data class Rtt(val ms: Long) : ClientEvent
    data object ClearError : ClientEvent
}

/** Pure state machine for the protocol v1 client. */
fun reduce(s: ClientState, e: ClientEvent): ClientState = when (e) {
    is ClientEvent.Connect -> ClientState(phase = Phase.CONNECTING, engine = e.engine)
    ClientEvent.Opened -> s.copy(phase = Phase.CONNECTING)
    is ClientEvent.Message -> when (val m = e.msg) {
        is ServerMsg.HelloMsg -> s.copy(
            hello = m.hello,
            phase = if (m.hello.updateRequired) Phase.UPDATE_REQUIRED else Phase.CONNECTED,
            attempt = 0,
            lastError = null,
        )
        is ServerMsg.StateMsg -> {
            val moved = s.session != null && s.session.position != m.state.position && m.state.position != null
            s.copy(session = m.state, sceneChanges = if (moved) s.sceneChanges + 1 else s.sceneChanges)
        }
        is ServerMsg.Error -> s.copy(lastError = LastError(m.code, m.message, e.nowMillis))
        is ServerMsg.Ack, is ServerMsg.MetersMsg, is ServerMsg.Pong, is ServerMsg.Unknown -> s
    }
    is ClientEvent.Closed -> when {
        s.phase == Phase.IDLE -> s
        e.unauthorized -> s.copy(phase = Phase.UNAUTHORIZED, attempt = e.attempt)
        s.phase == Phase.UPDATE_REQUIRED -> s
        else -> s.copy(phase = Phase.RECONNECTING, attempt = e.attempt)
    }
    ClientEvent.Disconnect -> ClientState()
    is ClientEvent.Rtt -> s.copy(rttMs = e.ms)
    ClientEvent.ClearError -> s.copy(lastError = null)
}

/** Reconnect delay: 0.5 s, 1, 2, 4, 8, capped at 10 s, ±20 % jitter from [rnd] (0..1). */
fun backoffMillis(attempt: Int, rnd: Double = 0.5): Long {
    val base = (500L shl attempt.coerceIn(0, 5)).coerceAtMost(10_000L)
    val jitter = 0.8 + 0.4 * rnd.coerceIn(0.0, 1.0)
    return (base * jitter).toLong()
}

/** dBFS of a linear peak (0 → -inf, clipped to [floor]). */
fun linToDb(lin: Float, floor: Float = -60f): Float =
    if (lin <= 0f || !lin.isFinite()) floor else (20f * kotlin.math.log10(lin)).coerceAtLeast(floor)

/** Meter fill 0..1 for a dB value on a [floor]..0 dB scale. */
fun meterFill(db: Float, floor: Float = -60f): Float = ((db - floor) / -floor).coerceIn(0f, 1f)

private val NOTE_NAMES = arrayOf("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

/** "A4" for MIDI 69 (rounded). */
fun midiName(midi: Float): String {
    val n = Math.round(midi)
    return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floorDiv(n, 12) - 1)
}
