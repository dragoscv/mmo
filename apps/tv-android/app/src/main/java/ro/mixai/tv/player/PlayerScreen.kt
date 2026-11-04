package ro.mixai.tv.player

import android.content.Context
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.media3.common.VideoSize
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
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Song
import ro.mixai.tv.data.VideoFile
import ro.mixai.tv.ui.EmptyState
import ro.mixai.tv.ui.EmptyTone
import ro.mixai.tv.ui.LocalSqueeze
import ro.mixai.tv.ui.squeezeSuspended
import ro.mixai.tv.ui.videoBoxFraction
import ro.mixai.tv.ui.theme.Tokens

sealed interface PlayRequest {
    /** `fromStart` ignores any saved resume position. `ref` = TMDB identity for server progress (WP12-01); null → local-only. */
    data class Video(val file: VideoFile, val hls: Boolean, val fromStart: Boolean = false, val ref: MediaRef? = null) : PlayRequest
    data class Music(val songs: List<Song>, val startIndex: Int) : PlayRequest
}

private const val SEEK_MS = 10_000L
private const val PROGRESS_EVERY_MS = 5_000L
private const val SERVER_PROGRESS_EVERY_MS = 10_000L

@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(
    api: MmoApi,
    request: PlayRequest,
    resumeMs: Long = 0L,
    onProgress: (fileId: String, posMs: Long, durMs: Long) -> Unit = { _, _, _ -> },
    /** Server progress (`PUT /media/progress`), called every 10 s while playing and on pause/stop. */
    onServerProgress: (ref: MediaRef, posMs: Long, durMs: Long) -> Unit = { _, _, _ -> },
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
    // Ultrawide compensation: the global UI squeeze steps aside (SurfaceView ignores layer
    // transforms) and the video surface itself is sized so the film is undistorted on the panel.
    val squeeze = LocalSqueeze.current
    var videoAspect by remember { mutableStateOf(0f) }
    DisposableEffect(Unit) {
        squeezeSuspended.value = true
        onDispose { squeezeSuspended.value = false }
    }
    /** HLS started server-side at the resume point: player time is relative to it. */
    val hlsOffsetMs = remember(request) {
        if (request is PlayRequest.Video && request.hls && resumeMs > 0) (resumeMs / 1000) * 1000 else 0L
    }
    fun absPos() = player.currentPosition + hlsOffsetMs
    fun absDur(): Long {
        val d = player.duration
        if (hlsOffsetMs == 0L) return d
        val src = (request as? PlayRequest.Video)?.file?.durationSec
        return if (src != null && src > 0) (src * 1000).toLong() else if (d > 0 && d != C.TIME_UNSET) d + hlsOffsetMs else d
    }

    fun report() {
        val v = request as? PlayRequest.Video ?: return
        val dur = absDur()
        if (dur > 0 && dur != C.TIME_UNSET) onProgress(v.file.fileId, absPos(), dur)
    }
    fun reportServer() {
        val v = request as? PlayRequest.Video ?: return
        val ref = v.ref ?: return
        val dur = absDur()
        if (dur > 0 && dur != C.TIME_UNSET) onServerProgress(ref, absPos(), dur)
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(e: PlaybackException) {
                val http = (e.cause as? androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException)?.responseCode
                error = when (http) {
                    404 -> context.getString(R.string.player_err_missing)
                    null -> "${e.errorCodeName}: ${e.message}"
                    else -> context.getString(R.string.player_err_server, http)
                }
            }
            override fun onMediaMetadataChanged(m: MediaMetadata) { nowPlaying = m }
            override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying; if (!isPlaying) { report(); reportServer() } }
            override fun onVideoSizeChanged(v: VideoSize) {
                if (v.width > 0 && v.height > 0) videoAspect = v.width * v.pixelWidthHeightRatio / v.height
            }
        }
        player.addListener(listener)
        onDispose {
            report()
            reportServer()
            player.removeListener(listener)
            session.release()
            player.release()
        }
    }

    LaunchedEffect(request) {
        // HLS resumes server-side (`?start=`): ffmpeg starts AT the resume point, so the
        // player starts at 0 of that stream. Direct play seeks over HTTP range as before.
        val hlsStartSec = if (request is PlayRequest.Video && request.hls && resumeMs > 0) resumeMs / 1000 else 0L
        val items = buildItems(context, api, request, hlsStartSec)
        val startIndex = (request as? PlayRequest.Music)?.startIndex ?: 0
        val startPos = if (request is PlayRequest.Video && resumeMs > 0 && hlsStartSec == 0L) resumeMs else C.TIME_UNSET
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
    // Server progress every 10 s while playing.
    LaunchedEffect(playing) {
        while (playing) { delay(SERVER_PROGRESS_EVERY_MS); reportServer() }
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
        val (fw, fh) = if (squeeze != 1f) videoBoxFraction(videoAspect, squeeze) else 1f to 1f
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    this.player = player
                    useController = true
                    controllerAutoShow = true
                    controllerShowTimeoutMs = 3000
                    setShowNextButton(request is PlayRequest.Music)
                    setShowPreviousButton(request is PlayRequest.Music)
                    resizeMode = if (squeeze != 1f) AspectRatioFrameLayout.RESIZE_MODE_FILL else AspectRatioFrameLayout.RESIZE_MODE_FIT
                    keepScreenOn = true
                    isFocusable = false // key events handled by the Compose box
                }
            },
            update = { view ->
                view.resizeMode = if (squeeze != 1f) AspectRatioFrameLayout.RESIZE_MODE_FILL else AspectRatioFrameLayout.RESIZE_MODE_FIT
                // Controller is a plain View: undo the panel stretch on it (centred).
                view.findViewById<android.view.View>(androidx.media3.ui.R.id.exo_controller)?.let { c ->
                    c.post { c.pivotX = c.width / 2f; c.scaleX = 1f / squeeze }
                }
            },
            modifier = Modifier.align(Alignment.Center).fillMaxWidth(fw).fillMaxHeight(fh),
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

/** PGS/VobSub/DVB are bitmaps — the server cannot turn them into WebVTT. */
private val BITMAP_SUBS = setOf("hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "dvb_subtitle", "dvbsub", "xsub")

private fun buildItems(context: Context, api: MmoApi, request: PlayRequest, hlsStartSec: Long = 0L): List<MediaItem> = when (request) {
    is PlayRequest.Video -> {
        val f = request.file
        // The server extracts every text track in ONE pass and caches it, so registering
        // all of them costs one read of the file, once. (Was: one ffmpeg per track.)
        val subs = f.subtitleTracks.mapIndexedNotNull { ordinal, t ->
            if (t.codec.lowercase() in BITMAP_SUBS) return@mapIndexedNotNull null
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
        if (request.hls) b.setUri(api.hlsUrl(f.fileId, hlsStartSec)).setMimeType(MimeTypes.APPLICATION_M3U8)
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
