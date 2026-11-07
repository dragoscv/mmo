package ro.mixai.tv.cast

import android.content.Context
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Where background music plays (WP17-41h): this device, a Google Cast device (the session player is a
 * Media3 CastPlayer supplied by the app), or a renderer driven by [RendererPlayer] — DLNA/UPnP on the LAN,
 * a Home Assistant media player through the MMO Server cast API, or a MixAI TV through the hub.
 */
sealed interface OutputTarget {
    /** Stable id: `local`, `cast:<routeId>`, `dlna:<udn>`, `ha:<entity>`, `hub:<deviceId>`. */
    val id: String
    val name: String
    val kind: String get() = id.substringBefore(':')

    data object Local : OutputTarget {
        override val id = "local"
        override val name = ""
    }
    data class Cast(val routeId: String, override val name: String) : OutputTarget {
        override val id get() = "cast:$routeId"
    }
    data class Dlna(val renderer: DlnaRenderer) : OutputTarget {
        override val id get() = "dlna:${renderer.udn}"
        override val name get() = renderer.name
    }
    /** [deviceId] is the server id (`ha:media_player.x`). */
    data class HomeAssistant(val deviceId: String, override val name: String) : OutputTarget {
        override val id get() = deviceId
    }
    data class HubTv(val deviceId: String, override val name: String) : OutputTarget {
        override val id get() = "hub:$deviceId"
    }
}

/**
 * Process-wide switchboard between the output picker (app UI) and [ro.mixai.tv.player.MusicService].
 * The service registers [handler]; the app registers [transports] (it owns the API / hub objects) and,
 * for Google Cast, [castControl].
 */
object MusicOutputs {
    private val _active = MutableStateFlow<OutputTarget>(OutputTarget.Local)
    /** The output currently playing (Local when nothing is routed elsewhere). */
    val active: StateFlow<OutputTarget> = _active.asStateFlow()

    private val _switching = MutableStateFlow<OutputTarget?>(null)
    /** Target being connected, null when idle. */
    val switching: StateFlow<OutputTarget?> = _switching.asStateFlow()

    private val _failures = MutableSharedFlow<Failure>(extraBufferCapacity = 4)
    /** A remote output was lost (playback moved back to this device) or could not start. */
    val failures: SharedFlow<Failure> = _failures.asSharedFlow()

    data class Failure(val target: OutputTarget, val message: String)

    /** Set by MusicService while it runs. */
    @Volatile var handler: ((OutputTarget) -> Unit)? = null

    /** Builds the transport for a renderer target; set by the app. Null result = unsupported. */
    @Volatile var transports: ((OutputTarget) -> RemoteTransport?)? = null

    /** Google Cast hooks from the app (MediaRouter / CastContext live there). */
    @Volatile var castControl: CastControl? = null

    interface CastControl {
        /** Starts a Cast session on [routeId]; CastPlayer moves playback when it connects. */
        fun select(routeId: String)
        /** Ends the Cast session; CastPlayer moves playback back to this device. */
        fun stop()
    }

    private var pending: OutputTarget? = null

    /** Ask to play on [target]. Cast targets go straight to [castControl]. */
    fun select(target: OutputTarget) {
        val cur = _active.value
        if (target.id == cur.id) return
        if (target is OutputTarget.Cast) {
            // Leave a renderer first; the Cast session then takes the local queue.
            if (cur !is OutputTarget.Local && cur !is OutputTarget.Cast) handler?.invoke(OutputTarget.Local)
            _switching.value = target
            castControl?.select(target.routeId)
            return
        }
        if (cur is OutputTarget.Cast) castControl?.stop()
        val h = handler
        if (h == null) { pending = target; return }
        h(target)
    }

    /** Target asked for before the service started (the service drains it on create). */
    fun takePending(): OutputTarget? = pending.also { pending = null }

    // ─── state updates (service / cast glue) ──────────────────────────────

    fun setSwitching(target: OutputTarget?) { _switching.value = target }
    fun setActive(target: OutputTarget) {
        _active.value = target
        if (_switching.value?.id == target.id || target is OutputTarget.Local) _switching.value = null
    }
    fun fail(target: OutputTarget, message: String) {
        if (_switching.value?.id == target.id) _switching.value = null
        _failures.tryEmit(Failure(target, message))
    }
}

/**
 * Last output chosen per MMO Server (base URL), so Now Playing can offer a one-tap reconnect. The server is
 * a good proxy for "home network" and needs no location permission (an SSID would).
 */
