package ro.mixai.live.ffi

import ro.mixai.live.core.PairedEngine
import ro.mixai.live.core.Role

/**
 * The MixAI Live engine running on this phone (backup processor, no PC). It serves the same protocol v1 as the
 * desktop engine on 127.0.0.1, so the app's [ro.mixai.live.core.LiveClient] connects to [paired] and every screen
 * works unchanged; with `lan = true` other devices (watch, a second phone) can pair with [ready] urls too.
 *
 * Thin, test-friendly wrapper over the generated [LiveEngine]: owns one instance, maps [LiveException] to
 * [Result], never throws on the UI thread for expected failures (no mic permission, device busy).
 */
class LocalEngine private constructor(private val engine: LiveEngine) {
    val ready: EngineReady = engine.ready()

    /** Where the app's own client connects (controller role: full control of the local chain). */
    val paired: PairedEngine = PairedEngine(
        name = LOCAL_NAME,
        host = ready.localHost,
        port = ready.port.toInt(),
        token = ready.controllerToken,
        role = Role.CONTROLLER,
    )

    @Volatile private var stopped = false

    val alive: Boolean get() = !stopped && engine.alive()
    val error: String? get() = if (stopped) null else engine.error()

    fun meters(): LiveMeters? = if (stopped) null else runCatching { engine.meters() }.getOrNull()

    /** Click-train round trip (speaker → mic or a cable). Blocks up to [timeoutMs]: call off the main thread. */
    fun measureLatency(timeoutMs: Int = 6000): Result<LatencyResult> = live { engine.measureLatency(timeoutMs.toUInt()) }

    fun setMute(mute: Boolean): Result<Unit> = live { engine.setMute(mute) }

    private inline fun <T> live(block: () -> T): Result<T> =
        if (stopped) Result.failure(LiveException.NotRunning("stopped")) else guarded(block)

    /** Releases the audio devices and the native object. Idempotent; the instance is dead afterwards. */
    @Synchronized
    fun stop() {
        if (stopped) return
        stopped = true
        engine.stop()
        engine.close()
    }

    companion object {
        /** Name shown for the phone engine; [PairedEngine.key] stays `127.0.0.1:<port>`. */
        const val LOCAL_NAME = "This phone"

        /** Low-latency defaults for phones: 48 kHz, 192-frame callbacks (AAudio rounds to its burst). */
        fun start(config: LocalEngineConfig = LocalEngineConfig()): Result<LocalEngine> =
            guarded { LocalEngine(LiveEngine.start(config)) }

        fun factoryPresets(): List<String> = liveFactoryPresets()

        /** Expected failures come back as [LiveException]; uniffi internal errors are plain [Exception]. */
        internal inline fun <T> guarded(block: () -> T): Result<T> = try {
            Result.success(block())
        } catch (e: LiveException) {
            Result.failure(e)
        } catch (e: Exception) {
            Result.failure(e)
        } catch (e: LinkageError) {
            // Native library missing for this ABI / failed to load: a result, not a crash.
            Result.failure(e)
        }
    }
}

/** Short, user-facing text for a start failure (the UI localises the category, this is the detail). */
fun Throwable.liveReason(): String = when (this) {
    is LiveException.Audio -> reason
    is LiveException.InvalidArgument -> reason
    is LiveException.NotRunning -> reason
    is LiveException.Control -> reason
    is LiveException.Latency -> reason
    else -> message ?: toString()
}
