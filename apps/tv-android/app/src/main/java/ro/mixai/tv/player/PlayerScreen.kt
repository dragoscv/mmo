package ro.mixai.tv.player

import android.content.Context
import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import androidx.media3.ui.SubtitleView
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import ro.mixai.tv.BuildConfig
import ro.mixai.tv.R
import ro.mixai.tv.data.DriftAction
import ro.mixai.tv.data.DriftCorrector
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.NowPlaying
import ro.mixai.tv.data.PlayerBus
import ro.mixai.tv.data.PlayerCommand
import ro.mixai.tv.data.Song
import ro.mixai.tv.data.VideoFile
import ro.mixai.tv.data.expectedPosition
import ro.mixai.tv.data.generated.HubMedia
import ro.mixai.tv.ui.LocalSqueeze
import ro.mixai.tv.ui.ScreenFormat
import ro.mixai.tv.ui.components.Choice
import ro.mixai.tv.ui.components.ChoiceDialog
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
import ro.mixai.tv.ui.profiles.ProfilePrefKeys
import ro.mixai.tv.ui.profiles.prefBool
import ro.mixai.tv.ui.profiles.prefString
import kotlin.math.abs

sealed interface PlayRequest {
    /** `fromStart` ignores any saved resume position. `ref` = TMDB identity for server progress (WP12-01); null → local-only. */
    data class Video(val file: VideoFile, val hls: Boolean, val fromStart: Boolean = false, val ref: MediaRef? = null) : PlayRequest
    data class Music(val songs: List<Song>, val startIndex: Int) : PlayRequest
}

private const val SEEK_MS = 10_000L
private const val PROGRESS_EVERY_MS = 5_000L
private const val SERVER_PROGRESS_EVERY_MS = 10_000L
private const val OSD_HIDE_MS = 4_000L
private const val SCRUB_COMMIT_MS = 700L
private const val UP_NEXT_SEC = 10
/** No credits marker → Up Next this long before the end. */
private const val UP_NEXT_FALLBACK_MS = 25_000L
private val SPEEDS = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)
private val SUB_SIZES = listOf("S" to 0.75f, "M" to 1f, "L" to 1.3f, "XL" to 1.65f)

private enum class Panel { None, Audio, Subs, SubStyle, SubSize, SubBg, Speed, Format, Info, Sleep, StillWatching }

private const val SUB_OFF = "off"
private const val SUB_STYLE = "style"

/** Scrub step while D-pad Left/Right is held: 10 s → 30 s → 60 s. */
private fun scrubStep(repeat: Int): Long = when {
    repeat < 8 -> 10_000L
    repeat < 24 -> 30_000L
    else -> 60_000L
}

/**
 * Full-screen player (video + legacy Subsonic music) with a custom Compose OSD (WP16-21).
 * `resumeMs` is the ABSOLUTE start position (0 = from the beginning) resolved by the caller.
 * HLS resumes/seeks far server-side (`?start=` → `hlsOffset`); direct play seeks over HTTP range.
 * Progress: local every 5 s, server every 10 s and on pause/exit. Remote commands arrive through
 * [PlayerBus]; inside a Watch Together room this player follows the room's schedule.
 */
