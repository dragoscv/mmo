package ro.mixai.live.wear

import android.app.Application
import android.content.ComponentName
import android.content.Context
import androidx.core.content.edit
import androidx.wear.tiles.TileService
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import ro.mixai.live.core.ClientMsg
import ro.mixai.live.core.EngineStore
import ro.mixai.live.core.LiveClient
import ro.mixai.live.core.PairedEngine
import ro.mixai.live.core.Phase

/** One client per watch process; meters at 10 Hz (protocol: watches use meters_hz). */
class LiveWearApp : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val store by lazy { EngineStore(this) }
    val client by lazy { LiveClient(clientId = "watch-" + android.os.Build.MODEL.filter { it.isLetterOrDigit() }.take(16).ifEmpty { "wear" }, metersHz = 10) }

    override fun onCreate() {
        super.onCreate()
        // Keep the tile + complication in step with the current part / mute.
        scope.launch {
            client.state
                .map { s -> Glance(s.phase == Phase.CONNECTED, s.session?.currentPart?.name, s.session?.currentSong?.title, s.session?.mix?.mute == true) }
                .distinctUntilChanged()
                .collect { g ->
                    LastGlance.save(this@LiveWearApp, g)
                    requestSurfaces(this@LiveWearApp)
                }
        }
    }

    fun use(engine: PairedEngine) {
        scope.launch { store.save(engine) }
        client.connect(engine)
    }

    /** Tile actions arrive with the app possibly cold: connect to the stored engine first, then send. */
    fun sendWhenReady(msg: ClientMsg) {
        scope.launch {
            if (client.state.value.phase == Phase.IDLE) {
                val e = store.engines.first().firstOrNull() ?: return@launch
                client.connect(e)
            }
            val deadline = System.currentTimeMillis() + 5000
            while (!client.state.value.connected && System.currentTimeMillis() < deadline) delay(50)
            client.send(msg)
        }
    }

    companion object {
        fun requestSurfaces(ctx: Context) {
            runCatching { TileService.getUpdater(ctx).requestUpdate(LiveTileService::class.java) }
            runCatching {
                ComplicationDataSourceUpdateRequester.create(ctx, ComponentName(ctx, LiveComplicationService::class.java)).requestUpdateAll()
            }
        }
    }
}

data class Glance(val connected: Boolean, val part: String?, val song: String?, val muted: Boolean)

/** Last known glance for the tile/complication (they render without the app process holding state). */
object LastGlance {
    private const val PREFS = "live_glance"

    fun save(ctx: Context, g: Glance) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
            putBoolean("c", g.connected).putString("p", g.part).putString("s", g.song).putBoolean("m", g.muted)
        }
    }

    fun get(ctx: Context): Glance {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Glance(p.getBoolean("c", false), p.getString("p", null), p.getString("s", null), p.getBoolean("m", false))
    }
}
