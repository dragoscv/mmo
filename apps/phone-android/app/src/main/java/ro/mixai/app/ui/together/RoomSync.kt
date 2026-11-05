package ro.mixai.app.ui.together

import ro.mixai.tv.data.DRIFT_SEEK_MS
import ro.mixai.tv.data.DriftAction
import ro.mixai.tv.data.DriftCorrector
import ro.mixai.tv.data.HubClient
import ro.mixai.tv.data.PlaybackAnchor
import ro.mixai.tv.data.expectedPosition
import kotlin.math.abs

/** What the player should do after a [RoomPlaybackSync.tick]. */
sealed interface SyncCommand {
    /** Nothing to change. */
    data object None : SyncCommand
    /** Set the playback speed multiplier (1f = normal; a correction is within 0.95..1.05). */
    data class SetRate(val rate: Float) : SyncCommand
    /** Hard-seek to [sec] (absolute media position, seconds). */
    data class SeekTo(val sec: Double) : SyncCommand
    /** Room is playing but the local player is paused. */
    data object Play : SyncCommand
    /** Room is paused (or waiting) but the local player is playing. */
    data object Pause : SyncCommand
}

/** Room phases in which media should be stopped (see `RoomState.phase`). */
private val STOPPED_PHASES = setOf("paused", "waiting")

/**
 * Pure sync decision (unit-tested). [phase] is the room phase (idle | waiting | playing | paused),
 * [anchor] the room playback anchor, [serverNowMs] the hub's server-time estimate, [actualSec] the
 * local player position and [isPlaying] whether the local player is playing. [corrector] keeps the
 * hysteresis state between calls (rate correction in progress or not).
 *
 * - room playing, local paused: [SyncCommand.Play]; room paused/waiting, local playing: [SyncCommand.Pause]
 * - both playing: drift above 120 ms gives [SyncCommand.SetRate], above 1.5 s [SyncCommand.SeekTo];
 *   when a rate correction ends the result is `SetRate(1f)` exactly once
 * - both stopped: only a drift of at least 1.5 s yields [SyncCommand.SeekTo] (keeps paused frames aligned)
 * - idle (no media loaded): [SyncCommand.None]
 */
fun syncDecision(
    phase: String,
    anchor: PlaybackAnchor,
    serverNowMs: Double,
    actualSec: Double,
    isPlaying: Boolean,
    corrector: DriftCorrector,
): SyncCommand {
    val roomPlaying = phase == "playing"
    val roomStopped = phase in STOPPED_PHASES
    if (!roomPlaying && !roomStopped) {
        val wasCorrecting = corrector.correcting
        corrector.reset()
        return if (wasCorrecting) SyncCommand.SetRate(1f) else SyncCommand.None
    }
    if (roomPlaying && !isPlaying) {
        corrector.reset()
        return SyncCommand.Play
    }
    if (roomStopped && isPlaying) {
        corrector.reset()
        return SyncCommand.Pause
    }
    val expected = expectedPosition(anchor, serverNowMs)
    if (roomStopped) {
        val wasCorrecting = corrector.correcting
        corrector.reset()
        if (abs(actualSec - expected) * 1000 >= DRIFT_SEEK_MS) return SyncCommand.SeekTo(expected)
        return if (wasCorrecting) SyncCommand.SetRate(1f) else SyncCommand.None
    }
    val wasCorrecting = corrector.correcting
    return when (val act = corrector.update(actualSec, expected)) {
        is DriftAction.Rate -> SyncCommand.SetRate(act.rate.toFloat())
        is DriftAction.Seek -> {
            corrector.reset()
            SyncCommand.SeekTo(act.positionSec)
        }
        DriftAction.None -> if (wasCorrecting) SyncCommand.SetRate(1f) else SyncCommand.None
    }
}

/**
 * Player-side Watch Together controller (port of the TV player's sync loop).
 *
 * Usage from the player, only while [isActiveFor] the playing file:
 * - call [tick] once per second with the player's absolute position (seconds) and playing state, then
 *   apply the returned [SyncCommand]: `SetRate` multiplies the user speed (1f restores it), `SeekTo`
 *   seeks locally (do NOT call [onLocalSeek] for it), `Play`/`Pause` change the local player only
 *   (do NOT call [onLocalPlay]/[onLocalPause] for them, the room already is in that state);
 * - call [onLocalPlay] / [onLocalPause] / [onLocalSeek] when the USER acts on the player; they are
 *   forwarded to the room so every member follows.
 *
 * [tick] also sends `room:report` (position + RTT) on every call while playing. After a local user
 * action, play/pause mismatches are ignored for [graceMs] so the room broadcast can arrive without
 * the controller fighting the user's own command.
 */
class RoomPlaybackSync(
    private val hub: HubClient,
    private val graceMs: Long = 2_500L,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    private val corrector = DriftCorrector()
    private var graceUntilMs = 0L

    /** True when the hub is in a room whose loaded media is [fileId]. */
    fun isActiveFor(fileId: String): Boolean = hub.room.value?.media?.fileId == fileId

    /** One sync step; see the class KDoc. Returns [SyncCommand.None] outside a room. */
    fun tick(actualSec: Double, isPlaying: Boolean): SyncCommand {
        val room = hub.room.value ?: return SyncCommand.None.also { corrector.reset() }
        if (isPlaying) hub.report(actualSec)
        val cmd = syncDecision(room.phase, room.anchor, hub.serverNowMs(), actualSec, isPlaying, corrector)
        if ((cmd == SyncCommand.Play || cmd == SyncCommand.Pause) && nowMs() < graceUntilMs) return SyncCommand.None
        return cmd
    }

    /** The user pressed play at [positionSec]. */
    fun onLocalPlay(positionSec: Double) {
        graceUntilMs = nowMs() + graceMs
        corrector.reset()
        hub.play(positionSec)
    }

    /** The user paused at [positionSec]. */
    fun onLocalPause(positionSec: Double) {
        graceUntilMs = nowMs() + graceMs
        corrector.reset()
        hub.pause(positionSec)
    }

    /** The user sought to [positionSec]. */
    fun onLocalSeek(positionSec: Double) {
        corrector.reset()
        hub.seek(positionSec)
    }

    /** Forget the correction state (e.g. the player was rebuilt). */
    fun reset() {
        corrector.reset()
        graceUntilMs = 0L
    }
}
