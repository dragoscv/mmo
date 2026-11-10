package ro.mixai.live

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import ro.mixai.live.core.LiveClient
import ro.mixai.live.core.PairedEngine
import ro.mixai.live.core.Pairing
import ro.mixai.live.core.Role
import ro.mixai.live.ffi.LatencyResult
import ro.mixai.live.ffi.LiveAndroid
import ro.mixai.live.ffi.LocalEngine
import ro.mixai.live.ffi.LocalEngineConfig
import java.io.File

/**
 * The phone as a backup processor (WP21-06): starts the native MixAI Live engine, keeps it alive with a microphone
 * foreground service and points the app's [LiveClient] at it (127.0.0.1, controller token). Not stored as a paired
 * engine: its tokens change on every start. A watchdog stops everything when the audio stream dies (device change,
 * call, AAudio reset) and reports why in [lastError].
 */
class LocalEngineHost(private val ctx: Context, private val client: LiveClient, private val scope: CoroutineScope) {
    private val _engine = MutableStateFlow<LocalEngine?>(null)
    val engine: StateFlow<LocalEngine?> = _engine.asStateFlow()

    /** Why the engine stopped by itself (shown on the card), null after a user stop or a new start. */
    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    private val startLock = Mutex()
    private var watchdog: Job? = null

    /** Engine key (`127.0.0.1:<port>`) while running: the UI uses it to recognise the local connection. */
    val key: String? get() = _engine.value?.paired?.key

    /** What other devices (watch, second phone) may use: LAN address + performer token, only with LAN control on. */
    fun lanPairing(): PairedEngine? {
        val r = _engine.value?.ready ?: return null
        if (r.lanHost == r.localHost) return null
        return Pairing.parse(r.performerUrl)?.copy(name = ctx.getString(R.string.local_engine_name, android.os.Build.MODEL), role = Role.PERFORMER)
    }

    /**
     * Call from the UI while the app is in the foreground and RECORD_AUDIO is granted: the microphone foreground
     * service must start before capture (Android 12+ refuses it from the background, 14+ silences background mics).
     */
    suspend fun start(lan: Boolean): Result<LocalEngine> = startLock.withLock {
        _engine.value?.let { return@withLock Result.success(it) }
        _lastError.value = null
        try {
            ContextCompat.startForegroundService(ctx, Intent(ctx, LocalEngineService::class.java))
        } catch (e: IllegalStateException) {
            return@withLock Result.failure(e)
        } catch (e: SecurityException) {
            return@withLock Result.failure(e)
        }
        val r = withContext(Dispatchers.IO) {
            runCatching { LiveAndroid.init(ctx) }.exceptionOrNull()?.let { return@withContext Result.failure(it) }
            LocalEngine.start(
                LocalEngineConfig(
                    lan = lan,
                    name = ctx.getString(R.string.local_engine_name, android.os.Build.MODEL),
                    dataDir = File(ctx.filesDir, "live").absolutePath,
                ),
            )
        }
        r.onSuccess { e ->
            _engine.value = e
            client.connect(e.paired)
            watch(e)
        }.onFailure {
            ctx.stopService(Intent(ctx, LocalEngineService::class.java))
        }
        r
    }

    private fun watch(e: LocalEngine) {
        watchdog?.cancel()
        watchdog = scope.launch {
            while (isActive && _engine.value === e) {
                delay(1000)
                if (_engine.value === e && !e.alive) {
                    _lastError.value = e.error ?: ctx.getString(R.string.local_stopped_unexpectedly)
                    stop()
                }
            }
        }
    }

    suspend fun measureLatency(): Result<LatencyResult> = withContext(Dispatchers.IO) {
        _engine.value?.measureLatency() ?: Result.failure(IllegalStateException("not running"))
    }

    /** Disconnects at once; the native stop (joins threads, closes AAudio) runs off the main thread. */
    fun stop() {
        val e = _engine.value ?: return
        if (client.state.value.engine?.key == e.paired.key) client.disconnect()
        _engine.value = null
        watchdog?.cancel()
        ctx.stopService(Intent(ctx, LocalEngineService::class.java))
        scope.launch(Dispatchers.IO) { e.stop() }
    }
}