class OutputMemory(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("mixai_outputs", Context.MODE_PRIVATE)

    data class Entry(val kind: String, val id: String, val name: String)

    fun remember(serverKey: String, target: OutputTarget) {
        if (serverKey.isBlank()) return
        if (target is OutputTarget.Local) { prefs.edit().remove(serverKey).apply(); return }
        prefs.edit().putString(serverKey, encode(Entry(target.kind, target.id, target.name))).apply()
    }

    fun last(serverKey: String): Entry? = prefs.getString(serverKey, null)?.let(::decode)

    companion object {
        fun encode(e: Entry): String = listOf(e.kind, e.id, e.name).joinToString("\u001f")
        fun decode(s: String): Entry? {
            val p = s.split('\u001f')
            if (p.size != 3 || p[1].isBlank()) return null
            return Entry(p[0], p[1], p[2])
        }
    }
}

/**
 * Which stream format to ask MMO Server for (Subsonic `stream.view?format=`, server >= 3.12) so a renderer can
 * play the track. Null = the original file.
 */
object RemoteFormat {
    private val MIME = mapOf(
        "mp3" to "audio/mpeg", "flac" to "audio/flac", "m4a" to "audio/mp4", "mp4" to "audio/mp4", "aac" to "audio/aac",
        "ogg" to "audio/ogg", "oga" to "audio/ogg", "opus" to "audio/ogg", "wav" to "audio/wav", "webm" to "audio/webm",
        "aif" to "audio/aiff", "aiff" to "audio/aiff", "wma" to "audio/x-ms-wma", "ape" to "audio/x-ape", "wv" to "audio/x-wavpack",
        "alac" to "audio/mp4", "dsf" to "audio/x-dsf", "dff" to "audio/x-dff",
    )
    private val ALIASES = mapOf(
        "audio/flac" to setOf("audio/flac", "audio/x-flac"),
        "audio/wav" to setOf("audio/wav", "audio/x-wav", "audio/wave"),
        "audio/mp4" to setOf("audio/mp4", "audio/x-m4a", "audio/m4a"),
        "audio/aac" to setOf("audio/aac", "audio/x-aac", "audio/aacp", "audio/vnd.dlna.adts"),
        "audio/ogg" to setOf("audio/ogg", "application/ogg", "audio/x-ogg"),
        "audio/mpeg" to setOf("audio/mpeg", "audio/mp3", "audio/x-mpeg"),
        "audio/aiff" to setOf("audio/aiff", "audio/x-aiff"),
    )
    /** What Google Cast receivers decode (Default/Styled/Custom media receiver). */
    val CAST_MIMES = setOf("audio/mpeg", "audio/flac", "audio/mp4", "audio/aac", "audio/ogg", "audio/wav", "audio/webm")
    private val LOSSLESS = setOf("flac", "wav", "aif", "aiff", "ape", "wv", "alac", "dsf", "dff")

    fun mimeOf(suffix: String?): String = MIME[suffix?.lowercase()?.trim()] ?: "audio/mpeg"

    /** True when [sink] (renderer mimes; empty = unknown, `*` = anything) accepts [mime]. */
    fun accepts(sink: Set<String>, mime: String): Boolean {
        if (sink.isEmpty() || "*" in sink) return true
        val names = ALIASES[mime] ?: setOf(mime)
        return names.any { it in sink }
    }

    /**
     * Format parameter for a file with [suffix] on a renderer that accepts [sink]. Unknown sink (empty set) keeps
     * the common formats and converts the exotic ones (APE, WavPack, WMA, DSD, ALAC-in-m4a cannot be detected).
     */
    fun choose(suffix: String?, sink: Set<String>): String? {
        val s = suffix?.lowercase()?.trim().orEmpty()
        val mime = mimeOf(s)
        val known = s in MIME && s !in setOf("wma", "ape", "wv", "dsf", "dff", "alac")
        if (known && accepts(sink, mime)) return null
        val lossless = s in LOSSLESS
        if (lossless && accepts(sink, "audio/flac")) return "flac"
        if (accepts(sink, "audio/mpeg")) return "mp3"
        if (accepts(sink, "audio/aac")) return "aac"
        return "mp3"
    }

    /** Mime of the stream after [choose]. */
    fun mimeAfter(suffix: String?, format: String?): String = when (format) {
        null -> mimeOf(suffix)
        "flac" -> "audio/flac"
        "aac" -> "audio/aac"
        "opus" -> "audio/ogg"
        else -> "audio/mpeg"
    }

    /** [url] with `format=` added/replaced (null keeps it untouched). */
    fun withFormat(url: String, format: String?): String {
        if (format == null) return url
        val cleaned = url.replace(Regex("([?&])format=[^&]*&?"), "$1").trimEnd('&', '?')
        return cleaned + (if (cleaned.contains('?')) "&" else "?") + "format=" + format
    }
}
