package ro.mixai.tv.player

import android.content.Context
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import ro.mixai.tv.BuildConfig
import ro.mixai.tv.R
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Song
import ro.mixai.tv.data.VideoFile
import ro.mixai.tv.ui.EmptyState
import ro.mixai.tv.ui.EmptyTone
import ro.mixai.tv.ui.theme.Tokens

sealed interface PlayRequest {
    /** `fromStart` ignores any saved resume position. */
    data class Video(val file: VideoFile, val hls: Boolean, val fromStart: Boolean = false) : PlayRequest
    data class Music(val songs: List<Song>, val startIndex: Int) : PlayRequest
}

private const val SEEK_MS = 10_000L
private const val PROGRESS_EVERY_MS = 5_000L

@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(
    api: MmoApi,
    request: PlayRequest,
    resumeMs: Long = 0L,
    onProgress: (fileId: String, posMs: Long, durMs: Long) -> Unit = { _, _, _ -> },
    onExit: () -> Unit,
) {
    val context = LocalContext.current
    var error by remember { mutableStateOf<String?>(null) }
    var nowPlaying by remember { mutableStateOf<MediaMetadata?>(null) }
    var playing by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }

    val player = remember {
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("MixAI-TV/${BuildConfig.VERSION_NAME}")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
        ExoPlayer.Builder(context)
            .setRenderersFactory(
                DefaultRenderersFactory(context).setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER),
            )
            .setMediaSourceFactory(DefaultMediaSourceFactory(context).setDataSourceFactory(http))
            .setHandleAudioBecomingNoisy(true)
            .build()
    }
    // In-activity MediaSession: the remote's transport keys + system now-playing (WP6-04d).
    val session = remember(player) { MediaSession.Builder(context, player).build() }

    fun report() {
        val v = request as? PlayRequest.Video ?: return
        val dur = player.duration
        if (dur > 0 && dur != C.TIME_UNSET) onProgress(v.file.fileId, player.currentPosition, dur)
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(e: PlaybackException) { error = "${e.errorCodeName}: ${e.message}" }
            override fun onMediaMetadataChanged(m: MediaMetadata) { nowPlaying = m }
            override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying; if (!isPlaying) report() }
        }
        player.addListener(listener)
        onDispose {
            report()
            player.removeListener(listener)
            session.release()
            player.release()
        }
    }

    LaunchedEffect(request) {
        val items = buildItems(context, api, request)
        val startIndex = (request as? PlayRequest.Music)?.startIndex ?: 0
        val startPos = if (request is PlayRequest.Video && resumeMs > 0) resumeMs else C.TIME_UNSET
        player.setMediaItems(items, startIndex, startPos)
        player.prepare()
        player.playWhenReady = true
        delay(50)
        runCatching { focus.requestFocus() }
    }

    // Persist the resume position every 5 s while playing.
    LaunchedEffect(playing) {
        while (playing) { delay(PROGRESS_EVERY_MS); report() }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(focus)
            .focusable()
            .onKeyEvent { ev ->
                if (ev.type != KeyEventType.KeyDown) return@onKeyEvent false
                when (ev.key) {
                    Key.MediaPlayPause, Key.DirectionCenter, Key.Enter, Key.Spacebar -> {
                        if (player.isPlaying) player.pause() else player.play(); true
                    }
                    Key.MediaPlay -> { player.play(); true }
                    Key.MediaPause -> { player.pause(); true }
                    Key.DirectionRight, Key.MediaFastForward -> { player.seekTo(player.currentPosition + SEEK_MS); true }
                    Key.DirectionLeft, Key.MediaRewind -> { player.seekTo((player.currentPosition - SEEK_MS).coerceAtLeast(0)); true }
                    Key.MediaNext -> { if (player.hasNextMediaItem()) player.seekToNextMediaItem(); true }
                    Key.MediaPrevious -> { player.seekToPreviousMediaItem(); true }
                    Key.MediaStop -> { player.stop(); onExit(); true }
                    else -> false
                }
            },
    ) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    this.player = player
                    useController = true
                    controllerAutoShow = true
                    controllerShowTimeoutMs = 3000
                    setShowNextButton(request is PlayRequest.Music)
                    setShowPreviousButton(request is PlayRequest.Music)
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    keepScreenOn = true
                    isFocusable = false // key events handled by the Compose box
                }
            },
            modifier = Modifier.fillMaxSize(),
        )

        if (request is PlayRequest.Music) {
            Column(Modifier.align(Alignment.TopStart).padding(48.dp)) {
                val art = (nowPlaying?.artworkUri?.toString())
                if (art != null) AsyncImage(model = art, contentDescription = null, modifier = Modifier.size(240.dp))
                Text(nowPlaying?.title?.toString() ?: "", style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
                Text(nowPlaying?.artist?.toString() ?: "", style = MaterialTheme.typography.titleMedium, color = Tokens.mutedForeground)
            }
        }

        error?.let {
            EmptyState(
                icon = "⚠", title = stringResource(R.string.player_error), message = it, tone = EmptyTone.Error,
                modifier = Modifier.align(Alignment.Center).background(Tokens.card).padding(16.dp),
            )
        }
    }
}

private fun buildItems(context: Context, api: MmoApi, request: PlayRequest): List<MediaItem> = when (request) {
    is PlayRequest.Video -> {
        val f = request.file
        val subs = f.subtitleTracks.mapIndexed { ordinal, t ->
            // `/video/subs/:fileId/:track` maps to ffmpeg `0:s:<ordinal>`, so the ordinal among
            // subtitle streams is what the server expects — not the absolute stream index.
            MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse(api.subtitleUrl(f.fileId, ordinal)))
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(t.lang)
                .setLabel(t.title ?: t.lang ?: context.getString(R.string.subtitle_n, ordinal + 1))
                .setSelectionFlags(if (t.forced) C.SELECTION_FLAG_FORCED else 0)
                .build()
        }
        val b = MediaItem.Builder()
            .setMediaId(f.fileId)
            .setSubtitleConfigurations(subs)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(f.title).build())
        if (request.hls) b.setUri(api.hlsUrl(f.fileId)).setMimeType(MimeTypes.APPLICATION_M3U8)
        else b.setUri(api.directUrl(f.fileId))
        listOf(b.build())
    }
    is PlayRequest.Music -> request.songs.map { s ->
        MediaItem.Builder()
            .setMediaId(s.id)
            .setUri(api.streamUrl(s.id))
            .setMimeType(s.contentType)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(s.title)
                    .setArtist(s.artist)
                    .setAlbumTitle(s.album)
                    .setArtworkUri(api.coverArtUrl(s.coverArt ?: s.id)?.let(android.net.Uri::parse))
                    .build(),
            )
            .build()
    }
}
