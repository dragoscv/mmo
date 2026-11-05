package ro.mixai.app.ui.live

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.Request
import ro.mixai.app.BuildConfig
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.Http
import ro.mixai.tv.data.LiveTvRepository
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.generated.LiveTvChannel
import ro.mixai.tv.data.generated.LiveTvProgramme
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap

/** Hand-off between the Live list and the player (zap order + shared resolver). */
internal object LiveSession {
    /** The channel list the user was browsing (current filter): zapping walks this order. */
    @Volatile var channels: List<LiveTvChannel> = emptyList()
    @Volatile private var resolver: StreamResolver? = null

    fun resolver(api: MmoApi, liveTv: LiveTvRepository): StreamResolver =
        resolver?.takeIf { it.api === api } ?: StreamResolver(api, liveTv).also { resolver = it }
}

/** Where Media3 reads a channel from. `proxied` = through MMO Server (needs the device token header). */
internal data class LiveStream(val url: String, val hls: Boolean, val proxied: Boolean)

private val HLS_RE = Regex("""\.m3u8($|[?#])|[?&](type|output|extension)=(m3u8|hls)""", RegexOption.IGNORE_CASE)
internal fun looksLikeHls(url: String): Boolean = HLS_RE.containsMatchIn(url)

// Resolves a channel to a playable URL (port of the TV StreamResolver):
// - HLS upstream: read the server's 302 of the non-proxy URL ourselves (no redirect following, device
//   token header) and play the upstream playlist directly, WITHOUT the token.
// - Anything else (MPEG-TS, HDHomeRun): play through the proxy (`?proxy=1`) with the token header.
internal class StreamResolver(val api: MmoApi, private val liveTv: LiveTvRepository) {
    private val cache = ConcurrentHashMap<String, LiveStream>()
    private val noRedirect by lazy { Http.client.newBuilder().followRedirects(false).followSslRedirects(false).build() }

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

/** HTTP for live media: the device token goes ONLY to the MMO Server host, never upstream. */
@OptIn(UnstableApi::class)
internal fun liveDataSourceFactory(api: MmoApi, headers: Map<String, String>): DataSource.Factory {
    val http = DefaultHttpDataSource.Factory()
        .setUserAgent("MixAI-Phone/${BuildConfig.VERSION_NAME}")
        .setAllowCrossProtocolRedirects(true)
        .setConnectTimeoutMs(8_000)
        .setReadTimeoutMs(15_000)
    val server = Uri.parse(api.baseUrl)
    return ResolvingDataSource.Factory(http) { spec ->
        if (spec.uri.host == server.host && spec.uri.port == server.port) spec.withAdditionalHeaders(headers) else spec
    }
}

@OptIn(UnstableApi::class)
internal fun liveMediaSourceFactory(context: Context, api: MmoApi, headers: Map<String, String>): MediaSource.Factory =
    DefaultMediaSourceFactory(context).setDataSourceFactory(liveDataSourceFactory(api, headers))

/** Small start buffer: zapping speed matters more than rebuffer headroom on live TV. */
@OptIn(UnstableApi::class)
internal fun liveLoadControl(): LoadControl = DefaultLoadControl.Builder()
    .setBufferDurationsMs(8_000, 30_000, 500, 2_000)
    .setPrioritizeTimeOverSizeThresholds(true)
    .build()

internal fun liveMediaItem(channelId: String, stream: LiveStream): MediaItem = MediaItem.Builder()
    .setMediaId(channelId)
    .setUri(stream.url)
    .apply { if (stream.hls) setMimeType(MimeTypes.APPLICATION_M3U8) }
    .build()

// ─── time ─────────────────────────────────────────────────────────────────

private val HHMM: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

internal fun fmtTime(ms: Long): String = HHMM.format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))
internal fun fmtRange(p: LiveTvProgramme): String = "${fmtTime(p.start)} – ${fmtTime(p.stop)}"

internal fun LiveTvProgramme.progressAt(now: Long): Float =
    if (stop <= start) 0f else ((now - start).toFloat() / (stop - start)).coerceIn(0f, 1f)

/** Wall clock ticking every [periodMs]. */
@Composable
internal fun rememberNow(periodMs: Long = 60_000L): State<Long> {
    val state = remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(periodMs) {
        while (true) { delay(periodMs); state.longValue = System.currentTimeMillis() }
    }
    return state
}

/** Absolute logo URL (server may return a path relative to itself). */
internal fun logoUrl(api: MmoApi, logo: String?): String? = when {
    logo.isNullOrBlank() -> null
    logo.startsWith("http://") || logo.startsWith("https://") -> logo
    logo.startsWith("/") -> api.baseUrl + logo
    else -> logo
}

/** Channel logo, or number / initials on a tinted tile. */
@Composable
internal fun ChannelLogo(api: MmoApi, channel: LiveTvChannel, size: Dp, modifier: Modifier = Modifier) {
    Box(
        modifier.size(size).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.surfaceContainerHighest),
        contentAlignment = Alignment.Center,
    ) {
        val fallback = channel.number ?: channel.name.split(' ').filter { it.isNotBlank() }.take(2).joinToString("") { it.take(1) }.uppercase()
        Text(fallback, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Clip)
        val url = logoUrl(api, channel.logo)
        if (url != null) {
            AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.size(size).padding(4.dp))
        }
    }
}
