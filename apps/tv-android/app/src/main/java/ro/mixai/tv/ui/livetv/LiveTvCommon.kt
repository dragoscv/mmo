package ro.mixai.tv.ui.livetv

import android.content.Context
import android.net.Uri
import android.util.Log
import android.view.Choreographer
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.LoadControl
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.Request
import ro.mixai.tv.BuildConfig
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.Http
import ro.mixai.tv.data.LiveTvRepository
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.generated.LiveTvChannel
import ro.mixai.tv.data.generated.LiveTvProgramme
import ro.mixai.tv.ui.theme.Tokens
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.concurrent.ConcurrentHashMap

/** Hand-off between the Live TV screens (no route arguments beyond the channel id exist). */
object LiveTvSession {
    /** The channel list the user was browsing (current group/filter): zapping walks this order. */
    @Volatile var channels: List<LiveTvChannel> = emptyList()
    /** Channel watched before the current one ("last channel" toggle). */
    @Volatile var lastChannelId: String? = null
    /** Guide → player: play this past programme as catch-up instead of live. */
    @Volatile var pendingCatchup: CatchupRequest? = null
    /** Shared stream resolver per server (keeps the redirect cache across screens). */
    @Volatile private var resolver: StreamResolver? = null

    fun resolver(api: MmoApi, liveTv: LiveTvRepository): StreamResolver =
        resolver?.takeIf { it.api === api } ?: StreamResolver(api, liveTv).also { resolver = it }
}

data class CatchupRequest(val channelId: String, val startMs: Long, val durationMin: Int, val title: String)

/** Where Media3 should read a channel from. `proxied` = through the MMO Server (needs the device token header). */
data class LiveStream(val url: String, val hls: Boolean, val proxied: Boolean)

private val HLS_RE = Regex("""\.m3u8($|[?#])|[?&](type|output|extension)=(m3u8|hls)""", RegexOption.IGNORE_CASE)
fun looksLikeHls(url: String): Boolean = HLS_RE.containsMatchIn(url)

/**
 * Resolves a channel to a playable URL.
 * - HLS: the server proxy (`?proxy=1`) pipes only ONE response, so the segment/variant URIs inside a
 *   playlist (relative to the upstream) would resolve against `/livetv/stream/…` and 404. We read the
 *   server's 302 (`/livetv/stream/{id}` without proxy) ourselves and play the upstream URL directly,
 *   WITHOUT our device token (it never leaves the LAN).
 * - Anything else (MPEG-TS, HDHomeRun): play through the proxy with the token header.
 */
class StreamResolver(val api: MmoApi, private val liveTv: LiveTvRepository) {
    private val cache = ConcurrentHashMap<String, LiveStream>()
    private val noRedirect by lazy { Http.client.newBuilder().followRedirects(false).followSslRedirects(false).build() }

    fun cached(channelId: String): LiveStream? = cache[channelId]

    suspend fun resolve(channelId: String): LiveStream {
        cache[channelId]?.let { return it }
        val proxied = liveTv.streamUrl(channelId)
        val direct = proxied.substringBefore("?proxy=1")
        val location = withContext(Dispatchers.IO) { locate(direct) }
        val stream = if (location != null && looksLikeHls(location)) LiveStream(location, hls = true, proxied = false)
        else LiveStream(proxied, hls = false, proxied = true)
        cache[channelId] = stream
        return stream
    }

    suspend fun catchup(channelId: String, startMs: Long, durationMin: Int): LiveStream {
        val url = liveTv.catchupUrl(channelId, startMs, durationMin.coerceIn(1, 1440))
        val location = withContext(Dispatchers.IO) { locate(url) } ?: throw ApiException(404, "no catch-up")
        return LiveStream(location, looksLikeHls(location), proxied = false)
    }

    fun forget(channelId: String) { cache.remove(channelId) }

    private fun locate(url: String): String? {
        val req = Request.Builder().url(url).get().apply { liveTv.streamHeaders().forEach { (k, v) -> header(k, v) } }.build()
        noRedirect.newCall(req).execute().use { res ->
            if (res.isRedirect) {
                val loc = res.header("Location") ?: return null
                return res.request.url.resolve(loc)?.toString() ?: loc
            }
            if (!res.isSuccessful) throw ApiException(res.code, res.body.string().take(200))
            return null
        }
    }
}

/** HTTP for live media: the device token goes ONLY to the MMO Server host (proxied streams), never upstream. */
@OptIn(UnstableApi::class)
fun liveDataSourceFactory(api: MmoApi, headers: Map<String, String>): DataSource.Factory {
    val http = DefaultHttpDataSource.Factory()
        .setUserAgent("MixAI-TV/${BuildConfig.VERSION_NAME}")
        .setAllowCrossProtocolRedirects(true)
        .setConnectTimeoutMs(8_000)
        .setReadTimeoutMs(15_000)
    val server = Uri.parse(api.baseUrl)
    return ResolvingDataSource.Factory(http) { spec ->
        if (spec.uri.host == server.host && spec.uri.port == server.port) spec.withAdditionalHeaders(headers) else spec
    }
}

