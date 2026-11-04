package ro.mixai.tv.ambient

import android.content.ComponentName
import android.service.dreams.DreamService
import androidx.core.content.ContextCompat
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import ro.mixai.tv.player.MusicService
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.unit.dp
import androidx.compose.animation.core.Animatable
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import ro.mixai.tv.MixaiApp
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.MediaHome
import ro.mixai.tv.ui.theme.MixaiTheme
import ro.mixai.tv.ui.theme.Tokens
import java.io.File
import java.text.DateFormat
import java.util.Date

/** What the dream shows under the clock while music plays. */
data class AmbientNowPlaying(val title: String, val artist: String?, val coverUrl: String?)

/**
 * Android TV screensaver (WP16-29): slow Ken-Burns crossfade over backdrops from the cached home
 * JSON (`cacheDir/home-*.json`, no network needed for the list) + clock + "Now playing". Images go
 * through the server's cached TMDB proxy using the saved connection.
 */
class MixaiDreamService : DreamService(), LifecycleOwner, SavedStateRegistryOwner {
    private val lifecycleRegistry = LifecycleRegistry(this)
    private val savedState = SavedStateRegistryController.create(this)
    private val nowPlaying = MutableStateFlow<AmbientNowPlaying?>(null)
    private var controllerFuture: ListenableFuture<MediaController>? = null
    override val lifecycle: Lifecycle get() = lifecycleRegistry
    override val savedStateRegistry: SavedStateRegistry get() = savedState.savedStateRegistry

    override fun onCreate() {
        super.onCreate()
        savedState.performRestore(null)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        isInteractive = false
        isFullscreen = true
        isScreenBright = false
        val settings = (application as? MixaiApp)?.settings ?: Settings(this)
        val view = ComposeView(this).apply {
            setViewTreeLifecycleOwner(this@MixaiDreamService)
            setViewTreeSavedStateRegistryOwner(this@MixaiDreamService)
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            setContent { MixaiTheme { DreamContent(settings, cacheDir, nowPlaying) } }
        }
        setContentView(view)
    }

    override fun onDreamingStarted() {
        super.onDreamingStarted()
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        connectMusic()
    }

    override fun onDreamingStopped() {
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        super.onDreamingStopped()
    }

    override fun onDestroy() {
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
        super.onDestroy()
    }

    /** Background music lives in [MusicService]; a controller tells us what (if anything) is playing. */
    private fun connectMusic() {
        val future = MediaController.Builder(this, SessionToken(this, ComponentName(this, MusicService::class.java))).buildAsync()
        controllerFuture = future
        future.addListener({
            val c = runCatching { future.get() }.getOrNull() ?: return@addListener
            fun publish() {
                val m = c.mediaMetadata
                nowPlaying.value = if (c.isPlaying && m.title != null) {
                    AmbientNowPlaying(m.title.toString(), m.artist?.toString(), m.artworkUri?.toString())
                } else null
            }
            c.addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) = publish()
            })
            publish()
        }, ContextCompat.getMainExecutor(this))
    }
}

private val dreamJson = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }

/** Unique backdrop paths from every cached home (newest file first). */
internal fun backdropsFromHomes(raw: List<String>): List<String> =
    raw.mapNotNull { runCatching { dreamJson.decodeFromString<MediaHome>(it) }.getOrNull() }
        .flatMap { h -> h.rows.flatMap { r -> r.items.mapNotNull { it.backdropPath?.takeIf { p -> p.isNotBlank() } } } }
        .distinct()

private suspend fun loadBackdrops(settings: Settings, cacheDir: File): List<String> = withContext(Dispatchers.IO) {
    val conn = settings.connection.first()
    if (!conn.isComplete) return@withContext emptyList()
    val files = cacheDir.listFiles { f -> f.isFile && f.name.startsWith("home-") && f.name.endsWith(".json") }
        ?.sortedByDescending { it.lastModified() }.orEmpty()
    val api = MmoApi(conn.baseUrl, conn.token)
    backdropsFromHomes(files.map { runCatching { it.readText() }.getOrDefault("") })
        .shuffled()
        .take(40)
        .mapNotNull { api.tmdbImageUrl(TmdbSize.backdrop(1280), it) }
}

private const val SLIDE_MS = 12_000

@Composable
private fun DreamContent(settings: Settings, cacheDir: File, nowPlaying: StateFlow<AmbientNowPlaying?>) {
    var urls by remember { mutableStateOf<List<String>>(emptyList()) }
    var index by remember { mutableIntStateOf(0) }
    var clock by remember { mutableStateOf(Date()) }
    val playing by nowPlaying.collectAsState()

    LaunchedEffect(Unit) { urls = loadBackdrops(settings, cacheDir) }
    LaunchedEffect(urls) {
        if (urls.size < 2) return@LaunchedEffect
        while (true) { delay(SLIDE_MS.toLong()); index = (index + 1) % urls.size }
    }
    LaunchedEffect(Unit) { while (true) { clock = Date(); delay(15_000) } }

    Box(Modifier.fillMaxSize().background(Tokens.background)) {
        Crossfade(targetState = urls.getOrNull(index), animationSpec = tween(2_000), label = "dream") { url ->
            if (url != null) KenBurns(url, seed = index)
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Tokens.background.copy(alpha = 0f), Tokens.background.copy(alpha = 0.75f)))))
        Column(Modifier.align(Alignment.BottomStart).padding(56.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(DateFormat.getTimeInstance(DateFormat.SHORT).format(clock), style = MaterialTheme.typography.displayLarge, color = Tokens.foreground)
            Text(DateFormat.getDateInstance(DateFormat.FULL).format(clock), style = MaterialTheme.typography.titleLarge, color = Tokens.mutedForeground)
            playing?.let { np ->
                Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    if (np.coverUrl != null) AsyncImage(np.coverUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(64.dp).clip(RoundedCornerShape(8.dp)))
                    Column {
                        Text(np.title, style = MaterialTheme.typography.titleMedium, color = Tokens.foreground, maxLines = 1)
                        np.artist?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground, maxLines = 1) }
                    }
                }
            }
        }
    }
}

/** Slow zoom + drift; direction alternates with [seed]. */
@Composable
private fun KenBurns(url: String, seed: Int) {
    val t = remember(url) { Animatable(0f) }
    LaunchedEffect(url) { t.animateTo(1f, tween(SLIDE_MS + 2_000, easing = LinearEasing)) }
    val dir = if (seed % 2 == 0) 1f else -1f
    AsyncImage(
        url,
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = Modifier.fillMaxSize().graphicsLayer {
            val s = 1.05f + 0.10f * t.value
            scaleX = s; scaleY = s
            translationX = dir * size.width * 0.03f * (t.value - 0.5f)
            translationY = -size.height * 0.015f * t.value
        },
    )
}
