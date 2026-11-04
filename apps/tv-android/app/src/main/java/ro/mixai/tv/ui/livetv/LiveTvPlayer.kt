package ro.mixai.tv.ui.livetv

import android.os.SystemClock
import android.util.Log
import android.view.SurfaceView
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.preload.DefaultPreloadManager
import androidx.media3.exoplayer.source.preload.TargetPreloadStatusControl
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.LiveTvNowNext
import ro.mixai.tv.data.generated.LiveTvChannel
import ro.mixai.tv.ui.LocalSqueeze
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.squeezeSuspended
import ro.mixai.tv.ui.theme.Tokens
import ro.mixai.tv.ui.videoBoxFraction
import kotlin.math.abs

private const val BANNER_MS = 4_000L
private const val NUMBER_COMMIT_MS = 1_500L
private const val PRELOAD_RANGE = 1

/**
 * Full-screen live player with fast zapping.
 *
 * Zap path: CH+/CH−/D-pad Up/Down/number entry → banner shown instantly from cached now/next →
 * MediaSource taken from [DefaultPreloadManager] (neighbours N±1 + the last channel are kept
 * prepared with tracks selected) → `setMediaSource` on the ONE ExoPlayer that owns the surface.
 * Zap time = key press → `onRenderedFirstFrame` (`MixaiPerf`).
 */
