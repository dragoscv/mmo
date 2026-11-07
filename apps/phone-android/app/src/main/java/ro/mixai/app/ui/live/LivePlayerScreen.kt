package ro.mixai.app.ui.live

import android.content.pm.ActivityInfo
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.compose.PlayerSurface
import androidx.media3.ui.compose.SURFACE_TYPE_SURFACE_VIEW
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.nav.Navigator
import ro.mixai.mobile.ui.errorText
import ro.mixai.app.ui.components.findActivity
import ro.mixai.mobile.theme.Mixai
import ro.mixai.tv.data.LiveTvNowNext
import ro.mixai.tv.data.generated.LiveTvChannel
import kotlin.math.abs

@OptIn(UnstableApi::class)
@Composable
fun LivePlayerScreen(deps: AppDeps, nav: Navigator, channelId: String) {
    val context = LocalContext.current
    val view = LocalView.current
    val resolver = remember(deps.api) { LiveSession.resolver(deps.api, deps.liveTv) }
    var currentId by remember(channelId) { mutableStateOf(channelId) }
    var channels by remember { mutableStateOf(LiveSession.channels) }
    var nowNext by remember { mutableStateOf<LiveTvNowNext?>(null) }
    var buffering by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    var overlay by remember { mutableStateOf(true) }
    var overlayTick by remember { mutableIntStateOf(0) }
    var aspect by remember { mutableFloatStateOf(16f / 9f) }

    val player = remember {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(liveMediaSourceFactory(context, deps.api, deps.liveTv.streamHeaders()))
            .setLoadControl(liveLoadControl())
            .setHandleAudioBecomingNoisy(true)
            .build()
    }
    DisposableEffect(player) {
        val l = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) { buffering = state == Player.STATE_BUFFERING }
            override fun onRenderedFirstFrame() { buffering = false }
            override fun onPlayerError(e: PlaybackException) { error = e; buffering = false; resolver.forget(currentId) }
            override fun onVideoSizeChanged(videoSize: VideoSize) {
                if (videoSize.width > 0 && videoSize.height > 0) {
                    aspect = videoSize.width * videoSize.pixelWidthHeightRatio / videoSize.height
                }
            }
        }
        player.addListener(l)
        onDispose { player.removeListener(l); player.release() }
    }

    // Landscape + hidden system bars while shown; restored on leave.
    DisposableEffect(Unit) {
        val activity = context.findActivity()
        val previous = activity?.requestedOrientation ?: ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        val controller = activity?.window?.let { WindowCompat.getInsetsController(it, view) }
        controller?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller?.hide(WindowInsetsCompat.Type.systemBars())
        view.keepScreenOn = true
        onDispose {
            controller?.show(WindowInsetsCompat.Type.systemBars())
            activity?.requestedOrientation = previous
            view.keepScreenOn = false
        }
    }

    // Pause in the background, resume on return.
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, ev ->
            when (ev) {
                Lifecycle.Event.ON_STOP -> player.pause()
                Lifecycle.Event.ON_START -> if (player.mediaItemCount > 0) player.play()
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    // Channel list for zapping when opened without the Live list (deep link / process restore).
    LaunchedEffect(Unit) {
        if (channels.isEmpty()) runCatching { deps.liveTv.channels() }.getOrNull()?.let { channels = it; LiveSession.channels = it }
    }

    LaunchedEffect(currentId, attempt) {
        error = null
        buffering = true
        player.stop()
        try {
            val stream = resolver.resolve(currentId)
            player.setMediaItem(liveMediaItem(currentId, stream))
            player.prepare()
            player.playWhenReady = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e
            buffering = false
        }
    }
    LaunchedEffect(currentId) {
        nowNext = null
        while (true) {
            nowNext = runCatching { deps.liveTv.nowNext(listOf(currentId)).firstOrNull() }.getOrNull() ?: nowNext
            delay(60_000)
        }
    }
    LaunchedEffect(overlay, overlayTick) {
        if (overlay && error == null) { delay(5_000); overlay = false }
    }

    val channel: LiveTvChannel? = channels.firstOrNull { it.id == currentId }
    fun zap(step: Int) {
        if (channels.size < 2) return
        val i = channels.indexOfFirst { it.id == currentId }
        val next = channels[((if (i < 0) 0 else i) + step).mod(channels.size)]
        currentId = next.id
        overlay = true
        overlayTick++
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .pointerInput(Unit) { detectTapGestures(onTap = { overlay = !overlay; overlayTick++ }) }
            .pointerInput(channels) {
                var total = 0f
                detectVerticalDragGestures(
                    onDragStart = { total = 0f },
                    onDragEnd = {
                        // Swipe up = next channel, swipe down = previous.
                        if (abs(total) > 120f) zap(if (total < 0) 1 else -1)
                    },
                    onVerticalDrag = { _, dy -> total += dy },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        PlayerSurface(
            player = player,
            modifier = Modifier.aspectRatio(aspect.coerceIn(0.5f, 3f), matchHeightConstraintsFirst = true),
            surfaceType = SURFACE_TYPE_SURFACE_VIEW,
        )

        if (buffering && error == null) CircularProgressIndicator(color = Mixai.colors.onScrim)

        error?.let { e ->
            Column(
                Modifier.fillMaxSize().background(Mixai.colors.scrimBase.copy(alpha = 0.85f)).padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = Mixai.colors.onScrim, modifier = Modifier.size(48.dp))
                Spacer(Modifier.size(12.dp))
                Text(stringResource(R.string.live_play_error), style = MaterialTheme.typography.titleMedium, color = Mixai.colors.onScrim, textAlign = TextAlign.Center)
                Text(errorText(e), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.onScrim.copy(alpha = 0.75f), textAlign = TextAlign.Center)
                Spacer(Modifier.size(16.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = { attempt++ }) { Text(stringResource(R.string.action_retry)) }
                    Button(onClick = { nav.pop() }) { Text(stringResource(R.string.action_back)) }
                }
            }
        }

        AnimatedVisibility(visible = overlay && error == null, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.fillMaxSize()) {
            LiveOverlay(deps, channel, nowNext, canZap = channels.size > 1, onBack = { nav.pop() }, onZap = ::zap)
        }
    }
}

@Composable
private fun LiveOverlay(
    deps: AppDeps,
    channel: LiveTvChannel?,
    nowNext: LiveTvNowNext?,
    canZap: Boolean,
    onBack: () -> Unit,
    onZap: (Int) -> Unit,
) {
    val now by rememberNow(30_000L)
    val onScrim = Mixai.colors.onScrim
    val iconColors = IconButtonDefaults.iconButtonColors(contentColor = onScrim)
    Box(Modifier.fillMaxSize().background(Mixai.colors.scrimBase.copy(alpha = 0.45f)).safeDrawingPadding()) {
        IconButton(onClick = onBack, colors = iconColors, modifier = Modifier.align(Alignment.TopStart).padding(8.dp)) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.action_back))
        }
        if (canZap) {
            Column(Modifier.align(Alignment.CenterEnd).padding(8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                IconButton(onClick = { onZap(-1) }, colors = iconColors) {
                    Icon(Icons.Outlined.KeyboardArrowUp, contentDescription = stringResource(R.string.live_channel_prev), modifier = Modifier.size(36.dp))
                }
                IconButton(onClick = { onZap(1) }, colors = iconColors) {
                    Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = stringResource(R.string.live_channel_next), modifier = Modifier.size(36.dp))
                }
            }
        }
        Row(
            Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (channel != null) ChannelLogo(deps.api, channel, 64.dp)
            Column(Modifier.weight(1f).padding(end = 56.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    channel?.number?.let {
                        Text(it, style = MaterialTheme.typography.titleMedium, color = onScrim.copy(alpha = 0.8f))
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(channel?.name.orEmpty(), style = MaterialTheme.typography.titleLarge, color = onScrim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                val cur = nowNext?.now
                if (cur != null) {
                    Text(
                        "${fmtRange(cur)}  ${cur.title}", style = MaterialTheme.typography.bodyLarge, color = onScrim,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    LinearProgressIndicator(
                        progress = { cur.progressAt(now) },
                        modifier = Modifier.fillMaxWidth(0.6f).padding(vertical = 4.dp),
                        trackColor = onScrim.copy(alpha = 0.25f),
                        drawStopIndicator = {},
                    )
                }
                nowNext?.next?.let { nx ->
                    Text(
                        stringResource(R.string.live_next_at, fmtTime(nx.start), nx.title),
                        style = MaterialTheme.typography.bodyMedium, color = onScrim.copy(alpha = 0.75f),
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}
