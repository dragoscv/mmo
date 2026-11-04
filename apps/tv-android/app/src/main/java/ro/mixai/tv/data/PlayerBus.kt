package ro.mixai.tv.data

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import ro.mixai.tv.data.generated.HubMedia

/** Transport command for whatever player is on screen (video, live TV). */
sealed interface PlayerCommand {
    data object Pause : PlayerCommand
    data object Resume : PlayerCommand
    data object Toggle : PlayerCommand
    data class Seek(val positionSec: Double) : PlayerCommand
    /** Relative seek (+/- seconds). */
    data class SeekBy(val deltaSec: Double) : PlayerCommand
    data object Stop : PlayerCommand
    data object Next : PlayerCommand
    data object Previous : PlayerCommand
    /** Watch Together drift correction: playback speed (1.0 = normal). */
    data class Rate(val rate: Double) : PlayerCommand
}

/** What the on-screen player reports (HubClient forwards it as `state`). */
data class NowPlaying(
    val playing: Boolean,
    val positionSec: Double,
    val durationSec: Double?,
    val media: HubMedia?,
    val at: Long = System.currentTimeMillis(),
)

// Process-wide bridge between remote control (hub, MainActivity) and the player composable.
// The player collects [commands] while it is on screen and pushes [update] on state changes and
// every few seconds while playing; it calls [clear] when it leaves.
object PlayerBus {
    private val _commands = MutableSharedFlow<PlayerCommand>(extraBufferCapacity = 16)
    val commands: SharedFlow<PlayerCommand> = _commands.asSharedFlow()

    private val _nowPlaying = MutableStateFlow<NowPlaying?>(null)
    /** null = no player on screen. */
    val nowPlaying: StateFlow<NowPlaying?> = _nowPlaying.asStateFlow()

    /** True when a player is on screen to receive commands. */
    val hasPlayer: Boolean get() = _nowPlaying.value != null

    fun send(cmd: PlayerCommand): Boolean = _commands.tryEmit(cmd)

    fun update(state: NowPlaying) { _nowPlaying.value = state }

    fun clear() { _nowPlaying.value = null }
}