@OptIn(UnstableApi::class)
@Composable
fun LiveTvPlayerScreen(deps: ScreenDeps, nav: Navigator, channelId: String) {
    val context = LocalContext.current
    val repo = deps.liveTv
    val scope = rememberCoroutineScope()
    val resolver = remember(deps.api) { LiveTvSession.resolver(deps.api, deps.liveTv) }
    val headers = remember { repo.streamHeaders() }

    var channels by remember { mutableStateOf(LiveTvSession.channels) }
    var currentId by remember { mutableStateOf(channelId) }
    var lastId by remember { mutableStateOf(LiveTvSession.lastChannelId?.takeIf { it != channelId }) }
    var nowNext by remember { mutableStateOf<Map<String, LiveTvNowNext>>(emptyMap()) }
    var error by remember { mutableStateOf<String?>(null) }
    var bannerAt by remember { mutableStateOf(SystemClock.uptimeMillis()) }
    var showBanner by remember { mutableStateOf(true) }
    var showStrip by remember { mutableStateOf(false) }
    var numberBuf by remember { mutableStateOf("") }
    var buffering by remember { mutableStateOf(true) }
    var notice by remember { mutableStateOf<String?>(null) }
    var videoAspect by remember { mutableFloatStateOf(0f) }
    var catchupTitle by remember { mutableStateOf<String?>(null) }
    var retryTick by remember { mutableIntStateOf(0) }
    val focus = remember { FocusRequester() }
    val now by rememberNow(15_000L)
    val squeeze = LocalSqueeze.current

    // Zap timing: set on key press, logged on first frame.
    val zapStart = remember { longArrayOf(SystemClock.uptimeMillis()) }
    val zapFrom = remember { arrayOf("open") }

    val renderers = remember { DefaultRenderersFactory(context).setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER) }
    val preloadBuilder = remember {
        DefaultPreloadManager.Builder(context, TargetPreloadStatusControl<Int, DefaultPreloadManager.PreloadStatus> { rank ->
            // rank = channel index; neighbours (circular) and the last channel are preloaded.
            if (rank == LAST_RANK || circularDistance(rank, currentRankIndex[0], currentRankIndex[1]) <= PRELOAD_RANGE) {
                DefaultPreloadManager.PreloadStatus.specifiedRangeLoaded(2_000L)
            } else {
                DefaultPreloadManager.PreloadStatus.PRELOAD_STATUS_NOT_PRELOADED
            }
        })
            .setDataSourceFactory(liveDataSourceFactory(deps.api, headers))
            .setRenderersFactory(renderers)
            .setLoadControl(liveLoadControl())
    }
    val player = remember {
        preloadBuilder.buildExoPlayer(ExoPlayer.Builder(context).setHandleAudioBecomingNoisy(true))
    }
    val preload = remember { preloadBuilder.build() }
    // MediaItem per channel registered in the preload manager (index = rank key).
    val registered = remember { HashMap<String, MediaItem>() }

    DisposableEffect(Unit) {
        squeezeSuspended.value = true
        onDispose { squeezeSuspended.value = false }
    }
    DisposableEffect(player) {
        val l = object : Player.Listener {
            override fun onRenderedFirstFrame() {
                buffering = false
                val ms = SystemClock.uptimeMillis() - zapStart[0]
                Log.i("MixaiPerf", "zap ${ms}ms (${zapFrom[0]} → ${player.currentMediaItem?.mediaId})")
            }
            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
            }
            override fun onPlayerError(e: PlaybackException) {
                val code = (e.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode
                error = when (code) {
                    404 -> context.getString(R.string.livetv_err_404)
                    502, 503, 504 -> context.getString(R.string.livetv_err_upstream, code)
                    null -> context.getString(R.string.livetv_err_generic, e.errorCodeName)
                    else -> context.getString(R.string.livetv_err_http, code)
                }
                player.currentMediaItem?.mediaId?.let { resolver.forget(it) }
            }
            override fun onVideoSizeChanged(v: VideoSize) {
                if (v.width > 0 && v.height > 0) videoAspect = v.width * v.pixelWidthHeightRatio / v.height
            }
        }
        player.addListener(l)
        onDispose {
            player.removeListener(l)
            player.release()
            preload.release()
        }
    }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, ev ->
            when (ev) {
                Lifecycle.Event.ON_STOP -> player.pause()
                Lifecycle.Event.ON_START -> if (error == null) player.play()
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    // Channel list (zapping order): the list the user came from, else the whole lineup.
    LaunchedEffect(Unit) {
        if (channels.none { it.id == channelId }) {
            runCatching { repo.channels() }.onSuccess { all -> channels = all; if (LiveTvSession.channels.isEmpty()) LiveTvSession.channels = all }
        }
    }
    LaunchedEffect(Unit) {
        while (true) {
            runCatching { repo.nowNext() }.onSuccess { list -> nowNext = list.associateBy { it.channelId } }
            delay(60_000L)
        }
    }

    fun indexOf(id: String) = channels.indexOfFirst { it.id == id }
    fun channel(id: String?) = channels.firstOrNull { it.id == id }

    /** Registers channels around [center] (+ last channel) in the preload manager. */
    suspend fun syncPreload(center: String) {
        val idx = indexOf(center)
        if (idx < 0 || channels.isEmpty()) return
        currentRankIndex[0] = idx
        currentRankIndex[1] = channels.size
        val wanted = buildSet {
            for (d in -PRELOAD_RANGE..PRELOAD_RANGE) add(channels[(idx + d).mod(channels.size)].id)
            lastId?.let { add(it) }
        }
        // Drop entries that left the window.
        registered.keys.filter { it !in wanted }.forEach { id -> registered.remove(id)?.let { preload.remove(it) } }
        for (id in wanted) {
            if (registered.containsKey(id)) continue
            val stream = runCatching { resolver.resolve(id) }.getOrNull() ?: continue
            val item = liveMediaItem(id, stream)
            registered[id] = item
            preload.add(item, if (id == lastId && circularDistance(indexOf(id), idx, channels.size) > PRELOAD_RANGE) LAST_RANK else indexOf(id))
        }
        preload.setCurrentPlayingIndex(idx)
        preload.invalidate()
    }

    var playJob by remember { mutableStateOf<Job?>(null) }
    fun play(id: String, from: String) {
        zapStart[0] = SystemClock.uptimeMillis()
        zapFrom[0] = from
        if (id != currentId) {
            lastId = currentId
            LiveTvSession.lastChannelId = currentId
        }
        currentId = id
        error = null
        catchupTitle = null
        buffering = true
        showBanner = true
        bannerAt = SystemClock.uptimeMillis()
        playJob?.cancel()
        playJob = scope.launch {
            val item = registered[id]
            val source = item?.let { preload.getMediaSource(it) }
            if (source != null) {
                zapFrom[0] = "$from, preloaded"
                player.setMediaSource(source)
            } else {
                val stream = try { resolver.resolve(id) } catch (e: Exception) {
                    error = e.message ?: context.getString(R.string.livetv_err_generic, "")
                    return@launch
                }
                player.setMediaItem(liveMediaItem(id, stream))
            }
            player.prepare()
            player.playWhenReady = true
            syncPreload(id)
        }
    }
    fun zap(delta: Int) {
        if (channels.isEmpty()) return
        val idx = indexOf(currentId).takeIf { it >= 0 } ?: 0
        play(channels[(idx + delta).mod(channels.size)].id, if (delta > 0) "up" else "down")
    }
    fun lastChannel() { lastId?.let { play(it, "last") } }

    // First play (live, or a catch-up handed over from the guide).
    LaunchedEffect(retryTick) {
        val cu = LiveTvSession.pendingCatchup?.takeIf { it.channelId == channelId && retryTick == 0 }
        if (cu != null) {
            LiveTvSession.pendingCatchup = null
            zapStart[0] = SystemClock.uptimeMillis(); zapFrom[0] = "catchup"
            catchupTitle = cu.title
            try {
                val s = resolver.catchup(cu.channelId, cu.startMs, cu.durationMin)
                player.setMediaItem(liveMediaItem(cu.channelId, s))
                player.prepare(); player.playWhenReady = true
            } catch (e: Exception) {
                error = e.message ?: context.getString(R.string.livetv_err_generic, "")
            }
        } else {
            play(currentId, if (retryTick == 0) "open" else "retry")
        }
        delay(50)
        runCatching { focus.requestFocus() }
    }
    // Number entry: commit 1.5 s after the last digit.
    LaunchedEffect(numberBuf) {
        if (numberBuf.isEmpty()) return@LaunchedEffect
        delay(NUMBER_COMMIT_MS)
        val target = channels.firstOrNull { it.number == numberBuf } ?: channels.firstOrNull { it.number?.trimStart('0') == numberBuf.trimStart('0') }
        if (target != null) play(target.id, "number") else notice = context.getString(R.string.livetv_no_such_channel, numberBuf)
        numberBuf = ""
    }
    LaunchedEffect(bannerAt, showStrip) {
        if (showStrip) return@LaunchedEffect
        delay(50)
        runCatching { focus.requestFocus() }
        delay(BANNER_MS)
        showBanner = false
    }
    LaunchedEffect(notice) { if (notice != null) { delay(2_500); notice = null } }

    val cur = channel(currentId)
    val recordNowDone = stringResource(R.string.livetv_record_scheduled)
    val recordConflict = stringResource(R.string.livetv_record_conflict)
    fun recordNow() {
        val ch = cur ?: return
        val prog = nowNext[ch.id]?.now
        scope.launch {
            runCatching {
                if (prog != null) repo.recordProgramme(ch.id, prog.start)
                else repo.recordRange(ch.id, System.currentTimeMillis(), System.currentTimeMillis() + 60 * 60_000L, ch.name)
            }.onSuccess { r -> notice = if (r.conflict) recordConflict else recordNowDone }
                .onFailure { notice = it.message }
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(focus)
            .focusable()
            .onKeyEvent { ev ->
                if (ev.type != KeyEventType.KeyDown) return@onKeyEvent false
                val code = ev.key.nativeKeyCode
                if (code in android.view.KeyEvent.KEYCODE_0..android.view.KeyEvent.KEYCODE_9) {
                    numberBuf = (numberBuf + (code - android.view.KeyEvent.KEYCODE_0)).takeLast(4)
                    showBanner = true; bannerAt = SystemClock.uptimeMillis()
                    return@onKeyEvent true
                }
                if (code == android.view.KeyEvent.KEYCODE_LAST_CHANNEL) { lastChannel(); return@onKeyEvent true }
                if (showStrip) {
                    // While the overlay is open the buttons take D-pad; Back closes it.
                    if (ev.key == Key.Back) { showStrip = false; return@onKeyEvent true }
                    return@onKeyEvent false
                }
                when (ev.key) {
                    Key.ChannelUp, Key.DirectionUp -> { zap(+1); true }
                    Key.ChannelDown, Key.DirectionDown -> { zap(-1); true }
                    Key.DirectionCenter, Key.Enter -> { showStrip = true; showBanner = true; true }
                    Key.Info -> { showBanner = !showBanner; bannerAt = SystemClock.uptimeMillis(); true }
                    Key.Guide -> { nav.push(Route.Guide); true }
                    Key.MediaRecord -> { recordNow(); true }
                    Key.MediaPlayPause -> { if (player.isPlaying) player.pause() else player.play(); true }
                    else -> false
                }
            },
    ) {
        val (fw, fh) = if (squeeze != 1f) videoBoxFraction(videoAspect, squeeze) else {
            // Letterbox inside 16:9 ourselves (SurfaceView, no PlayerView): fit the video aspect.
            if (videoAspect <= 0f) 1f to 1f else videoBoxFraction(videoAspect, 1f)
        }
        AndroidView(
            factory = { ctx -> SurfaceView(ctx).also { player.setVideoSurfaceView(it); it.keepScreenOn = true } },
            modifier = Modifier.align(Alignment.Center).fillMaxWidth(fw).fillMaxHeight(fh),
        )

        // Banner (number, logo, name, now/next) — shown immediately on zap, before the first frame.
        val nn = cur?.let { nowNext[it.id] }
        AnimatedVisibility(
            visible = (showBanner || showStrip || buffering || numberBuf.isNotEmpty()) && error == null,
            modifier = Modifier.align(Alignment.BottomCenter),
            enter = fadeIn() + slideInVertically { it / 3 },
            exit = fadeOut() + slideOutVertically { it / 3 },
        ) {
            Column(
                Modifier.fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Tokens.background.copy(alpha = 0.92f))))
                    .padding(horizontal = 64.dp, vertical = 36.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (cur != null) ChannelBanner(cur, nn, now, buffering, catchupTitle)
                if (showStrip) {
                    MiniGuideStrip(channels, indexOf(currentId), nowNext) { id -> showStrip = false; play(id, "strip") }
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        PrimaryButton(stringResource(R.string.livetv_record_now), { recordNow() }, icon = MixaiIcons.Record)
                        SecondaryButton(stringResource(R.string.livetv_last_channel), { showStrip = false; lastChannel() }, enabled = lastId != null)
                        SecondaryButton(stringResource(R.string.livetv_guide), { nav.push(Route.Guide) }, icon = MixaiIcons.Guide)
                        SecondaryButton(stringResource(R.string.livetv_channel_list), { nav.pop() }, icon = Icons.AutoMirrored.Filled.List)
                    }
                }
            }
        }
        if (numberBuf.isNotEmpty()) {
            Text(
                numberBuf, style = MaterialTheme.typography.displaySmall, color = Tokens.foreground,
                modifier = Modifier.align(Alignment.TopEnd).padding(48.dp).background(Tokens.popover.copy(alpha = 0.9f), RoundedCornerShape(12.dp)).padding(horizontal = 24.dp, vertical = 12.dp),
            )
        }
        error?.let { msg ->
            Box(Modifier.fillMaxSize().background(Tokens.background.copy(alpha = 0.85f)), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    ErrorState(message = msg, onRetry = { retryTick++ }, title = cur?.name ?: stringResource(R.string.livetv_err_title))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        SecondaryButton(stringResource(R.string.livetv_next_channel), { zap(+1) })
                        SecondaryButton(stringResource(R.string.livetv_channel_list), { nav.pop() })
                    }
                }
            }
        }
        notice?.let { Toast(it) }
    }
}