@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(deps: ScreenDeps, nav: Navigator, request: PlayRequest, resumeMs: Long) {
    val context = LocalContext.current
    val api = deps.api
    val hub = deps.hub
    val scope = rememberCoroutineScope()
    val video = request as? PlayRequest.Video
    val selfRoute = remember { nav.current as? Route.Play }

    var error by remember { mutableStateOf<String?>(null) }
    var nowPlaying by remember { mutableStateOf<MediaMetadata?>(null) }
    var playing by remember { mutableStateOf(false) }
    /** User intent (stays true while rebuffering) — drives the OSD auto-hide. */
    var wantPlay by remember { mutableStateOf(false) }
    var buffering by remember { mutableStateOf(false) }
    var ended by remember { mutableStateOf(false) }
    var tracks by remember { mutableStateOf(Tracks.EMPTY) }
    var speed by remember { mutableFloatStateOf(1f) }

    // OSD state
    var osdVisible by remember { mutableStateOf(true) }
    var lastKeyAt by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    var panel by remember { mutableStateOf(Panel.None) }
    var barFocused by remember { mutableStateOf(false) }
    var focusedLabel by remember { mutableStateOf("") }
    var scrubTarget by remember { mutableStateOf<Long?>(null) }
    var scrubJob by remember { mutableStateOf<Job?>(null) }
    var sprite by remember { mutableStateOf<ImageBitmap?>(null) }
    var spriteRequested by remember { mutableStateOf(false) }
    var posMs by remember { mutableLongStateOf(0L) }
    var durMs by remember { mutableLongStateOf(0L) }
    var bufMs by remember { mutableLongStateOf(0L) }

    // Profile preferences (Settings › Playback / Subtitles, stored in Profile.prefs).
    val prof = deps.profiles.activeProfile.value
    val prefAutoplay = prof?.prefBool(ProfilePrefKeys.AUTOPLAY_NEXT, true) ?: true
    val prefSkipIntro = prof?.prefBool(ProfilePrefKeys.SKIP_INTRO, false) ?: false
    val prefAudioLang = prof?.prefString(ProfilePrefKeys.AUDIO_LANG, "").orEmpty()
    val prefSubLang = prof?.prefString(ProfilePrefKeys.SUB_LANG, "").orEmpty()
    val prefForcedOnly = prof?.prefBool(ProfilePrefKeys.SUB_FORCED_ONLY, false) ?: false
    val prefSubSize = when (prof?.prefString(ProfilePrefKeys.SUB_SIZE, "medium")) {
        "small" -> 0.75f; "large" -> 1.3f; "xlarge" -> 1.65f; else -> 1f
    }
    val prefSubBg = prof?.prefString(ProfilePrefKeys.SUB_BG, "box") ?: "box"

    // Tracks / style
    var audioPick by remember { mutableStateOf<Int?>(null) }
    var subPick by remember { mutableStateOf<String?>(null) }
    var subSize by remember { mutableFloatStateOf(prefSubSize) }
    var subBackground by remember { mutableStateOf(prefSubBg == "box") }

    // Markers / episodes / timers
    var markers by remember { mutableStateOf(Markers()) }
    var episodes by remember { mutableStateOf(EpisodeContext()) }
    var upNextDismissed by remember { mutableStateOf(false) }
    var sleepMin by remember { mutableIntStateOf(0) }
    var sleepAt by remember { mutableLongStateOf(0L) }
    val toasts = remember { mutableStateListOf<Bubble>() }
    val bubbles = remember { mutableStateListOf<Bubble>() }

    val rootFocus = remember { FocusRequester() }
    val barFocus = remember { FocusRequester() }
    val skipFocus = remember { FocusRequester() }
    val upNextFocus = remember { FocusRequester() }
    val btnFocus = remember { mutableMapOf<String, FocusRequester>() }
    fun btn(id: String) = btnFocus.getOrPut(id) { FocusRequester() }
    var lastButton by remember { mutableStateOf<String?>(null) }

    val autoplayPref = remember {
        // Legacy key "autoplay" wins only when the new one was never written.
        (prof?.prefs?.get("autoplay") as? JsonPrimitive)?.booleanOrNull?.takeIf { prof.prefs[ProfilePrefKeys.AUTOPLAY_NEXT] == null } ?: prefAutoplay
    }

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
            .build().apply {
                // Preferred languages from the profile (ISO 639-1/2 as stored); Media3 matches normalised tags.
                val b = trackSelectionParameters.buildUpon()
                if (prefAudioLang.isNotBlank()) b.setPreferredAudioLanguage(prefAudioLang)
                if (prefSubLang.isNotBlank() && !prefForcedOnly) b.setPreferredTextLanguage(prefSubLang)
                if (prefForcedOnly) b.setIgnoredTextSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                trackSelectionParameters = b.build()
            }
    }
    // In-activity MediaSession: the remote's transport keys + system now-playing (WP6-04d).
    val session = remember(player) { MediaSession.Builder(context, player).build() }
    // Ultrawide compensation: the global UI squeeze steps aside (SurfaceView ignores layer
    // transforms) and the video surface itself is sized so the film is undistorted on the panel.
    val squeeze = LocalSqueeze.current
    var videoAspect by remember { mutableFloatStateOf(0f) }
    DisposableEffect(Unit) {
        squeezeSuspended.value = true
        onDispose { squeezeSuspended.value = false }
    }

    /** HLS started server-side at this ABSOLUTE position: player time is relative to it. */
    var hlsOffset by remember {
        mutableLongStateOf(if (video != null && video.hls && resumeMs > 0) (resumeMs / 1000) * 1000 else 0L)
    }
    fun durOk(d: Long) = d > 0 && d != C.TIME_UNSET
    fun absPos() = player.currentPosition + hlsOffset
    fun absDur(): Long {
        val src = video?.file?.durationSec
        // HLS playlists grow while ffmpeg runs (EVENT) → the source duration is the truth.
        if (video != null && video.hls && src != null && src > 0) return (src * 1000).toLong()
        val d = player.duration
        if (hlsOffset == 0L) return if (!durOk(d) && src != null && src > 0) (src * 1000).toLong() else d
        return if (src != null && src > 0) (src * 1000).toLong() else if (durOk(d)) d + hlsOffset else d
    }

    fun report() {
        val v = video ?: return
        val dur = absDur()
        if (durOk(dur)) deps.saveLocalProgress(v.file.fileId, absPos(), dur)
    }
    fun reportServer() {
        val v = video ?: return
        val ref = v.ref ?: return
        val dur = absDur()
        if (durOk(dur)) deps.saveServerProgress(ref, absPos(), dur)
    }
    fun exit() { report(); reportServer(); nav.pop() }

    // ─── seeking (keeps the hlsOffset math of WP15) ──────────────────────
    /** HLS audio track (server `?audio=<n>`, server 3.7+): the stream carries one track at a time. */
    var hlsAudio by remember { mutableIntStateOf(0) }
    fun restartHls(targetAbs: Long) {
        val v = video ?: return
        val startSec = (targetAbs / 1000).coerceAtLeast(0)
        hlsOffset = startSec * 1000
        player.setMediaItem(buildVideoItem(context, api, v.file, hls = true, hlsStartSec = startSec, audio = hlsAudio))
        player.prepare()
    }
    fun seekAbsLocal(targetAbs: Long) {
        val dur = absDur()
        val t = if (durOk(dur)) targetAbs.coerceIn(0, (dur - 1_000).coerceAtLeast(0)) else targetAbs.coerceAtLeast(0)
        if (video != null && video.hls) {
            val rel = t - hlsOffset
            val d = player.duration
            val available = maxOf(player.bufferedPosition, if (durOk(d)) d else 0L)
            // Behind the stream start or past what ffmpeg produced → restart server-side at t.
            if (rel < 0 || rel > available) restartHls(t) else player.seekTo(rel)
        } else {
            player.seekTo(t)
        }
        ended = false
    }

    // ─── Watch Together ──────────────────────────────────────────────────
    val room by hub.room.collectAsState()
    val fileId = video?.file?.fileId
    val following = room != null && fileId != null && room?.media?.fileId == fileId
    var loadedRoom by remember { mutableStateOf<String?>(null) }
    var wasFollowing by remember { mutableStateOf(false) }
    val drift = remember { DriftCorrector() }

    fun hubMedia(): HubMedia {
        val dur = absDur().takeIf { durOk(it) }?.let { it / 1000.0 }
        return if (video != null) HubMedia(
            fileId = video.file.fileId, kind = video.ref?.kind, tmdbId = video.ref?.tmdbId,
            season = video.ref?.season, episode = video.ref?.episode, title = video.file.title, durationSec = dur,
        ) else HubMedia(title = nowPlaying?.title?.toString(), kind = "music", durationSec = dur)
    }

    // User/remote intent: inside a room the server schedules; outside, act locally.
    fun userPlay() { if (following) hub.play(absPos() / 1000.0) else { if (ended) seekAbsLocal(0); player.play() } }
    fun userPause() { if (following) hub.pause(absPos() / 1000.0) else player.pause() }
    fun userToggle() { if (player.isPlaying) userPause() else userPlay() }
    fun userSeek(targetAbs: Long) { if (following) hub.seek(targetAbs.coerceAtLeast(0) / 1000.0) else seekAbsLocal(targetAbs) }

    fun showOsd() { osdVisible = true; lastKeyAt = SystemClock.elapsedRealtime() }
    fun hideOsd() { osdVisible = false; runCatching { rootFocus.requestFocus() } }
    fun toast(text: String) {
        val b = Bubble(System.nanoTime(), text, 0)
        toasts.add(b)
        scope.launch { delay(5_000); toasts.remove(b) }
    }

    // ─── tracks ──────────────────────────────────────────────────────────
    fun textGroups(t: Tracks) = t.groups.filter { it.type == C.TRACK_TYPE_TEXT && it.length > 0 }
    fun audioGroups(t: Tracks) = t.groups.filter { it.type == C.TRACK_TYPE_AUDIO && it.length > 0 }
    fun textKey(i: Int, f: Format) = "$i|${f.language}|${f.label}"

    fun applyTracks(t: Tracks) {
        var params = player.trackSelectionParameters
        var changed = false
        audioPick?.let { want ->
            val groups = audioGroups(t)
            val fileTracks = video?.file?.audioTracks.orEmpty()
            val lang = fileTracks.getOrNull(want)?.lang
            val g = groups.getOrNull(want)?.takeIf { groups.size == fileTracks.size || fileTracks.isEmpty() }
                ?: groups.firstOrNull { lang != null && it.getTrackFormat(0).language == lang }
            if (g != null && !g.isSelected) {
                params = params.buildUpon().setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, 0)).build(); changed = true
            }
        }
        when (val sp = subPick) {
            null -> Unit
            SUB_OFF -> if (!params.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) {
                params = params.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build(); changed = true
            }
            else -> {
                val g = textGroups(t).withIndex().firstOrNull { (i, g) -> textKey(i, g.getTrackFormat(0)) == sp }?.value
                if (g != null && (!g.isSelected || params.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))) {
                    params = params.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                        .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, 0)).build(); changed = true
                }
            }
        }
        if (changed) player.trackSelectionParameters = params
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
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) { wantPlay = playWhenReady }
            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
                ended = state == Player.STATE_ENDED
            }
            override fun onTracksChanged(t: Tracks) { tracks = t; applyTracks(t) }
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
        val hlsStartSec = hlsOffset / 1000
        // Profile's preferred audio language picks the HLS track up front (the stream carries one).
        if (video != null && video.hls && prefAudioLang.isNotBlank()) {
            val want = prefAudioLang.lowercase()
            val idx = video.file.audioTracks.indexOfFirst { t -> t.lang?.lowercase()?.let { it == want || it.startsWith(want) || want.startsWith(it) } == true }
            if (idx > 0) hlsAudio = idx
        }
        val items = if (video != null) listOf(buildVideoItem(context, api, video.file, video.hls, hlsStartSec, hlsAudio))
            else buildItems(context, api, request, hlsStartSec)
        val startIndex = (request as? PlayRequest.Music)?.startIndex ?: 0
        val startPos = if (video != null && resumeMs > 0 && hlsStartSec == 0L) resumeMs else C.TIME_UNSET
        player.setMediaItems(items, startIndex, startPos)
        player.prepare()
        // "Are you still watching?" after 3 autoplayed episodes without a key press.
        val auto = PlaybackSession.pendingAuto
        PlaybackSession.pendingAuto = false
        if (!auto) PlaybackSession.autoplayStreak = 0
        if (auto && PlaybackSession.autoplayStreak >= STILL_WATCHING_AFTER) {
            player.playWhenReady = false
            panel = Panel.StillWatching
        } else {
            player.playWhenReady = true
        }
        delay(50)
        runCatching { if (panel == Panel.None) rootFocus.requestFocus() }
    }

    // Skip markers + episode context (all tolerant of 404/empty).
    LaunchedEffect(fileId) {
        val id = fileId ?: return@LaunchedEffect
        launch { val s = fetchSpan(api, "/video/intro/$id"); markers = markers.copy(intro = s) }
        launch { val s = fetchSpan(api, "/video/recap/$id"); markers = markers.copy(recap = s) }
        launch { val c = fetchCreditsMs(api, id); markers = markers.copy(creditsMs = c) }
        launch { val ch = fetchChapters(api, id); markers = markers.copy(chapters = ch) }
        val ref = video.ref
        if (ref != null && ref.kind == "tv") launch { episodes = resolveEpisodes(deps, ref) }
    }

    // Poll positions for the OSD / markers.
    LaunchedEffect(player) {
        while (true) {
            posMs = absPos().coerceAtLeast(0)
            durMs = absDur().takeIf { durOk(it) } ?: 0L
            bufMs = player.bufferedPosition + hlsOffset
            delay(250)
        }
    }
    // OSD auto-hide (4 s) while playing and no panel / scrub.
    LaunchedEffect(osdVisible, lastKeyAt, wantPlay, panel, scrubTarget) {
        if (!osdVisible || !wantPlay || panel != Panel.None || scrubTarget != null) return@LaunchedEffect
        delay(OSD_HIDE_MS)
        hideOsd()
    }
    // Focus the bar when the OSD appears.
    LaunchedEffect(osdVisible) {
        if (osdVisible) { delay(60); runCatching { if (panel == Panel.None) barFocus.requestFocus() } }
    }

    LaunchedEffect(playing) { while (playing) { delay(PROGRESS_EVERY_MS); report() } }
    LaunchedEffect(playing) { while (playing) { delay(SERVER_PROGRESS_EVERY_MS); reportServer() } }

    // Remote control (hub / MainActivity) → this player; room-aware.
    LaunchedEffect(player) {
        PlayerBus.commands.collect { cmd ->
            when (cmd) {
                PlayerCommand.Pause -> userPause()
                PlayerCommand.Resume -> userPlay()
                PlayerCommand.Toggle -> userToggle()
                is PlayerCommand.Seek -> userSeek((cmd.positionSec * 1000).toLong())
                is PlayerCommand.SeekBy -> userSeek(absPos() + (cmd.deltaSec * 1000).toLong())
                PlayerCommand.Stop -> { player.stop(); exit() }
                PlayerCommand.Next -> if (player.hasNextMediaItem()) player.seekToNextMediaItem()
                PlayerCommand.Previous -> player.seekToPreviousMediaItem()
                is PlayerCommand.Rate -> { speed = cmd.rate.toFloat(); player.setPlaybackSpeed(speed) }
            }
        }
    }
    // Now-playing for the hub: every second.
    LaunchedEffect(player) {
        while (true) {
            val dur = absDur().takeIf { durOk(it) }?.let { it / 1000.0 }
            PlayerBus.update(NowPlaying(player.isPlaying, absPos().coerceAtLeast(0) / 1000.0, dur, hubMedia()))
            delay(1_000)
        }
    }
    DisposableEffect(Unit) { onDispose { PlayerBus.clear() } }

    // Room: load this title once when it is played while in a room.
    LaunchedEffect(room?.roomId, fileId) {
        val r = room ?: return@LaunchedEffect
        if (fileId == null || loadedRoom == r.roomId) return@LaunchedEffect
        loadedRoom = r.roomId
        if (r.media?.fileId != fileId) hub.load(hubMedia(), absPos().coerceAtLeast(0) / 1000.0)
    }
    // Room switched to another file while we were following → open it here too.
    LaunchedEffect(room?.media?.fileId) {
        val other = room?.media?.fileId
        if (following) { wasFollowing = true; return@LaunchedEffect }
        if (!wasFollowing || other == null || other == fileId) return@LaunchedEffect
        val f = runCatching { api.fileInfo(other) }.getOrNull() ?: return@LaunchedEffect
        val m = room?.media
        val kind = m?.kind
        val tmdb = m?.tmdbId
        val ref = if (kind != null && tmdb != null) MediaRef(kind, tmdb, m.season, m.episode) else null
        nav.replace(Route.Play(PlayRequest.Video(f, hls = !f.directPlayable, ref = ref), resumeMs = 0L, from = selfRoute?.from))
    }
    // Room schedule: play/pause/seek at anchor.atServerMs.
    LaunchedEffect(following, room?.anchor, room?.phase) {
        val r = room
        if (!following || r == null) return@LaunchedEffect
        val a = r.anchor
        drift.reset()
        player.setPlaybackSpeed(speed)
        val now = hub.serverNowMs()
        if (a.playing) {
            val wait = a.atServerMs - now
            if (wait > 0) {
                if (abs(a.positionSec * 1000 - absPos()) > 500) seekAbsLocal((a.positionSec * 1000).toLong())
                player.pause()
                delay(wait.toLong())
                player.play()
            } else {
                val exp = expectedPosition(a, now)
                if (abs(exp * 1000 - absPos()) > 1_500) seekAbsLocal((exp * 1000).toLong())
                player.play()
            }
        } else {
            player.pause()
            if (abs(a.positionSec * 1000 - absPos()) > 500) seekAbsLocal((a.positionSec * 1000).toLong())
        }
    }
    // Room: ready / not ready while buffering.
    LaunchedEffect(following, buffering) {
        if (following) hub.ready(!buffering, absPos().coerceAtLeast(0) / 1000.0)
    }
    // Room: 1 Hz drift correction + report.
    LaunchedEffect(following) {
        while (following) {
            delay(1_000)
            val r = hub.room.value ?: continue
            val actual = absPos() / 1000.0
            hub.report(actual)
            if (r.phase != "playing" || !player.isPlaying) continue
            val expected = hub.roomExpectedPosition() ?: continue
            when (val act = drift.update(actual, expected)) {
                is DriftAction.Rate -> player.setPlaybackSpeed((speed * act.rate).toFloat())
                is DriftAction.Seek -> { seekAbsLocal((act.positionSec * 1000).toLong()); drift.reset() }
                DriftAction.None -> if (player.playbackParameters.speed != speed) player.setPlaybackSpeed(speed)
            }
        }
    }
    // Reactions + chat toasts.
    LaunchedEffect(hub) {
        launch {
            var lane = 0
            hub.reactions.collect { r ->
                val b = Bubble(System.nanoTime(), r.emoji, lane)
                lane = (lane + 1) % 5
                bubbles.add(b)
                launch { delay(3_000); bubbles.remove(b) }
            }
        }
        launch { hub.chat.collect { c -> toast(context.getString(R.string.player_chat_line, c.fromName, c.text)) } }
    }

    // Sleep timer.
    LaunchedEffect(sleepAt) {
        if (sleepAt <= 0L) return@LaunchedEffect
        delay((sleepAt - SystemClock.elapsedRealtime()).coerceAtLeast(0))
        player.pause()
        exit()
    }

    // ─── derived ─────────────────────────────────────────────────────────
    val isEpisode = video?.ref?.kind == "tv"
    val next = episodes.next?.takeIf { it.fileId != null }
    // derivedStateOf: the body only recomposes when these flip, not on every 250 ms position tick.
    val atCredits by remember {
        derivedStateOf { durMs > 0 && (markers.creditsMs?.let { posMs >= it } ?: (durMs - posMs <= UP_NEXT_FALLBACK_MS)) }
    }
    val recap = markers.recap
    val skipSpan by remember {
        derivedStateOf {
            val r = markers.recap
            val i = markers.intro
            when {
                scrubTarget != null -> null
                r != null && posMs in r -> r
                i != null && posMs in i -> i
                else -> null
            }
        }
    }
    val skipNow = skipSpan
    // Settings › Playback › "Skip intros automatically": jump once per span (never while following a room).
    var autoSkipped by remember { mutableStateOf<Span?>(null) }
    LaunchedEffect(skipNow, prefSkipIntro, following) {
        val s = skipNow ?: return@LaunchedEffect
        if (prefSkipIntro && !following && autoSkipped != s) {
            autoSkipped = s
            seekAbsLocal(s.endMs)
        }
    }
    val skipLabel = when {
        skipNow == null -> null
        skipNow == recap -> stringResource(R.string.player_skip_recap)
        else -> stringResource(R.string.player_skip_intro)
    }
    val endOfEpisodeSleep = sleepMin < 0
    val autoplay = autoplayPref && !following && !endOfEpisodeSleep
    val showUpNext = video != null && isEpisode && next != null && !upNextDismissed && (atCredits || ended)
    val showMoreLikeThis = video != null && !isEpisode && video.ref != null && !upNextDismissed && atCredits && !ended

    fun playNext(auto: Boolean) {
        val n = next ?: return
        val nid = n.fileId ?: return
        val ref = video?.ref ?: return
        scope.launch {
            val f = runCatching { api.fileInfo(nid) }.getOrNull()
            if (f == null) { toast(context.getString(R.string.player_next_failed)); return@launch }
            report(); reportServer()
            PlaybackSession.pendingAuto = auto
            PlaybackSession.autoplayStreak = if (auto) PlaybackSession.autoplayStreak + 1 else 0
            nav.replace(
                Route.Play(
                    PlayRequest.Video(f, hls = !f.directPlayable, ref = MediaRef("tv", ref.tmdbId, n.season, n.episode)),
                    resumeMs = -1L, from = selfRoute?.from,
                ),
            )
        }
    }

    // End of media: next episode (autoplay) or back to the previous screen.
    LaunchedEffect(ended) {
        if (!ended || video == null) return@LaunchedEffect
        when {
            endOfEpisodeSleep -> exit()
            next != null && autoplay && !upNextDismissed -> playNext(auto = true)
            next != null && !upNextDismissed -> Unit // card stays, no countdown
            following -> Unit
            else -> exit()
        }
    }
    // Skip pill grabs focus while the OSD is hidden.
    LaunchedEffect(skipNow != null, osdVisible) {
        if (skipNow != null && !osdVisible) { delay(60); runCatching { skipFocus.requestFocus() } }
    }
    LaunchedEffect(showUpNext, showMoreLikeThis) {
        if (showUpNext || showMoreLikeThis) { osdVisible = false; delay(80); runCatching { upNextFocus.requestFocus() } }
    }

    // ─── keys ────────────────────────────────────────────────────────────
    fun ensureSprite() {
        val id = fileId ?: return
        if (spriteRequested) return
        spriteRequested = true
        scope.launch {
            repeat(12) { // 503 while the server builds it
                sprite = loadSprite(context, api.spriteUrl(id))
                if (sprite != null) return@launch
                delay(10_000)
            }
        }
    }
    fun scrubKey(ev: KeyEvent, forward: Boolean): Boolean {
        if (ev.type == KeyEventType.KeyDown) {
            scrubJob?.cancel()
            ensureSprite()
            val step = scrubStep(ev.nativeKeyEvent.repeatCount)
            val base = scrubTarget ?: absPos()
            val max = if (durMs > 0) durMs else Long.MAX_VALUE
            scrubTarget = (base + if (forward) step else -step).coerceIn(0, max)
            showOsd()
        } else if (ev.type == KeyEventType.KeyUp) {
            scrubJob = scope.launch {
                delay(SCRUB_COMMIT_MS)
                scrubTarget?.let { userSeek(it) }
                scrubTarget = null
            }
        }
        return true
    }
    fun commitScrub() {
        scrubJob?.cancel()
        scrubTarget?.let { userSeek(it) }
        scrubTarget = null
    }

    /** Close the open side panel and give focus back to the button that opened it. */
    fun backPanel() {
        panel = Panel.None
        scope.launch { delay(120); runCatching { (lastButton?.let { btn(it) } ?: barFocus).requestFocus() } }
    }

    BackHandler(enabled = panel == Panel.None && !showUpNext && !showMoreLikeThis) {
        when {
            scrubTarget != null -> { scrubJob?.cancel(); scrubTarget = null }
            osdVisible -> hideOsd()
            else -> exit()
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .onPreviewKeyEvent { ev ->
                val down = ev.type == KeyEventType.KeyDown
                if (down) {
                    lastKeyAt = SystemClock.elapsedRealtime()
                    PlaybackSession.autoplayStreak = 0
                }
                // Transport keys work everywhere.
                when (ev.key) {
                    Key.MediaPlayPause -> { if (down) userToggle(); return@onPreviewKeyEvent true }
                    Key.MediaPlay -> { if (down) userPlay(); return@onPreviewKeyEvent true }
                    Key.MediaPause -> { if (down) userPause(); return@onPreviewKeyEvent true }
                    Key.MediaFastForward -> { if (down) userSeek(absPos() + SEEK_MS); return@onPreviewKeyEvent true }
                    Key.MediaRewind -> { if (down) userSeek(absPos() - SEEK_MS); return@onPreviewKeyEvent true }
                    Key.MediaNext -> {
                        if (down) { if (next != null) playNext(false) else if (player.hasNextMediaItem()) player.seekToNextMediaItem() }
                        return@onPreviewKeyEvent true
                    }
                    Key.MediaPrevious -> { if (down) player.seekToPreviousMediaItem(); return@onPreviewKeyEvent true }
                    Key.MediaStop -> { if (down) { player.stop(); exit() }; return@onPreviewKeyEvent true }
                }
                if (ev.key == Key.Back || ev.key == Key.Escape) {
                    // Handled here (on key-up) so it works even when a focused child would swallow it.
                    if (down) return@onPreviewKeyEvent true
                    when {
                        panel == Panel.SubSize || panel == Panel.SubBg -> panel = Panel.SubStyle
                        panel == Panel.SubStyle -> panel = Panel.Subs
                        panel == Panel.StillWatching -> exit()
                        panel != Panel.None -> backPanel()
                        showUpNext || showMoreLikeThis -> { upNextDismissed = true; if (ended) exit() else runCatching { rootFocus.requestFocus() } }
                        scrubTarget != null -> { scrubJob?.cancel(); scrubTarget = null }
                        osdVisible -> hideOsd()
                        else -> exit()
                    }
                    return@onPreviewKeyEvent true
                }
                if (panel != Panel.None || showUpNext || showMoreLikeThis) return@onPreviewKeyEvent false
                val hidden = !osdVisible
                val skip = skipSpan
                when (ev.key) {
                    Key.DirectionLeft, Key.DirectionRight ->
                        if (hidden || barFocused) scrubKey(ev, ev.key == Key.DirectionRight) else { if (down) showOsd(); false }
                    Key.DirectionCenter, Key.Enter, Key.NumPadEnter, Key.Spacebar -> when {
                        !down -> hidden || barFocused
                        hidden && skip != null -> { userSeek(skip.endMs); true }
                        hidden -> { userToggle(); showOsd(); true }
                        barFocused -> { if (scrubTarget != null) commitScrub() else userToggle(); showOsd(); true }
                        else -> { showOsd(); false }
                    }
                    else -> if (down) { val wasHidden = hidden; showOsd(); wasHidden } else hidden
                }
            }
            .focusRequester(rootFocus)
            .focusable(),
    ) {
        val (fw, fh) = if (squeeze != 1f) videoBoxFraction(videoAspect, squeeze) else 1f to 1f
        val fg = Tokens.foreground.toArgb()
        val subBg = if (subBackground) Tokens.background.copy(alpha = 0.6f).toArgb() else Color.Transparent.toArgb()
        val edge = Tokens.background.toArgb()
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    this.player = player
                    useController = false
                    resizeMode = if (squeeze != 1f) AspectRatioFrameLayout.RESIZE_MODE_FILL else AspectRatioFrameLayout.RESIZE_MODE_FIT
                    keepScreenOn = true
                    isFocusable = false // key events handled by Compose
                }
            },
            update = { view ->
                view.resizeMode = if (squeeze != 1f) AspectRatioFrameLayout.RESIZE_MODE_FILL else AspectRatioFrameLayout.RESIZE_MODE_FIT
                view.subtitleView?.let { sv ->
                    sv.setStyle(
                        CaptionStyleCompat(
                            fg, subBg, Color.Transparent.toArgb(),
                            if (subBackground) CaptionStyleCompat.EDGE_TYPE_NONE else CaptionStyleCompat.EDGE_TYPE_OUTLINE, edge, null,
                        ),
                    )
                    sv.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * subSize)
                    // Subtitles are a plain View: undo the panel stretch on them (centred).
                    sv.post { sv.pivotX = sv.width / 2f; sv.scaleX = 1f / squeeze }
                }
            },
            modifier = Modifier.align(Alignment.Center).fillMaxWidth(fw).fillMaxHeight(fh),
        )

        // Everything drawn over the video re-applies the ultrawide squeeze itself.
        Box(Modifier.fillMaxSize().squeezed(squeeze)) {
            if (request is PlayRequest.Music) {
                Column(Modifier.align(Alignment.TopStart).padding(48.dp)) {
                    val art = nowPlaying?.artworkUri?.toString()
                    if (art != null) AsyncImage(model = art, contentDescription = null, modifier = Modifier.size(240.dp))
                    Text(nowPlaying?.title?.toString() ?: "", style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
                    Text(nowPlaying?.artist?.toString() ?: "", style = MaterialTheme.typography.titleMedium, color = Tokens.mutedForeground)
                }
            }

            OsdScrims(osdVisible)

            AnimatedVisibility(osdVisible, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize()) {
                    // Top: title + episode line + room chip.
                    Column(Modifier.align(Alignment.TopStart).padding(horizontal = 56.dp, vertical = 36.dp)) {
                        val title = video?.file?.title ?: nowPlaying?.title?.toString().orEmpty()
                        Text(title, style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val ref = video?.ref
                        val s = ref?.season
                        val e = ref?.episode
                        if (isEpisode && s != null && e != null) {
                            val name = episodes.current?.name?.takeIf { it.isNotBlank() }
                            Text(
                                stringResource(R.string.player_episode_line, s, e) + (name?.let { " $it" } ?: ""),
                                style = MaterialTheme.typography.titleMedium, color = Tokens.mutedForeground,
                            )
                        }
                        if (following) {
                            Text(
                                stringResource(R.string.player_room_chip, room?.members?.size ?: 1),
                                style = MaterialTheme.typography.labelLarge, color = Tokens.primary,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                        }
                    }
                    if (buffering) {
                        Text(
                            stringResource(R.string.player_buffering), style = MaterialTheme.typography.labelLarge, color = Tokens.mutedForeground,
                            modifier = Modifier.align(Alignment.TopEnd).padding(36.dp),
                        )
                    }

                    // Bottom: preview, bar, times, buttons, on one frosted glass strip (D25 "glass OSD",
                    // critic P2-12) centred at ≤ 1400 dp.
                    Column(Modifier.align(Alignment.BottomCenter).widthIn(max = 1400.dp).fillMaxWidth().padding(horizontal = 56.dp, vertical = 32.dp)) {
                        val target = scrubTarget
                        if (target != null && durMs > 0) {
                            val chapter = markers.chapters.lastOrNull { it.startMs <= target }?.title
                            ScrubPreview(sprite, spriteGrid(durMs / 1000.0), target, target.toFloat() / durMs, chapter)
                            Spacer(Modifier.height(8.dp))
                        }
                        Column(Modifier.fillMaxWidth().glass().padding(horizontal = 24.dp, vertical = 16.dp)) {
                        ScrubBar(
                            posMs = posMs, durMs = durMs, bufMs = bufMs, targetMs = scrubTarget, markers = markers,
                            focusRequester = barFocus, onKey = { false },
                            modifier = Modifier
                                .focusProperties { down = btn(lastButton ?: "play") }
                                .onFocusChanged { barFocused = it.isFocused; if (it.isFocused) focusedLabel = "" },
                        )
                        Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(formatTime(scrubTarget ?: posMs), style = MaterialTheme.typography.titleSmall, color = Tokens.foreground)
                            Spacer(Modifier.weight(1f))
                            if (durMs > 0) {
                                val remain = (durMs - (scrubTarget ?: posMs)).coerceAtLeast(0)
                                val endsAt = System.currentTimeMillis() + (remain / speed.coerceAtLeast(0.1f)).toLong()
                                val clock = android.text.format.DateFormat.getTimeFormat(context).format(java.util.Date(endsAt))
                                Text(stringResource(R.string.player_ends_at, clock), style = MaterialTheme.typography.titleSmall, color = Tokens.mutedForeground)
                                Spacer(Modifier.size(24.dp))
                                Text("-" + formatTime(remain), style = MaterialTheme.typography.titleSmall, color = Tokens.foreground)
                            }
                        }
                        Spacer(Modifier.height(16.dp))
                        Row(
                            Modifier.focusGroup(),
                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            fun open(id: String, p: Panel) { lastButton = id; panel = p }
                            val playLabel = stringResource(if (playing) R.string.player_pause else R.string.player_play)
                            OsdButton(if (playing) MixaiIcons.Pause else Icons.Filled.PlayArrow, playLabel, { userToggle() }, btn("play"), { focusedLabel = playLabel })
                            val back10 = stringResource(R.string.player_back10)
                            OsdButton(MixaiIcons.Replay10, back10, { userSeek(absPos() - SEEK_MS) }, btn("back"), { focusedLabel = back10 })
                            val fwd10 = stringResource(R.string.player_fwd10)
                            OsdButton(MixaiIcons.Forward10, fwd10, { userSeek(absPos() + SEEK_MS) }, btn("fwd"), { focusedLabel = fwd10 })
                            if (video != null) {
                                val lAudio = stringResource(R.string.player_audio)
                                OsdButton(MixaiIcons.Audiotrack, lAudio, { open("audio", Panel.Audio) }, btn("audio"), { focusedLabel = lAudio })
                                val lSubs = stringResource(R.string.player_subtitles)
                                OsdButton(MixaiIcons.Subtitles, lSubs, { open("subs", Panel.Subs) }, btn("subs"), { focusedLabel = lSubs })
                                val lSpeed = stringResource(R.string.player_speed)
                                OsdButton(MixaiIcons.Speed, lSpeed, { open("speed", Panel.Speed) }, btn("speed"), { focusedLabel = lSpeed }, selected = speed != 1f)
                                val lFormat = stringResource(R.string.player_screen_format)
                                OsdButton(MixaiIcons.AspectRatio, lFormat, { open("format", Panel.Format) }, btn("format"), { focusedLabel = lFormat })
                                val lSleep = stringResource(R.string.player_sleep)
                                OsdButton(PlayerIcons.Bedtime, lSleep, { open("sleep", Panel.Sleep) }, btn("sleep"), { focusedLabel = lSleep }, selected = sleepMin != 0)
                                val lInfo = stringResource(R.string.player_info)
                                OsdButton(Icons.Filled.Info, lInfo, { open("info", Panel.Info) }, btn("info"), { focusedLabel = lInfo })
                                if (next != null) {
                                    val lNext = stringResource(R.string.player_next_episode)
                                    OsdButton(MixaiIcons.SkipNext, lNext, { playNext(false) }, btn("next"), { focusedLabel = lNext })
                                }
                                val lTogether = stringResource(R.string.player_watch_together)
                                OsdButton(MixaiIcons.Group, lTogether, {
                                    // Re-enter at the current position when coming back from the room screen.
                                    selfRoute?.let { nav.replace(it.copy(resumeMs = absPos().coerceAtLeast(0))) }
                                    nav.push(Route.WatchTogether(room?.roomId))
                                }, btn("together"), { focusedLabel = lTogether }, selected = following)
                            }
                            Spacer(Modifier.size(12.dp))
                            Text(focusedLabel, style = MaterialTheme.typography.titleSmall, color = Tokens.foreground)
                        }
                        }
                    }
                }
            }

            // Skip intro / recap pill.
            if (skipNow != null && skipLabel != null && !showUpNext) {
                SkipPill(
                    skipLabel, { userSeek(skipNow.endMs) }, skipFocus,
                    Modifier.align(Alignment.BottomEnd).padding(end = 56.dp, bottom = if (osdVisible) 230.dp else 72.dp),
                )
            }

            // Up Next / More like this.
            if (showUpNext) {
                UpNextCard(
                    title = stringResource(R.string.player_up_next),
                    subtitle = stringResource(R.string.player_episode_line, next.season, next.episode) + " " + next.name,
                    stillUrl = next.stillUrl,
                    countdownSec = if (autoplay) UP_NEXT_SEC else 0,
                    onPlay = { playNext(auto = autoplay && SystemClock.elapsedRealtime() - lastKeyAt > UP_NEXT_SEC * 1000L - 500) },
                    onCancel = { upNextDismissed = true; if (ended) exit() else runCatching { rootFocus.requestFocus() } },
                    playFocus = upNextFocus,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(56.dp),
                )
            }
            if (showMoreLikeThis) {
                MoreLikeThisCard(
                    onBackToTitle = { report(); reportServer(); if (!nav.popTo { it is Route.Title }) nav.pop() },
                    onDismiss = { upNextDismissed = true; runCatching { rootFocus.requestFocus() } },
                    focus = upNextFocus,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(56.dp),
                )
            }

            ReactionsLayer(bubbles)
            ToastLayer(toasts, Modifier.align(Alignment.TopEnd).padding(top = 96.dp, end = 36.dp))

            // ─── panels ──────────────────────────────────────────────────
            fun closePanel() = backPanel()
            if (video != null) {
                val f = video.file
                val aGroups = audioGroups(tracks)
                val selAudio = aGroups.indexOfFirst { it.isSelected }.takeIf { it >= 0 }
                val directOnly = stringResource(R.string.player_audio_direct_only)
                // HLS carries one audio stream: another track restarts the stream with `?audio=<n>` at the
                // current position (server 3.7+). Direct play switches in place.
                fun audioAvailable(@Suppress("UNUSED_PARAMETER") i: Int) = true
                val isHls = video?.hls == true
                val audioOpts = if (f.audioTracks.isNotEmpty()) f.audioTracks.mapIndexed { i, t ->
                    Choice(i, audioLabel(t.lang, t.codec, t.channels, t.title), if (audioAvailable(i)) null else directOnly)
                } else aGroups.mapIndexed { i, g ->
                    val fm = g.getTrackFormat(0)
                    Choice(i, audioLabel(fm.language, fm.sampleMimeType?.substringAfter('/') ?: "", fm.channelCount, fm.label), null)
                }
                PanelDialog(
                    title = stringResource(R.string.player_audio), options = audioOpts,
                    selected = if (isHls) hlsAudio else (audioPick ?: selAudio ?: 0),
                    onPick = { i ->
                        if (isHls && f.audioTracks.size > 1) {
                            if (i != hlsAudio) { hlsAudio = i; restartHls(absPos()) }
                        } else { audioPick = i; applyTracks(player.currentTracks) }
                        closePanel()
                    },
                    onDismiss = { closePanel() }, visible = panel == Panel.Audio,
                )

                val tGroups = textGroups(tracks)
                val textDisabled = player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)
                val selText = if (textDisabled) SUB_OFF
                else tGroups.withIndex().firstOrNull { it.value.isSelected }?.let { (i, g) -> textKey(i, g.getTrackFormat(0)) } ?: SUB_OFF
                val forcedLabel = stringResource(R.string.player_subs_forced)
                val subOpts = buildList {
                    add(Choice(SUB_OFF, stringResource(R.string.player_subs_off)))
                    tGroups.withIndex()
                        .sortedByDescending { (_, g) -> g.getTrackFormat(0).selectionFlags and C.SELECTION_FLAG_FORCED != 0 }
                        .forEach { (i, g) ->
                            val fm = g.getTrackFormat(0)
                            val forced = fm.selectionFlags and C.SELECTION_FLAG_FORCED != 0
                            add(
                                Choice(
                                    textKey(i, fm),
                                    fm.label ?: fm.language ?: context.getString(R.string.subtitle_n, i + 1),
                                    listOfNotNull(fm.language, if (forced) forcedLabel else null).joinToString(" · ").ifBlank { null },
                                ),
                            )
                        }
                    add(Choice(SUB_STYLE, stringResource(R.string.player_subs_style), stringResource(R.string.player_subs_style_hint)))
                }
                PanelDialog(
                    title = stringResource(R.string.player_subtitles), options = subOpts, selected = subPick ?: selText,
                    onPick = { k ->
                        if (k == SUB_STYLE) panel = Panel.SubStyle
                        else { subPick = k; applyTracks(player.currentTracks); closePanel() }
                    },
                    onDismiss = { closePanel() }, visible = panel == Panel.Subs,
                )
                val sizeLabel = SUB_SIZES.firstOrNull { it.second == subSize }?.first ?: "M"
                PanelDialog(
                    title = stringResource(R.string.player_subs_style),
                    options = listOf(
                        Choice("size", stringResource(R.string.player_subs_size), sizeLabel),
                        Choice("bg", stringResource(R.string.player_subs_background), stringResource(if (subBackground) R.string.player_on else R.string.player_off)),
                    ),
                    selected = null,
                    onPick = { k -> panel = if (k == "size") Panel.SubSize else Panel.SubBg },
                    onDismiss = { panel = Panel.Subs }, visible = panel == Panel.SubStyle,
                )
                PanelDialog(
                    title = stringResource(R.string.player_subs_size), options = SUB_SIZES.map { Choice(it.second, it.first) }, selected = subSize,
                    onPick = { subSize = it; panel = Panel.SubStyle }, onDismiss = { panel = Panel.SubStyle }, visible = panel == Panel.SubSize,
                )
                PanelDialog(
                    title = stringResource(R.string.player_subs_background),
                    options = listOf(Choice(true, stringResource(R.string.player_on)), Choice(false, stringResource(R.string.player_off))),
                    selected = subBackground,
                    onPick = { subBackground = it; panel = Panel.SubStyle }, onDismiss = { panel = Panel.SubStyle }, visible = panel == Panel.SubBg,
                )
                val normal = stringResource(R.string.player_speed_normal)
                PanelDialog(
                    title = stringResource(R.string.player_speed),
                    options = SPEEDS.map { Choice(it, if (it == 1f) normal else "${it}×") },
                    selected = speed,
                    onPick = { s -> speed = s; player.setPlaybackSpeed(s); closePanel() },
                    onDismiss = { closePanel() }, visible = panel == Panel.Speed,
                )
                val fmt by deps.settings.screenFormat.collectAsState(initial = "auto")
                val autoLabel = stringResource(R.string.player_format_auto)
                PanelDialog(
                    title = stringResource(R.string.player_screen_format),
                    options = ScreenFormat.entries.map { Choice(it.key, if (it == ScreenFormat.Auto) autoLabel else it.key) },
                    selected = fmt,
                    onPick = { k -> deps.scope.launch { deps.settings.setScreenFormat(k) }; closePanel() },
                    onDismiss = { closePanel() }, visible = panel == Panel.Format,
                )
                PanelDialog(
                    title = stringResource(R.string.player_sleep),
                    options = listOf(
                        Choice(0, stringResource(R.string.player_off)),
                        Choice(15, stringResource(R.string.player_sleep_min, 15)),
                        Choice(30, stringResource(R.string.player_sleep_min, 30)),
                        Choice(60, stringResource(R.string.player_sleep_min, 60)),
                        Choice(-1, stringResource(R.string.player_sleep_end)),
                    ),
                    selected = sleepMin,
                    onPick = { m ->
                        sleepMin = m
                        sleepAt = if (m > 0) SystemClock.elapsedRealtime() + m * 60_000L else 0L
                        if (m != 0) toast(if (m > 0) context.getString(R.string.player_sleep_set, m) else context.getString(R.string.player_sleep_end))
                        closePanel()
                    },
                    onDismiss = { closePanel() }, visible = panel == Panel.Sleep,
                )
                if (panel == Panel.Info) {
                    val vf = player.videoFormat
                    val af = player.audioFormat
                    val unknown = stringResource(R.string.player_unknown)
                    InfoPanel(
                        title = stringResource(R.string.player_info),
                        rows = listOf(
                            stringResource(R.string.player_info_mode) to stringResource(if (video.hls) R.string.player_mode_hls else R.string.player_mode_direct),
                            stringResource(R.string.player_info_video) to listOfNotNull(
                                f.videoCodec ?: vf?.sampleMimeType?.substringAfter('/'),
                                (vf?.width ?: f.width)?.let { w -> "$w×${vf?.height ?: f.height}" },
                            ).joinToString(" · ").ifBlank { unknown },
                            stringResource(R.string.player_info_hdr) to (f.hdr ?: "SDR"),
                            stringResource(R.string.player_info_audio) to (
                                af?.let { audioLabel(it.language, it.sampleMimeType?.substringAfter('/') ?: "", it.channelCount, null) } ?: f.audioCodec ?: unknown
                                ),
                            stringResource(R.string.player_info_bitrate) to (f.bitrateKbps?.let { context.getString(R.string.player_kbps, it) } ?: unknown),
                            stringResource(R.string.player_info_container) to (f.container ?: unknown),
                            stringResource(R.string.player_info_server) to api.baseUrl,
                        ),
                        onDismiss = { closePanel() },
                    )
                }
            }
            if (panel == Panel.StillWatching) {
                StillWatchingPanel(
                    onContinue = { PlaybackSession.autoplayStreak = 0; panel = Panel.None; userPlay(); showOsd() },
                    onExit = { exit() },
                    modifier = Modifier.align(Alignment.Center),
                )
            }

            error?.let {
                ErrorState(
                    message = it, onRetry = null, title = stringResource(R.string.player_error),
                    modifier = Modifier.align(Alignment.Center).background(Tokens.card).padding(16.dp),
                )
            }
        }
    }
}