@OptIn(UnstableApi::class)
fun liveMediaSourceFactory(context: Context, api: MmoApi, headers: Map<String, String>): MediaSource.Factory =
    DefaultMediaSourceFactory(context).setDataSourceFactory(liveDataSourceFactory(api, headers))

/** Small start buffer: zapping speed matters more than rebuffer headroom on live TV. */
@OptIn(UnstableApi::class)
fun liveLoadControl(): LoadControl = DefaultLoadControl.Builder()
    .setBufferDurationsMs(8_000, 30_000, 500, 2_000)
    .setPrioritizeTimeOverSizeThresholds(true)
    .build()

fun liveMediaItem(channelId: String, stream: LiveStream): MediaItem = MediaItem.Builder()
    .setMediaId(channelId)
    .setUri(stream.url)
    .apply { if (stream.hls) setMimeType(MimeTypes.APPLICATION_M3U8) }
    .build()

// ─── time ─────────────────────────────────────────────────────────────────

private val TIME_FMT: DateTimeFormatter = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
private val DAY_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE d MMM")

fun fmtTime(ms: Long): String = TIME_FMT.format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))
fun fmtDay(ms: Long, locale: java.util.Locale = java.util.Locale.getDefault()): String =
    DAY_FMT.withLocale(locale).format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))
fun fmtRange(p: LiveTvProgramme): String = "${fmtTime(p.start)} – ${fmtTime(p.stop)}"

fun LiveTvProgramme.progressAt(now: Long): Float =
    if (stop <= start) 0f else ((now - start).toFloat() / (stop - start)).coerceIn(0f, 1f)

fun LiveTvProgramme.isOnAt(now: Long): Boolean = now in start until stop

/** Wall clock that ticks every [periodMs] (progress bars, "now" line). */
@Composable
fun rememberNow(periodMs: Long = 30_000L): State<Long> {
    val state = remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(periodMs) {
        while (true) { delay(periodMs); state.longValue = System.currentTimeMillis() }
    }
    return state
}

// ─── visuals ──────────────────────────────────────────────────────────────

/** Channel logo, or its number / initials on a tinted tile when there is no logo. */
@Composable
fun ChannelLogo(channel: LiveTvChannel, size: Dp, modifier: Modifier = Modifier) {
    Box(
        modifier.size(size).clip(RoundedCornerShape(8.dp)).background(Tokens.foreground.copy(alpha = 0.08f)),
        contentAlignment = Alignment.Center,
    ) {
        val fallback = channel.number ?: channel.name.split(' ').filter { it.isNotBlank() }.take(2).joinToString("") { it.take(1) }.uppercase()
        Text(fallback, style = MaterialTheme.typography.labelMedium, color = Tokens.mutedForeground, maxLines = 1, overflow = TextOverflow.Clip)
        if (!channel.logo.isNullOrBlank()) {
            AsyncImage(
                model = channel.logo, contentDescription = null, contentScale = ContentScale.Fit,
                modifier = Modifier.size(size).padding(4.dp),
            )
        }
    }
}

/** Thin progress bar of the programme on air. */
@Composable
fun LiveProgress(fraction: Float, modifier: Modifier = Modifier, height: Dp = 3.dp) {
    Box(modifier.fillMaxWidth().height(height).clip(RoundedCornerShape(2.dp)).background(Tokens.foreground.copy(alpha = 0.15f))) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(fraction.coerceIn(0f, 1f)).background(Tokens.primary))
    }
}

// ─── perf ─────────────────────────────────────────────────────────────────

/** Debug-only frame-time sampler: p95/max over [windowMs] via Choreographer → `Log.i("MixaiPerf")`. */
object FramePerf {
    private var running = false

    fun sample(tag: String, windowMs: Long = 5_000L) {
        if (!BuildConfig.DEBUG || running) return
        running = true
        val frames = ArrayList<Long>(400)
        var last = 0L
        var startNs = 0L
        val choreographer = Choreographer.getInstance()
        val cb = object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                if (startNs == 0L) startNs = frameTimeNanos
                if (last != 0L) frames += (frameTimeNanos - last)
                last = frameTimeNanos
                if (frameTimeNanos - startNs < windowMs * 1_000_000L) {
                    choreographer.postFrameCallback(this)
                } else {
                    running = false
                    if (frames.isEmpty()) return
                    val sorted = frames.sorted()
                    val p95 = sorted[((sorted.size - 1) * 0.95).toInt()] / 1e6
                    val p50 = sorted[(sorted.size - 1) / 2] / 1e6
                    val jank = frames.count { it > 33_000_000L }
                    Log.i("MixaiPerf", "$tag frames=${frames.size} p50=${"%.1f".format(p50)}ms p95=${"%.1f".format(p95)}ms max=${"%.1f".format(sorted.last() / 1e6)}ms jank>33ms=$jank")
                }
            }
        }
        choreographer.postFrameCallback(cb)
    }
}
