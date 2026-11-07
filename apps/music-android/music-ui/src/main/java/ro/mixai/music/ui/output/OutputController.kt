package ro.mixai.music.ui.output

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import ro.mixai.tv.cast.DlnaClient
import ro.mixai.tv.cast.MusicOutputs
import ro.mixai.tv.cast.OutputDiscovery
import ro.mixai.tv.cast.OutputMemory
import ro.mixai.tv.cast.OutputTarget
import ro.mixai.tv.data.Http
import ro.mixai.tv.data.HubClient
import ro.mixai.tv.data.MmoApi

/**
 * Output picker state for one server connection (WP17-41h): non-Cast targets (MixAI TVs, DLNA, Home
 * Assistant), the last output used with this server, and the transport factory the music service uses.
 */
class OutputController(
    context: Context,
    private val api: MmoApi,
    private val hub: HubClient?,
    /** Offer Google Cast devices (false in the phone app, whose video player owns the Cast session). */
    val castEnabled: Boolean = true,
    private val myDeviceId: suspend () -> String?,
) {
    private val app = context.applicationContext
    private val discovery = OutputDiscovery(app, DlnaClient(Http.client))
    private val memory = OutputMemory(app)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val serverKey get() = api.baseUrl

    private val _targets = MutableStateFlow<List<OutputTarget>>(emptyList())
    /** MixAI TVs, DLNA renderers and Home Assistant players from the last [scan]. */
    val targets: StateFlow<List<OutputTarget>> = _targets.asStateFlow()
    private val _scanning = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = _scanning.asStateFlow()

    /** Makes this connection's transports the ones the music service uses. */
    fun install() {
        MusicOutputs.transports = { discovery.transport(it, api, hub) }
    }

    fun scan() {
        if (_scanning.value) return
        _scanning.value = true
        scope.launch {
            try { _targets.value = discovery.all(api, hub, runCatching { myDeviceId() }.getOrNull()) } finally { _scanning.value = false }
        }
    }

    /** Hub TVs change live; refresh them between scans. */
    fun hubTargets(myId: String?): List<OutputTarget> = OutputDiscovery.hubTvs(hub?.devices?.value.orEmpty(), myId)

    fun select(target: OutputTarget) {
        // Returning to the phone keeps the last remote output, so Now Playing can offer "Continue on X".
        if (target !is OutputTarget.Local) memory.remember(serverKey, target)
        MusicOutputs.select(target)
    }

    /** Last non-local output used with this server, when it is not the active one. */
    fun last(): OutputMemory.Entry? = memory.last(serverKey)?.takeIf { it.id != MusicOutputs.active.value.id }

    /** Reconnects to [entry]; DLNA needs a quick search first. Returns false when it is gone. */
    @OptIn(UnstableApi::class)
    suspend fun reconnect(entry: OutputMemory.Entry): Boolean {
        val target = when (entry.kind) {
            "cast" -> CastOutputs.routes.value.firstOrNull { it.id == entry.id }
                ?: run { CastOutputs.scan(true); kotlinx.coroutines.delay(2_500); CastOutputs.routes.value.firstOrNull { it.id == entry.id } }
                    .also { CastOutputs.scan(false) }
            "dlna" -> discovery.restore(entry, hub) ?: run { runCatching { discovery.dlna() }; discovery.restore(entry, hub) }
            else -> discovery.restore(entry, hub)
        } ?: return false
        select(target)
        return true
    }

    fun forget() = memory.remember(serverKey, OutputTarget.Local)

    fun release() {
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }
}