@Composable
private fun StillWatchingPanel(onContinue: () -> Unit, onExit: () -> Unit, modifier: Modifier = Modifier) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { focus.requestFocus() } }
    BackHandler(onBack = onExit)
    Column(modifier.widthIn(max = 640.dp).glass().padding(32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(stringResource(R.string.player_still_watching), style = MaterialTheme.typography.headlineSmall, color = Tokens.foreground)
        Text(stringResource(R.string.player_still_watching_hint), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            PrimaryButton(stringResource(R.string.player_continue), onContinue, Modifier.focusRequester(focus))
            SecondaryButton(stringResource(R.string.player_exit), onExit)
        }
    }
}

/**
 * [ChoiceDialog] composed only while open: a closed-but-composed side panel keeps its
 * focusable items in the tree during the exit animation and steals focus restoration.
 */
@Composable
private fun <T> PanelDialog(
    title: String,
    options: List<Choice<T>>,
    selected: T?,
    onPick: (T) -> Unit,
    onDismiss: () -> Unit,
    visible: Boolean,
) {
    if (visible) ChoiceDialog(title, options, selected, onPick, onDismiss, visible = true)
}

private fun audioLabel(lang: String?, codec: String, channels: Int, title: String?): String {
    val ch = when (channels) { 1 -> "1.0"; 2 -> "2.0"; 6 -> "5.1"; 8 -> "7.1"; else -> if (channels > 0) "${channels}ch" else "" }
    val main = listOfNotNull(
        lang?.uppercase()?.takeIf { it.isNotBlank() && it != "UND" },
        codec.uppercase().takeIf { it.isNotBlank() },
        ch.ifBlank { null },
    ).joinToString(" · ")
    return if (!title.isNullOrBlank()) "$main ($title)" else main.ifBlank { "—" }
}

/** PGS/VobSub/DVB are bitmaps — the server cannot turn them into WebVTT. */
private val BITMAP_SUBS = setOf("hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "dvb_subtitle", "dvbsub", "xsub")

private fun buildVideoItem(context: Context, api: MmoApi, f: VideoFile, hls: Boolean, hlsStartSec: Long, audio: Int = 0): MediaItem {
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
    if (hls) b.setUri(api.hlsUrl(f.fileId, hlsStartSec, audio)).setMimeType(MimeTypes.APPLICATION_M3U8)
    else b.setUri(api.directUrl(f.fileId))
    return b.build()
}

private fun buildItems(context: Context, api: MmoApi, request: PlayRequest, hlsStartSec: Long = 0L): List<MediaItem> = when (request) {
    is PlayRequest.Video -> listOf(buildVideoItem(context, api, request.file, request.hls, hlsStartSec))
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