private const val LAST_RANK = 1_000_000
/** [playing index, channel count] for the preload status control (read on the preload thread, written on main). */
private val currentRankIndex = intArrayOf(0, 0)

private fun circularDistance(a: Int, b: Int, size: Int): Int {
    val d = abs(a - b)
    return if (size <= 0) d else minOf(d, size - d)
}

@Composable
private fun ChannelBanner(ch: LiveTvChannel, nn: LiveTvNowNext?, now: Long, buffering: Boolean, catchupTitle: String?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(ch.number.orEmpty(), style = MaterialTheme.typography.displaySmall, color = Tokens.foreground, modifier = Modifier.width(110.dp))
        ChannelLogo(ch, 84.dp)
        Spacer(Modifier.width(24.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(ch.name, style = MaterialTheme.typography.headlineSmall, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.width(12.dp))
                if (catchupTitle != null) {
                    Text(stringResource(R.string.livetv_badge_catchup), style = MaterialTheme.typography.labelSmall, color = Tokens.background,
                        modifier = Modifier.background(Tokens.info, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
                } else LiveBadge()
                if (buffering) { Spacer(Modifier.width(12.dp)); Text(stringResource(R.string.livetv_tuning), style = MaterialTheme.typography.labelMedium, color = Tokens.mutedForeground) }
            }
            val p = nn?.now
            when {
                catchupTitle != null -> Text(catchupTitle, style = MaterialTheme.typography.titleMedium, color = Tokens.foreground)
                p != null -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(fmtRange(p), style = MaterialTheme.typography.labelMedium, color = Tokens.mutedForeground, modifier = Modifier.width(150.dp))
                        Text(p.title, style = MaterialTheme.typography.titleMedium, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    LiveProgress(p.progressAt(now), Modifier.width(520.dp), height = 4.dp)
                }
                else -> Text(stringResource(R.string.livetv_no_guide), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
            }
            nn?.next?.takeIf { catchupTitle == null }?.let { n ->
                Row {
                    Text(fmtRange(n), style = MaterialTheme.typography.labelMedium, color = Tokens.mutedForeground, modifier = Modifier.width(150.dp))
                    Text(n.title, style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** Now/next of the neighbouring channels (−2..+2), selectable. */
@Composable
private fun MiniGuideStrip(channels: List<LiveTvChannel>, index: Int, nowNext: Map<String, LiveTvNowNext>, onPick: (String) -> Unit) {
    if (channels.size < 2 || index < 0) return
    // Symmetric window so the current channel stays centred even with few channels.
    val k = minOf(2, (channels.size - 1) / 2).coerceAtLeast(1)
    val around = (-k..k).map { channels[(index + it).mod(channels.size)] }.distinctBy { it.id }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(60); runCatching { first.requestFocus() } }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        around.forEach { ch ->
            val p = nowNext[ch.id]?.now
            androidx.tv.material3.Surface(
                onClick = { onPick(ch.id) },
                modifier = Modifier.weight(1f).let { if (ch.id == channels[index].id) it.focusRequester(first) else it },
                shape = androidx.tv.material3.ClickableSurfaceDefaults.shape(RoundedCornerShape(10.dp)),
                colors = androidx.tv.material3.ClickableSurfaceDefaults.colors(
                    containerColor = if (ch.id == channels[index].id) Tokens.accent else Tokens.card.copy(alpha = 0.85f),
                    contentColor = Tokens.foreground,
                    focusedContainerColor = Tokens.foreground,
                    focusedContentColor = Tokens.background,
                ),
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(listOfNotNull(ch.number, ch.name).joinToString("  "), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(p?.title ?: "—", style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(4.dp))
                    if (p != null) LiveProgress(p.progressAt(System.currentTimeMillis()))
                }
            }
        }
    }
}

