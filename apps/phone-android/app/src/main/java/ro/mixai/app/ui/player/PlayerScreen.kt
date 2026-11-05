package ro.mixai.app.ui.player

import android.content.Context
import android.content.pm.ActivityInfo
import android.media.AudioManager
import android.os.SystemClock
import android.util.Rational
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.annotation.StringRes
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.AspectRatio
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.BrightnessMedium
import androidx.compose.material.icons.filled.FitScreen
import androidx.compose.material.icons.filled.FormatSize
import androidx.compose.material.icons.filled.Forward10
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PictureInPictureAlt
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Tv
import androidx.compose.runtime.collectAsState
import androidx.media3.cast.CastPlayer
import androidx.media3.cast.MediaRouteButton
import androidx.media3.cast.MediaRouteButtonState
import ro.mixai.app.cast.CastSupport
import ro.mixai.app.downloads.DownloadCenter
import ro.mixai.app.ui.kids.CapUi
import ro.mixai.app.ui.kids.DailyCapLocked
import ro.mixai.app.ui.kids.capUiState
import ro.mixai.app.ui.playon.PlayOnRequest
import ro.mixai.app.ui.playon.PlayOnSheet
import ro.mixai.app.ui.playon.deviceSessionFor
import ro.mixai.app.ui.together.RoomPlaybackSync
import ro.mixai.app.ui.together.SyncCommand
import ro.mixai.tv.data.isKid
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
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
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView
import androidx.media3.ui.compose.PlayerSurface
import androidx.media3.ui.compose.SURFACE_TYPE_SURFACE_VIEW
import coil3.compose.AsyncImage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import ro.mixai.app.AppDeps
import ro.mixai.app.MainActivity
import ro.mixai.app.PipController
import ro.mixai.app.R
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.app.ui.components.ErrorState
import ro.mixai.app.ui.components.findActivity
import ro.mixai.app.ui.theme.Mixai
import ro.mixai.tv.data.ClientIdentity
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.VideoFile
import kotlin.math.roundToInt

private const val PROGRESS_EVERY_MS = 5_000L
private const val SERVER_PROGRESS_EVERY_MS = 10_000L
private const val OSD_HIDE_MS = 4_000L
private const val LOCK_HINT_MS = 3_000L
private const val TAP_SEEK_COMMIT_MS = 650L
private const val UP_NEXT_SEC = 10
/** No credits marker -> Up Next this long before the end. */
private const val UP_NEXT_FALLBACK_MS = 25_000L
private const val BOOST_SPEED = 2f
private val SPEEDS = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)
private val SUB_SIZES = listOf("S" to 0.75f, "M" to 1f, "L" to 1.3f, "XL" to 1.65f)
/** Minutes; -1 = end of episode, 0 = off. */
private val SLEEP_OPTIONS = listOf(0, 15, 30, 45, 60, -1)
private const val SUB_OFF = "off"
/** Android PiP accepts 1/2.39 ..2.39; keep a margin for rounding. */
private const val PIP_MIN_ASPECT = 0.42f
private const val PIP_MAX_ASPECT = 2.38f

private enum class Sheet { None, Tracks, SubStyle, Speed, Sleep, Audio, Bookmarks, SubSearch, More }

private data class TapSeek(val forward: Boolean, val taps: Int, val baseMs: Long)

private data class LevelHud(val volume: Boolean, val level: Float)

/**
 * Full-screen phone video player (port of the TV PlayerScreen, touch instead of D-pad).
 * Loads the file, resolves the resume position, then hands over to [VideoPlayer].
 */
@Composable
fun PlayerScreen(deps: AppDeps, nav: Navigator, dest: Dest.Player) {
    val context = LocalContext.current
    var file by remember(dest) { mutableStateOf<VideoFile?>(null) }
    var resume by remember(dest) { mutableLongStateOf(0L) }
    var loadError by remember(dest) { mutableStateOf<Throwable?>(null) }
    var attempt by remember(dest) { mutableIntStateOf(0) }
    var capLocked by remember(dest) { mutableStateOf<CapUi.Locked?>(null) }
    var askCellular by remember(dest) { mutableStateOf(false) }
    val cellKey = remember(dest) { cellularKey(dest.ref?.kind, dest.ref?.tmdbId, dest.fileId) }

    LaunchedEffect(dest, attempt) {
        loadError = null
        val offline = offlineDownload(dest.fileId)
        try {
            // Offline (airplane mode): the downloaded copy carries enough metadata to play.
            val f = try { deps.api.fileInfo(dest.fileId) } catch (e: CancellationException) { throw e } catch (e: Exception) {
                offline?.let { offlineVideoFile(it.meta) } ?: throw e
            }
            resume = when {
                dest.resumeMs > 0 -> dest.resumeMs
                dest.resumeMs == 0L -> 0L
                else -> deps.settings.progress.first()[dest.fileId]
                    ?.let { p -> if (p.dur > 0 && p.fraction >= 0.95f) 0L else p.pos.coerceAtLeast(0L) } ?: 0L
            }
            // Kids daily cap (server answers 403 daily_cap on playback; check first for a friendly screen).
            val prof = deps.profiles.activeProfile.value
            if (prof?.isKid == true && offline == null) {
                (capUiState(runCatching { deps.phoneApi.usage(prof.id) }.getOrNull(), true) as? CapUi.Locked)?.let { capLocked = it }
            }
            askCellular = shouldAskCellular(
                currentNet(context), deps.phone.settings.dataSaver.first(), deps.phone.settings.cellularAllowed(cellKey), offline != null,
            )
            file = f
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            loadError = e
        }
    }

    val f = file
    val locked = capLocked
    if (locked != null) {
        BackHandler { nav.pop() }
        DailyCapLocked(locked, deps.profiles.activeProfile.value?.name, onSwitchProfile = { nav.replace(Dest.ProfilePicker) }, onBack = { nav.pop() })
        return
    }
    BackHandler(enabled = f == null || askCellular) { nav.pop() }
    Box(Modifier.fillMaxSize().background(Mixai.colors.scrimBase), contentAlignment = Alignment.Center) {
        when {
            f != null && askCellular -> AlertDialog(
                onDismissRequest = { nav.pop() },
                title = { Text(stringResource(R.string.cellular_title)) },
                text = { Text(stringResource(R.string.cellular_body)) },
                confirmButton = {
                    Button(onClick = { deps.scope.launch { deps.phone.settings.allowCellular(cellKey) }; askCellular = false }) {
                        Text(stringResource(R.string.cellular_always_title))
                    }
                },
                dismissButton = {
                    Row {
                        TextButton(onClick = { nav.pop() }) { Text(stringResource(R.string.action_cancel)) }
                        TextButton(onClick = { askCellular = false }) { Text(stringResource(R.string.cellular_once)) }
                    }
                },
            )
            f != null -> key(f.fileId) { VideoPlayer(deps, nav, dest, f, resume, onDailyCap = { capLocked = it }) }
            loadError != null -> Surface(shape = RoundedCornerShape(16.dp), modifier = Modifier.padding(24.dp).widthIn(max = 480.dp)) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(16.dp)) {
                    ErrorState(loadError, onRetry = { attempt++ })
                    TextButton(onClick = { nav.pop() }) { Text(stringResource(R.string.action_back)) }
                }
            }
            else -> {
                val loading = stringResource(R.string.player_loading)
                CircularProgressIndicator(
                    color = Mixai.colors.onScrim,
                    modifier = Modifier.semanticsDescription(loading),
                )
            }
        }
    }
}

private fun Modifier.semanticsDescription(label: String): Modifier = semantics { contentDescription = label }

@OptIn(UnstableApi::class)
@kotlin.OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VideoPlayer(deps: AppDeps, nav: Navigator, dest: Dest.Player, file: VideoFile, resumeMs: Long, onDailyCap: (CapUi.Locked) -> Unit) {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    val view = LocalView.current
    val api = deps.api
    val scope = rememberCoroutineScope()
    val offline = remember(file.fileId) { offlineDownload(file.fileId) }
    val hls = !file.directPlayable && offline == null
    val ref: MediaRef? = dest.ref
    val audioManager = remember(context) { context.getSystemService(Context.AUDIO_SERVICE) as AudioManager }

    // ─── system chrome: landscape, immersive, screen on ──────────────────
    DisposableEffect(activity, view) {
        val window = activity?.window
        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        val insets = window?.let { WindowCompat.getInsetsController(it, view) }
        insets?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        insets?.hide(WindowInsetsCompat.Type.systemBars())
        view.keepScreenOn = true
        onDispose {
            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            insets?.show(WindowInsetsCompat.Type.systemBars())
            view.keepScreenOn = false
            window?.let { w ->
                val lp = w.attributes
                lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                w.attributes = lp
            }
        }
    }

    // ─── profile prefs ───────────────────────────────────────────────────
    val prof = remember { deps.profiles.activeProfile.value }
    val prefAutoplay = remember {
        // Legacy key "autoplay" wins only when the new one was never written (same as TV).
        val legacy = (prof?.prefs?.get("autoplay") as? JsonPrimitive)?.booleanOrNull
        if (legacy != null && prof?.prefs?.get(PlayerPrefKeys.AUTOPLAY_NEXT) == null) legacy
        else prof.prefBool(PlayerPrefKeys.AUTOPLAY_NEXT, true)
    }
    val prefSkipIntro = remember { prof.prefBool(PlayerPrefKeys.SKIP_INTRO, false) }
    val prefAudioLang = remember { prof.prefString(PlayerPrefKeys.AUDIO_LANG, "") }
    val prefSubLang = remember { prof.prefString(PlayerPrefKeys.SUB_LANG, "") }
    val prefForcedOnly = remember { prof.prefBool(PlayerPrefKeys.SUB_FORCED_ONLY, false) }
    val prefSubSize = remember {
        when (prof.prefString(PlayerPrefKeys.SUB_SIZE, "medium")) { "small" -> 0.75f; "large" -> 1.3f; "xlarge" -> 1.65f; else -> 1f }
    }
    val prefSubBg = remember { prof.prefString(PlayerPrefKeys.SUB_BG, "box") == "box" }

    // ─── state ───────────────────────────────────────────────────────────
    var error by remember { mutableStateOf<String?>(null) }
    var playing by remember { mutableStateOf(false) }
    var wantPlay by remember { mutableStateOf(false) }
    var buffering by remember { mutableStateOf(false) }
    var ended by remember { mutableStateOf(false) }
    var tracks by remember { mutableStateOf(Tracks.EMPTY) }
    var speed by remember { mutableFloatStateOf(1f) }
    var boosted by remember { mutableStateOf(false) }
    var osdVisible by remember { mutableStateOf(true) }
    var lastTouchAt by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    var sheet by remember { mutableStateOf(Sheet.None) }
    var locked by remember { mutableStateOf(false) }
    var lockHint by remember { mutableStateOf(false) }
    var scrubTarget by remember { mutableStateOf<Long?>(null) }
    var sprite by remember { mutableStateOf<ImageBitmap?>(null) }
    var spriteRequested by remember { mutableStateOf(false) }
    var posMs by remember { mutableLongStateOf(0L) }
    var durMs by remember { mutableLongStateOf(0L) }
    var videoAspect by remember { mutableFloatStateOf(0f) }
    var zoom by remember { mutableStateOf(false) }
    var audioPick by remember { mutableStateOf<Int?>(null) }
    var subPick by remember { mutableStateOf<String?>(null) }
    var subSize by remember { mutableFloatStateOf(prefSubSize) }
    var subBackground by remember { mutableStateOf(prefSubBg) }
    var markers by remember { mutableStateOf(Markers()) }
    var episodes by remember { mutableStateOf(EpisodeContext()) }
    var upNextDismissed by remember { mutableStateOf(false) }
    var stillWatching by remember { mutableStateOf(false) }
    var tapSeek by remember { mutableStateOf<TapSeek?>(null) }
    var tapSeekJob by remember { mutableStateOf<Job?>(null) }
    var levelHud by remember { mutableStateOf<LevelHud?>(null) }
    var subtitleView by remember { mutableStateOf<SubtitleView?>(null) }
    val sleep = remember { SleepTimer { SystemClock.elapsedRealtime() } }
    var sleepMinutes by remember { mutableIntStateOf(0) }
    var sleepLeftMs by remember { mutableStateOf<Long?>(null) }
    val inPip by PipController.inPip
    // D38 extras
    val boost = remember { DialogueBoostProcessor() }
    var nightMode by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { nightMode = deps.phone.settings.nightMode.first() }
    LaunchedEffect(nightMode) { boost.enabled = nightMode }
    var secondSub by remember { mutableIntStateOf(-1) }
    var secondCues by remember { mutableStateOf<List<VttCue>>(emptyList()) }
    var playOnOpen by remember { mutableStateOf(false) }
    val roomSync = remember { RoomPlaybackSync(deps.hub) }
    val devices by deps.hub.devices.collectAsState()
    var myDeviceId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { myDeviceId = deps.settings.deviceId() }
    val tvSession = deviceSessionFor(devices, file.fileId, myDeviceId)

    val player = remember {
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(ClientIdentity.current.userAgent)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
        // Downloaded originals play from the Media3 download cache (works in airplane mode).
        val source = if (offline != null) DownloadCenter.cacheDataSourceFactory(context) else http
        ExoPlayer.Builder(context)
            .setRenderersFactory(
                BoostRenderersFactory(context, boost).setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER),
            )
            .setMediaSourceFactory(DefaultMediaSourceFactory(context).setDataSourceFactory(source))
            .setHandleAudioBecomingNoisy(true)
            .build().apply {
                val b = trackSelectionParameters.buildUpon()
                if (prefAudioLang.isNotBlank()) b.setPreferredAudioLanguage(prefAudioLang)
                if (prefSubLang.isNotBlank() && !prefForcedOnly) b.setPreferredTextLanguage(prefSubLang)
                if (prefForcedOnly) b.setIgnoredTextSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                trackSelectionParameters = b.build()
            }
    }
    // Google Cast: CastPlayer wraps the local ExoPlayer and moves playback to a Cast device when a session starts.
    val castPlayer = remember(player) {
        if (CastSupport.available && offline == null) runCatching { CastPlayer.Builder(context).setLocalPlayer(player).build() }.getOrNull() else null
    }
    val controlPlayer: Player = castPlayer ?: player
    // Unique id: during nav.replace (next episode, handoff) the old player is still composed and holds its session;
    // a fixed id throws "Session ID must be unique" (seen on the TV app, tv PlayerScreen.kt:254).
    val session = remember(player) { MediaSession.Builder(context, controlPlayer).setId("video-${file.fileId}-${SystemClock.elapsedRealtimeNanos()}").build() }

    // ─── positions (hlsOffset math, same as TV) ──────────────────────────
    /** HLS started server-side at this ABSOLUTE position: player time is relative to it. */
    var hlsOffset by remember { mutableLongStateOf(if (hls && resumeMs > 0) (resumeMs / 1000) * 1000 else 0L) }
    var hlsAudio by remember { mutableIntStateOf(0) }
    fun durOk(d: Long) = d > 0 && d != C.TIME_UNSET
    fun absPos() = player.currentPosition + hlsOffset
    fun absDur(): Long {
        val src = file.durationSec
        if (hls && src != null && src > 0) return (src * 1000).toLong()
        val d = player.duration
        if (hlsOffset == 0L) return if (!durOk(d) && src != null && src > 0) (src * 1000).toLong() else d
        return if (src != null && src > 0) (src * 1000).toLong() else if (durOk(d)) d + hlsOffset else d
    }

    fun report() {
        val dur = absDur()
        if (durOk(dur)) deps.saveLocalProgress(file.fileId, absPos(), dur)
    }
    fun reportServer() {
        val r = ref ?: return
        val dur = absDur()
        if (durOk(dur)) deps.saveServerProgress(r, absPos(), dur)
    }
    fun exit() { report(); reportServer(); nav.pop() }

    fun restartHls(targetAbs: Long) {
        val startSec = (targetAbs / 1000).coerceAtLeast(0)
        hlsOffset = startSec * 1000
        player.setMediaItem(buildVideoItem(context, api, file, hls = true, hlsStartSec = startSec, audio = hlsAudio))
        player.prepare()
    }
    fun seekAbs(targetAbs: Long) {
        val dur = absDur()
        val t = if (durOk(dur)) targetAbs.coerceIn(0, (dur - 1_000).coerceAtLeast(0)) else targetAbs.coerceAtLeast(0)
        if (hls) {
            val rel = t - hlsOffset
            val d = player.duration
            val available = maxOf(player.bufferedPosition, if (durOk(d)) d else 0L)
            // Behind the stream start or past what ffmpeg produced -> restart server-side at t.
            if (rel < 0 || rel > available) restartHls(t) else player.seekTo(rel)
        } else {
            player.seekTo(t)
        }
        ended = false
    }
    fun togglePlay() {
        val inRoom = roomSync.isActiveFor(file.fileId)
        if (player.isPlaying) { player.pause(); if (inRoom) roomSync.onLocalPause(absPos() / 1000.0) }
        else { if (ended) seekAbs(0); player.play(); if (inRoom) roomSync.onLocalPlay(absPos() / 1000.0) }
    }

    fun touched() {
        lastTouchAt = SystemClock.elapsedRealtime()
        PlaybackSession.autoplayStreak = 0
    }
    fun showOsd() { osdVisible = true; touched() }
    fun toast(@StringRes id: Int, vararg args: Any) {
        Toast.makeText(context, context.getString(id, *args), Toast.LENGTH_SHORT).show()
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
            val fileTracks = file.audioTracks
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
                val code = (e.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode
                val body = (e.cause as? HttpDataSource.InvalidResponseCodeException)?.responseBody?.let { String(it) }
                if (code == 403 && body?.contains("daily_cap") == true) {
                    onDailyCap(CapUi.Locked(null, 0)); return
                }
                error = when (code) {
                    404 -> context.getString(R.string.player_err_missing)
                    null -> context.getString(R.string.player_err_playback, e.errorCodeName)
                    else -> context.getString(R.string.player_err_server, code)
                }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
                if (!isPlaying) { report(); reportServer() }
            }
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) { wantPlay = playWhenReady }
            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
                ended = state == Player.STATE_ENDED
            }
            override fun onTracksChanged(t: Tracks) { tracks = t; applyTracks(t) }
            override fun onVideoSizeChanged(v: VideoSize) {
                if (v.width > 0 && v.height > 0) videoAspect = v.width * v.pixelWidthHeightRatio / v.height
            }
            override fun onCues(cueGroup: CueGroup) { subtitleView?.setCues(cueGroup.cues) }
        }
        player.addListener(listener)
        onDispose {
            report()
            reportServer()
            player.removeListener(listener)
            session.release()
            castPlayer?.release()
            player.release()
        }
    }

    // ─── start ───────────────────────────────────────────────────────────
    LaunchedEffect(Unit) {
        val hlsStartSec = hlsOffset / 1000
        // The profile's audio language picks the HLS track up front (the stream carries one).
        if (hls && prefAudioLang.isNotBlank()) {
            val want = prefAudioLang.lowercase()
            val idx = file.audioTracks.indexOfFirst { t ->
                t.lang?.lowercase()?.let { it == want || it.startsWith(want) || want.startsWith(it) } == true
            }
            if (idx > 0) hlsAudio = idx
        }
        val item = buildVideoItem(context, api, file, hls, hlsStartSec, hlsAudio)
            .let { if (offline != null) DownloadCenter.offlineMediaItem(file.fileId, file.title) ?: it else it }
        val startPos = if (resumeMs > 0 && hlsStartSec == 0L) resumeMs else C.TIME_UNSET
        player.setMediaItems(listOf(item), 0, startPos)
        player.prepare()
        // "Are you still watching?" after 3 autoplayed episodes without interaction.
        val auto = PlaybackSession.pendingAuto
        PlaybackSession.pendingAuto = false
        if (!auto) PlaybackSession.autoplayStreak = 0
        if (auto && PlaybackSession.autoplayStreak >= STILL_WATCHING_AFTER) {
            player.playWhenReady = false
            stillWatching = true
        } else {
            player.playWhenReady = true
        }
    }

    // Skip markers + episode context (all tolerant of 404/empty).
    LaunchedEffect(file.fileId) {
        val id = file.fileId
        launch { val s = fetchSpan(api, "/video/intro/$id"); markers = markers.copy(intro = s) }
        launch { val s = fetchSpan(api, "/video/recap/$id"); markers = markers.copy(recap = s) }
        launch { val c = fetchCreditsMs(api, id); markers = markers.copy(creditsMs = c) }
        val r = ref
        if (r != null && r.kind == "tv") launch { episodes = resolveEpisodes(deps, r) }
    }

    LaunchedEffect(player) {
        while (true) {
            posMs = absPos().coerceAtLeast(0)
            durMs = absDur().takeIf { durOk(it) } ?: 0L
            delay(250)
        }
    }
    LaunchedEffect(osdVisible, lastTouchAt, wantPlay, sheet, scrubTarget) {
        if (!osdVisible || !wantPlay || sheet != Sheet.None || scrubTarget != null) return@LaunchedEffect
        delay(OSD_HIDE_MS)
        osdVisible = false
    }
    LaunchedEffect(lockHint) { if (lockHint) { delay(LOCK_HINT_MS); lockHint = false } }
    LaunchedEffect(playing) { while (playing) { delay(PROGRESS_EVERY_MS); report() } }
    LaunchedEffect(playing) { while (playing) { delay(SERVER_PROGRESS_EVERY_MS); reportServer() } }

    // ─── sleep timer ─────────────────────────────────────────────────────
    LaunchedEffect(sleepMinutes) {
        if (sleepMinutes == 0) { player.volume = 1f; sleepLeftMs = null; return@LaunchedEffect }
        while (true) {
            player.volume = sleep.fadeVolumeAt(absPos(), absDur())
            sleepLeftMs = sleep.remainingMs()
            if (sleep.shouldPause(absPos(), absDur())) {
                val endOfEpisode = sleepMinutes < 0
                sleep.cancel()
                player.volume = 1f
                player.pause()
                sleepLeftMs = null
                if (endOfEpisode) exit() else { toast(R.string.player_sleep_paused); showOsd() }
                sleepMinutes = 0
                break
            }
            delay(500)
        }
    }

    // ─── Watch Together: follow the room when it plays this file ─────────
    LaunchedEffect(file.fileId) {
        while (true) {
            delay(1_000)
            if (!roomSync.isActiveFor(file.fileId)) continue
            when (val c = roomSync.tick(absPos() / 1000.0, player.isPlaying)) {
                SyncCommand.None -> Unit
                is SyncCommand.SetRate -> player.setPlaybackSpeed(speed * c.rate)
                is SyncCommand.SeekTo -> seekAbs((c.sec * 1000).toLong())
                SyncCommand.Play -> player.play()
                SyncCommand.Pause -> player.pause()
            }
        }
    }

    // ─── dual subtitles: second track rendered as an overlay ─────────────
    LaunchedEffect(secondSub) {
        secondCues = if (secondSub < 0) emptyList() else runCatching { loadVtt(api.subtitleUrl(file.fileId, secondSub)) }.getOrDefault(emptyList())
    }

    // ─── PiP ─────────────────────────────────────────────────────────────
    LaunchedEffect(playing, videoAspect) {
        PipController.enabled.value = playing
        if (videoAspect > 0f) {
            val a = videoAspect.coerceIn(PIP_MIN_ASPECT, PIP_MAX_ASPECT)
            PipController.aspect.value = Rational((a * 1000).roundToInt(), 1000)
        }
        (activity as? MainActivity)?.updatePip()
    }
    DisposableEffect(Unit) {
        onDispose {
            PipController.enabled.value = false
            (activity as? MainActivity)?.updatePip()
        }
    }

    // ─── lifecycle: pause when stopped unless in PiP ─────────────────────
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, ev ->
            if (ev == Lifecycle.Event.ON_STOP && activity?.isInPictureInPictureMode != true) player.pause()
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }
    // PiP window closed (activity left stopped) -> pause.
    LaunchedEffect(inPip) {
        if (!inPip && !owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) player.pause()
    }

    // ─── derived ─────────────────────────────────────────────────────────
    val isEpisode = ref?.kind == "tv"
    val next = episodes.next?.takeIf { it.fileId != null }
    val atCredits by remember {
        derivedStateOf { durMs > 0 && (markers.creditsMs?.let { posMs >= it } ?: (durMs - posMs <= UP_NEXT_FALLBACK_MS)) }
    }
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
    var autoSkipped by remember { mutableStateOf<Span?>(null) }
    LaunchedEffect(skipNow, prefSkipIntro) {
        val s = skipNow ?: return@LaunchedEffect
        if (prefSkipIntro && autoSkipped != s) { autoSkipped = s; seekAbs(s.endMs) }
    }
    val autoplay = prefAutoplay && sleepMinutes >= 0
    val showUpNext = isEpisode && next != null && !upNextDismissed && (atCredits || ended) && error == null

    fun playNext(auto: Boolean) {
        val n = next ?: return
        val nid = n.fileId ?: return
        val r = ref ?: return
        report(); reportServer()
        PlaybackSession.pendingAuto = auto
        PlaybackSession.autoplayStreak = if (auto) PlaybackSession.autoplayStreak + 1 else 0
        nav.replace(Dest.Player(nid, MediaRef("tv", r.tmdbId, n.season, n.episode), 0L))
    }

    var countdown by remember { mutableIntStateOf(UP_NEXT_SEC) }
    LaunchedEffect(showUpNext, autoplay) {
        countdown = UP_NEXT_SEC
        if (!showUpNext || !autoplay) return@LaunchedEffect
        while (countdown > 0) { delay(1_000); countdown-- }
        playNext(auto = true)
    }
    LaunchedEffect(ended) {
        if (!ended) return@LaunchedEffect
        when {
            next != null && autoplay && !upNextDismissed -> playNext(auto = true)
            next != null && !upNextDismissed -> Unit
            else -> exit()
        }
    }
    LaunchedEffect(showUpNext) { if (showUpNext) osdVisible = false }

    // ─── scrub / gestures ────────────────────────────────────────────────
    fun ensureSprite() {
        if (spriteRequested) return
        spriteRequested = true
        scope.launch {
            repeat(12) { // 503 while the server builds it
                sprite = loadSprite(context, api.spriteUrl(file.fileId))
                if (sprite != null) return@launch
                delay(10_000)
            }
        }
    }
    fun commitScrub() {
        scrubTarget?.let { seekAbs(it); if (roomSync.isActiveFor(file.fileId)) roomSync.onLocalSeek(it / 1000.0) }
        scrubTarget = null
    }
    fun tapSeekAdd(forward: Boolean, taps: Int) {
        val cur = tapSeek
        val next2 = if (cur != null && cur.forward == forward) cur.copy(taps = cur.taps + taps) else TapSeek(forward, taps, absPos())
        tapSeek = next2
        tapSeekJob?.cancel()
        tapSeekJob = scope.launch {
            delay(TAP_SEEK_COMMIT_MS)
            seekAbs(doubleTapSeek(next2.baseMs, next2.taps, next2.forward, durMs))
            tapSeek = null
        }
    }
    fun onTap(x: Float, width: Int) {
        touched()
        if (locked) { lockHint = true; return }
        val ts = tapSeek
        if (ts != null) {
            val forward = x > width * 2f / 3f
            val back = x < width / 3f
            if ((forward && ts.forward) || (back && !ts.forward)) { tapSeekAdd(ts.forward, 1); return }
        }
        osdVisible = !osdVisible
    }
    fun onDoubleTap(x: Float, width: Int) {
        touched()
        if (locked) { lockHint = true; return }
        when {
            x < width / 3f -> tapSeekAdd(false, if (tapSeek?.forward == false) 2 else 1)
            x > width * 2f / 3f -> tapSeekAdd(true, if (tapSeek?.forward == true) 2 else 1)
            else -> togglePlay()
        }
    }
    fun currentBrightness(): Float {
        val b = activity?.window?.attributes?.screenBrightness ?: -1f
        if (b >= 0f) return b
        val sys = runCatching { android.provider.Settings.System.getInt(context.contentResolver, android.provider.Settings.System.SCREEN_BRIGHTNESS) }.getOrNull() ?: 128
        return (sys / 255f).coerceIn(0f, 1f)
    }
    fun setBrightness(v: Float) {
        val w = activity?.window ?: return
        val lp = w.attributes
        lp.screenBrightness = v.coerceIn(0.01f, 1f)
        w.attributes = lp
    }
    fun currentVolume(): Float {
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        return audioManager.getStreamVolume(AudioManager.STREAM_MUSIC).toFloat() / max
    }
    fun setVolume(v: Float) {
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, (v * max).roundToInt(), 0)
    }

    BackHandler(enabled = sheet == Sheet.None && !stillWatching) {
        if (scrubTarget != null) scrubTarget = null else exit()
    }

    val onScrim = Mixai.colors.onScrim
    val scrimBase = Mixai.colors.scrimBase

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        VideoSurface(player, videoAspect, zoom)

        // Subtitles: media3 SubtitleView fed by onCues (the compose surface has no subtitle layer).
        val subFg = Color.White.toArgb()
        val subBg = if (subBackground) Color.Black.copy(alpha = 0.6f).toArgb() else Color.Transparent.toArgb()
        val subEdge = Color.Black.toArgb()
        AndroidView(
            factory = { ctx -> SubtitleView(ctx).also { subtitleView = it } },
            update = { sv ->
                sv.setStyle(
                    CaptionStyleCompat(
                        subFg, subBg, Color.Transparent.toArgb(),
                        if (subBackground) CaptionStyleCompat.EDGE_TYPE_NONE else CaptionStyleCompat.EDGE_TYPE_OUTLINE, subEdge, null,
                    ),
                )
                sv.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * subSize)
            },
            modifier = Modifier.fillMaxSize(),
        )

        // Dual subtitles: the second language above the main line.
        val second = remember(secondCues, posMs) { Vtt.activeText(secondCues, posMs) }
        if (second != null && !inPip) {
            Text(
                second,
                style = MaterialTheme.typography.titleMedium,
                color = Color.White,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 40.dp, start = 48.dp, end = 48.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(Color.Black.copy(alpha = 0.55f))
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }

        // Gesture layer (under the OSD).
        if (!inPip) {
            var scrubStart by remember { mutableLongStateOf(0L) }
            var dragX by remember { mutableFloatStateOf(0f) }
            var dragY by remember { mutableFloatStateOf(0f) }
            var levelStart by remember { mutableFloatStateOf(0f) }
            var volumeSide by remember { mutableStateOf(false) }
            Box(
                Modifier
                    .fillMaxSize()
                    .pointerInput(locked) {
                        detectTapGestures(
                            onTap = { o -> onTap(o.x, size.width) },
                            onDoubleTap = { o -> onDoubleTap(o.x, size.width) },
                            onLongPress = {
                                if (!locked && player.isPlaying) {
                                    boosted = true
                                    player.setPlaybackSpeed(BOOST_SPEED)
                                }
                            },
                            onPress = {
                                tryAwaitRelease()
                                if (boosted) {
                                    boosted = false
                                    player.setPlaybackSpeed(speed)
                                }
                            },
                        )
                    }
                    .pointerInput(locked) {
                        if (locked) return@pointerInput
                        detectHorizontalDragGestures(
                            onDragStart = {
                                touched()
                                ensureSprite()
                                scrubStart = absPos()
                                dragX = 0f
                                scrubTarget = scrubStart
                            },
                            onDragEnd = { commitScrub() },
                            onDragCancel = { scrubTarget = null },
                        ) { change, dx ->
                            change.consume()
                            dragX += dx
                            scrubTarget = seekTargetMs(scrubStart, dragX, size.width.toFloat(), durMs)
                        }
                    }
                    .pointerInput(locked) {
                        if (locked) return@pointerInput
                        detectVerticalDragGestures(
                            onDragStart = { o ->
                                touched()
                                volumeSide = o.x > size.width / 2f
                                levelStart = if (volumeSide) currentVolume() else currentBrightness()
                                dragY = 0f
                                levelHud = LevelHud(volumeSide, levelStart)
                            },
                            onDragEnd = { levelHud = null },
                            onDragCancel = { levelHud = null },
                        ) { change, dy ->
                            change.consume()
                            dragY += dy
                            val v = levelAfterDrag(levelStart, dragY, size.height.toFloat())
                            if (volumeSide) setVolume(v) else setBrightness(v)
                            levelHud = LevelHud(volumeSide, v)
                        }
                    },
            )
        }

        if (!inPip) {
            // Scrub preview while dragging with the OSD hidden.
            val target = scrubTarget
            if (target != null && !osdVisible && durMs > 0) {
                Box(Modifier.align(Alignment.Center)) {
                    ScrubPreview(sprite, spriteGrid(durMs / 1000.0), target, 0.5f, onScrim, scrimBase)
                }
            }

            // Double-tap seek bubble.
            tapSeek?.let { ts ->
                Box(
                    Modifier
                        .align(if (ts.forward) Alignment.CenterEnd else Alignment.CenterStart)
                        .padding(horizontal = 48.dp)
                        .size(120.dp)
                        .clip(CircleShape)
                        .background(scrimBase.copy(alpha = 0.55f)),
                    contentAlignment = Alignment.Center,
                ) {
                    val secs = ts.taps * (DOUBLE_TAP_STEP_MS / 1000).toInt()
                    Text(
                        stringResource(if (ts.forward) R.string.player_seek_fwd else R.string.player_seek_back, secs),
                        style = MaterialTheme.typography.titleLarge, color = onScrim,
                    )
                }
            }

            // Brightness / volume HUD.
            levelHud?.let { hud ->
                Row(
                    Modifier
                        .align(Alignment.TopCenter)
                        .padding(top = 32.dp)
                        .clip(RoundedCornerShape(24.dp))
                        .background(scrimBase.copy(alpha = 0.7f))
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(
                        if (hud.volume) Icons.AutoMirrored.Filled.VolumeUp else Icons.Filled.BrightnessMedium,
                        contentDescription = stringResource(if (hud.volume) R.string.player_volume else R.string.player_brightness),
                        tint = onScrim,
                    )
                    LinearProgressIndicator(progress = { hud.level }, modifier = Modifier.width(160.dp))
                }
            }

            if (boosted) {
                Text(
                    stringResource(R.string.player_boost),
                    style = MaterialTheme.typography.labelLarge, color = onScrim,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(top = 32.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(scrimBase.copy(alpha = 0.7f))
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                )
            }

            if (buffering && !osdVisible && error == null) {
                CircularProgressIndicator(color = onScrim, modifier = Modifier.align(Alignment.Center))
            }

            // ─── OSD ─────────────────────────────────────────────────────
            AnimatedVisibility(
                visible = osdVisible && !locked && error == null,
                enter = fadeIn(), exit = fadeOut(), modifier = Modifier.fillMaxSize(),
            ) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(
                            Brush.verticalGradient(
                                listOf(scrimBase.copy(alpha = 0.75f), scrimBase.copy(alpha = 0.25f), scrimBase.copy(alpha = 0.85f)),
                            ),
                        )
                        .windowInsetsPadding(WindowInsets.displayCutout),
                ) {
                    // Top bar.
                    Row(
                        Modifier.align(Alignment.TopStart).fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = { exit() }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back), tint = onScrim)
                        }
                        Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                            Text(file.title, style = MaterialTheme.typography.titleLarge, color = onScrim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val s = ref?.season
                            val e = ref?.episode
                            if (isEpisode && s != null && e != null) {
                                val name = episodes.current?.name?.takeIf { it.isNotBlank() }
                                Text(
                                    stringResource(R.string.player_episode_line, s, e) + (name?.let { " · $it" } ?: ""),
                                    style = MaterialTheme.typography.bodyMedium, color = onScrim.copy(alpha = 0.8f),
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        IconButton(onClick = {
                            val act = activity as? MainActivity
                            if (act != null) runCatching { act.enterPictureInPictureMode(act.pipParams()) }
                        }) {
                            Icon(Icons.Filled.PictureInPictureAlt, stringResource(R.string.player_pip), tint = onScrim)
                        }
                        if (castPlayer != null) {
                            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                                MediaRouteButton(Modifier.size(40.dp), remember { MediaRouteButtonState() })
                            }
                        }
                        IconButton(onClick = { touched(); playOnOpen = true }) {
                            Icon(Icons.Filled.Tv, stringResource(R.string.handoff_continue_tv), tint = onScrim)
                        }
                        IconButton(onClick = { locked = true; osdVisible = false; toast(R.string.player_locked) }) {
                            Icon(Icons.Filled.Lock, stringResource(R.string.player_lock), tint = onScrim)
                        }
                    }

                    // Handoff "Pull back": a TV is already playing this file -> continue here from its position.
                    if (tvSession != null) {
                        val tvName = tvSession.name
                        Button(
                            onClick = {
                                touched()
                                val pos = tvSession.nowPlaying?.positionSec ?: 0.0
                                deps.hub.command(tvSession.deviceId, "pause")
                                seekAbs((pos * 1000).toLong())
                                player.play()
                                context.toastShort(context.getString(R.string.handoff_pulled, tvName))
                            },
                            modifier = Modifier.align(Alignment.TopCenter).padding(top = 64.dp),
                        ) { Text(stringResource(R.string.handoff_pull_back, tvName)) }
                    }

                    // Centre transport.
                    Row(
                        Modifier.align(Alignment.Center),
                        horizontalArrangement = Arrangement.spacedBy(40.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = { touched(); seekAbs(doubleTapSeek(absPos(), 1, false, durMs)) }, modifier = Modifier.size(56.dp)) {
                            Icon(Icons.Filled.Replay10, stringResource(R.string.player_back10), tint = onScrim, modifier = Modifier.size(36.dp))
                        }
                        Box(Modifier.size(80.dp), contentAlignment = Alignment.Center) {
                            if (buffering) {
                                CircularProgressIndicator(color = onScrim, modifier = Modifier.size(64.dp))
                            } else {
                                IconButton(
                                    onClick = { touched(); togglePlay() },
                                    modifier = Modifier.size(80.dp).clip(CircleShape).background(scrimBase.copy(alpha = 0.4f)),
                                ) {
                                    Icon(
                                        if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                                        stringResource(if (playing) R.string.player_pause else R.string.player_play),
                                        tint = onScrim, modifier = Modifier.size(52.dp),
                                    )
                                }
                            }
                        }
                        IconButton(onClick = { touched(); seekAbs(doubleTapSeek(absPos(), 1, true, durMs)) }, modifier = Modifier.size(56.dp)) {
                            Icon(Icons.Filled.Forward10, stringResource(R.string.player_fwd10), tint = onScrim, modifier = Modifier.size(36.dp))
                        }
                    }

                    // Bottom: preview, seek bar, buttons.
                    Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                        val target = scrubTarget
                        if (target != null && durMs > 0) {
                            ScrubPreview(sprite, spriteGrid(durMs / 1000.0), target, target.toFloat() / durMs, onScrim, scrimBase)
                            Spacer(Modifier.height(4.dp))
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(formatTime(scrubTarget ?: posMs), style = MaterialTheme.typography.labelLarge, color = onScrim)
                            val seekLabel = stringResource(R.string.player_seek_bar)
                            Slider(
                                value = if (durMs > 0) ((scrubTarget ?: posMs).toFloat() / durMs).coerceIn(0f, 1f) else 0f,
                                onValueChange = { v ->
                                    touched()
                                    ensureSprite()
                                    scrubTarget = (v * durMs).toLong()
                                },
                                onValueChangeFinished = { commitScrub() },
                                enabled = durMs > 0,
                                colors = SliderDefaults.colors(inactiveTrackColor = onScrim.copy(alpha = 0.3f)),
                                modifier = Modifier.weight(1f).padding(horizontal = 12.dp).semanticsDescription(seekLabel),
                            )
                            Text(
                                if (durMs > 0) "-" + formatTime((durMs - (scrubTarget ?: posMs)).coerceAtLeast(0)) else "",
                                style = MaterialTheme.typography.labelLarge, color = onScrim,
                            )
                        }
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            OsdIcon(Icons.Filled.Subtitles, stringResource(R.string.player_tracks), onScrim) { touched(); sheet = Sheet.Tracks }
                            OsdIcon(Icons.Filled.FormatSize, stringResource(R.string.player_sub_style), onScrim) { touched(); sheet = Sheet.SubStyle }
                            OsdIcon(Icons.Filled.Speed, stringResource(R.string.player_speed), onScrim, selected = speed != 1f) { touched(); sheet = Sheet.Speed }
                            OsdIcon(
                                if (zoom) Icons.Filled.FitScreen else Icons.Filled.AspectRatio,
                                stringResource(if (zoom) R.string.player_fit else R.string.player_zoom), onScrim,
                            ) { touched(); zoom = !zoom }
                            OsdIcon(Icons.Filled.Bedtime, stringResource(R.string.player_sleep), onScrim, selected = sleepMinutes != 0) { touched(); sheet = Sheet.Sleep }
                            OsdIcon(Icons.Filled.RecordVoiceOver, stringResource(R.string.player_night_mode), onScrim, selected = nightMode) {
                                touched()
                                nightMode = !nightMode
                                deps.scope.launch { deps.phone.settings.setNightMode(nightMode) }
                                toast(if (nightMode) R.string.player_night_on else R.string.player_night_off)
                            }
                            OsdIcon(Icons.Filled.MoreHoriz, stringResource(R.string.player_more), onScrim) { touched(); sheet = Sheet.More }
                            if (next != null) {
                                OsdIcon(Icons.Filled.SkipNext, stringResource(R.string.player_next_episode), onScrim) { playNext(auto = false) }
                            }
                            sleepLeftMs?.let { left ->
                                Text(
                                    stringResource(R.string.player_sleep_left, formatTime(left)),
                                    style = MaterialTheme.typography.labelMedium, color = onScrim,
                                    modifier = Modifier.padding(start = 8.dp),
                                )
                            }
                        }
                    }
                }
            }

            // Lock hint / unlock.
            if (locked && lockHint) {
                IconButton(
                    onClick = { locked = false; lockHint = false; showOsd() },
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .windowInsetsPadding(WindowInsets.displayCutout)
                        .padding(16.dp)
                        .clip(CircleShape)
                        .background(scrimBase.copy(alpha = 0.7f)),
                ) {
                    Icon(Icons.Filled.LockOpen, stringResource(R.string.player_unlock), tint = onScrim)
                }
            }

            // Skip intro / recap.
            if (skipNow != null && !showUpNext && !locked && error == null) {
                Button(
                    onClick = { touched(); seekAbs(skipNow.endMs) },
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .windowInsetsPadding(WindowInsets.displayCutout)
                        .padding(end = 24.dp, bottom = if (osdVisible) 132.dp else 32.dp),
                ) {
                    Text(stringResource(if (skipNow == markers.recap) R.string.player_skip_recap else R.string.player_skip_intro))
                }
            }

            // Up Next.
            if (showUpNext && next != null) {
                UpNextCard(
                    subtitle = stringResource(R.string.player_episode_line, next.season, next.episode) +
                        (next.name.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                    stillUrl = next.stillUrl,
                    countdown = if (autoplay) countdown else null,
                    onPlay = { touched(); playNext(auto = false) },
                    onCancel = { touched(); upNextDismissed = true; if (ended) exit() },
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .windowInsetsPadding(WindowInsets.displayCutout)
                        .padding(24.dp),
                )
            }

            // Error.
            error?.let { msg ->
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier.align(Alignment.Center).padding(24.dp).widthIn(max = 480.dp),
                ) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(stringResource(R.string.player_error), style = MaterialTheme.typography.titleLarge)
                        Text(msg, style = MaterialTheme.typography.bodyMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Button(onClick = {
                                error = null
                                if (hls) restartHls(absPos()) else { player.prepare(); player.play() }
                            }) { Text(stringResource(R.string.action_retry)) }
                            TextButton(onClick = { exit() }) { Text(stringResource(R.string.action_back)) }
                        }
                    }
                }
            }
        }
    }

    // ─── sheets ──────────────────────────────────────────────────────────
    if (sheet != Sheet.None && !inPip) {
        ModalBottomSheet(onDismissRequest = { sheet = Sheet.None }) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .navigationBarsPadding()
                    .padding(bottom = 16.dp),
            ) {
                when (sheet) {
                    Sheet.Tracks -> {
                        SheetHeader(stringResource(R.string.player_audio))
                        val aGroups = audioGroups(tracks)
                        val isHlsMulti = hls && file.audioTracks.size > 1
                        if (file.audioTracks.isNotEmpty()) {
                            val selAudio = if (hls) hlsAudio else (audioPick ?: aGroups.indexOfFirst { it.isSelected }.takeIf { it >= 0 } ?: 0)
                            file.audioTracks.forEachIndexed { i, t ->
                                SheetOption(audioLabel(t.lang, t.codec, t.channels, t.title), null, i == selAudio) {
                                    if (isHlsMulti) {
                                        if (i != hlsAudio) { hlsAudio = i; restartHls(absPos()) }
                                    } else { audioPick = i; applyTracks(player.currentTracks) }
                                    sheet = Sheet.None
                                }
                            }
                        } else {
                            val selAudio = audioPick ?: aGroups.indexOfFirst { it.isSelected }.takeIf { it >= 0 } ?: 0
                            aGroups.forEachIndexed { i, g ->
                                val fm = g.getTrackFormat(0)
                                SheetOption(
                                    audioLabel(fm.language, fm.sampleMimeType?.substringAfter('/') ?: "", fm.channelCount, fm.label)
                                        .takeIf { it != "-" } ?: stringResource(R.string.player_audio_track_n, i + 1),
                                    null, i == selAudio,
                                ) { audioPick = i; applyTracks(player.currentTracks); sheet = Sheet.None }
                            }
                        }

                        SheetHeader(stringResource(R.string.player_subtitles))
                        val tGroups = textGroups(tracks)
                        val textDisabled = player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)
                        val selText = subPick ?: if (textDisabled) SUB_OFF
                        else tGroups.withIndex().firstOrNull { it.value.isSelected }?.let { (i, g) -> textKey(i, g.getTrackFormat(0)) } ?: SUB_OFF
                        SheetOption(stringResource(R.string.player_subs_off), null, selText == SUB_OFF) {
                            subPick = SUB_OFF; applyTracks(player.currentTracks); sheet = Sheet.None
                        }
                        val forcedLabel = stringResource(R.string.player_subs_forced)
                        tGroups.withIndex()
                            .sortedByDescending { (_, g) -> g.getTrackFormat(0).selectionFlags and C.SELECTION_FLAG_FORCED != 0 }
                            .forEach { (i, g) ->
                                val fm = g.getTrackFormat(0)
                                val forced = fm.selectionFlags and C.SELECTION_FLAG_FORCED != 0
                                val k = textKey(i, fm)
                                SheetOption(
                                    fm.label ?: fm.language ?: stringResource(R.string.player_subtitle_n, i + 1),
                                    listOfNotNull(fm.language, if (forced) forcedLabel else null).joinToString(" · ").ifBlank { null },
                                    selText == k,
                                ) { subPick = k; applyTracks(player.currentTracks); sheet = Sheet.None }
                            }
                    }
                    Sheet.SubStyle -> {
                        SheetHeader(stringResource(R.string.player_sub_style))
                        Text(
                            stringResource(R.string.player_sub_size), style = MaterialTheme.typography.labelLarge,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        )
                        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            SUB_SIZES.forEach { (label, size) ->
                                FilterChip(selected = subSize == size, onClick = { subSize = size }, label = { Text(label) })
                            }
                        }
                        ListItem(
                            headlineContent = { Text(stringResource(R.string.player_sub_background)) },
                            trailingContent = { Switch(checked = subBackground, onCheckedChange = { subBackground = it }) },
                            modifier = Modifier.clickable { subBackground = !subBackground },
                        )
                    }
                    Sheet.Speed -> {
                        SheetHeader(stringResource(R.string.player_speed))
                        val normal = stringResource(R.string.player_speed_normal)
                        SPEEDS.forEach { s ->
                            SheetOption(if (s == 1f) normal else "${s}×", null, s == speed) {
                                speed = s; player.setPlaybackSpeed(s); sheet = Sheet.None
                            }
                        }
                    }
                    Sheet.Sleep -> {
                        SheetHeader(stringResource(R.string.player_sleep))
                        SLEEP_OPTIONS.forEach { m ->
                            val label = when {
                                m == 0 -> stringResource(R.string.player_sleep_off)
                                m < 0 -> stringResource(R.string.player_sleep_end)
                                else -> stringResource(R.string.player_sleep_min, m)
                            }
                            SheetOption(label, null, m == sleepMinutes) {
                                when {
                                    m == 0 -> sleep.cancel()
                                    m < 0 -> { sleep.startEndOfEpisode(); toast(R.string.player_sleep_set_end) }
                                    else -> { sleep.start(m); toast(R.string.player_sleep_set, m) }
                                }
                                sleepMinutes = m
                                sheet = Sheet.None
                            }
                        }
                    }
                    Sheet.None -> Unit
                    Sheet.More -> {
                        SheetHeader(stringResource(R.string.player_more))
                        ListItem(
                            headlineContent = { Text(stringResource(R.string.player_night_mode)) },
                            supportingContent = { Text(stringResource(R.string.player_night_mode_desc)) },
                            trailingContent = {
                                Switch(checked = nightMode, onCheckedChange = { v -> nightMode = v; deps.scope.launch { deps.phone.settings.setNightMode(v) } })
                            },
                        )
                        ListItem(
                            headlineContent = { Text(stringResource(R.string.player_dual_subs)) },
                            supportingContent = { Text(if (secondSub >= 0) file.subtitleTracks.getOrNull(secondSub)?.let { it.title ?: it.lang } ?: "" else stringResource(R.string.player_subs_off)) },
                            modifier = Modifier.clickable { sheet = Sheet.Audio },
                        )
                        ListItem(
                            headlineContent = { Text(stringResource(R.string.bookmark_title)) },
                            modifier = Modifier.clickable { sheet = Sheet.Bookmarks },
                        )
                        ListItem(
                            headlineContent = { Text(stringResource(R.string.subsearch_title)) },
                            modifier = Modifier.clickable { sheet = Sheet.SubSearch },
                        )
                        ListItem(
                            headlineContent = { Text(stringResource(R.string.handoff_continue_tv)) },
                            modifier = Modifier.clickable { sheet = Sheet.None; playOnOpen = true },
                        )
                    }
                    Sheet.Audio -> {
                        SheetHeader(stringResource(R.string.player_dual_subs))
                        SheetOption(stringResource(R.string.player_subs_off), null, secondSub < 0) { secondSub = -1; sheet = Sheet.None }
                        file.subtitleTracks.forEachIndexed { i, t ->
                            if (t.codec.lowercase() !in BITMAP_SUBS) {
                                SheetOption(t.title ?: t.lang ?: stringResource(R.string.player_subtitle_n, i + 1), t.lang, secondSub == i) { secondSub = i; sheet = Sheet.None }
                            }
                        }
                    }
                    Sheet.Bookmarks -> {
                        SheetHeader(stringResource(R.string.bookmark_title))
                        BookmarksPanel(deps, ref, file.fileId, posMs) { ms -> seekAbs(ms); sheet = Sheet.None }
                    }
                    Sheet.SubSearch -> {
                        SheetHeader(stringResource(R.string.subsearch_title))
                        SubtitleSearchPanel(deps, file.fileId) { ms -> seekAbs(ms); sheet = Sheet.None }
                    }
                }
            }
        }
    }

    if (playOnOpen) {
        PlayOnSheet(
            deps,
            PlayOnRequest(file.fileId, absPos() / 1000.0, ref, file.title),
            onDismiss = { playOnOpen = false },
            onSent = { player.pause(); report(); reportServer() },
        )
    }

    if (stillWatching) {
        AlertDialog(
            onDismissRequest = { exit() },
            title = { Text(stringResource(R.string.player_still_watching)) },
            text = { Text(stringResource(R.string.player_still_watching_hint)) },
            confirmButton = {
                Button(onClick = { PlaybackSession.autoplayStreak = 0; stillWatching = false; player.play(); showOsd() }) {
                    Text(stringResource(R.string.player_continue))
                }
            },
            dismissButton = { TextButton(onClick = { exit() }) { Text(stringResource(R.string.player_exit)) } },
        )
    }
}

/** Fit = letterboxed at the video aspect; zoom = fills the screen, overflow cropped. */
@OptIn(UnstableApi::class)
@Composable
private fun VideoSurface(player: Player, aspect: Float, zoom: Boolean) {
    BoxWithConstraints(Modifier.fillMaxSize().clipToBounds(), contentAlignment = Alignment.Center) {
        val w = maxWidth
        val h = maxHeight
        val mod = if (aspect <= 0f || h.value <= 0f) {
            Modifier.fillMaxSize()
        } else {
            val container = w / h
            val (vw, vh) = if ((aspect > container) xor zoom) w to (w / aspect) else (h * aspect) to h
            Modifier.requiredSize(vw, vh)
        }
        PlayerSurface(player, mod, SURFACE_TYPE_SURFACE_VIEW)
    }
}

@Composable
private fun OsdIcon(icon: ImageVector, label: String, tint: Color, selected: Boolean = false, onClick: () -> Unit) {
    IconButton(onClick = onClick) {
        Icon(icon, contentDescription = label, tint = if (selected) MaterialTheme.colorScheme.primary else tint)
    }
}

@Composable
private fun SheetHeader(text: String) {
    Text(
        text, style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
    )
}

@Composable
private fun SheetOption(label: String, supporting: String?, selected: Boolean, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(label) },
        supportingContent = supporting?.let { s -> @Composable { Text(s) } },
        leadingContent = { RadioButton(selected = selected, onClick = null) },
        modifier = Modifier.clickable(onClick = onClick),
    )
}

@Composable
private fun ScrubPreview(sprite: ImageBitmap?, grid: SpriteGrid?, targetMs: Long, fraction: Float, onScrim: Color, scrim: Color) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val boxW = 176.dp
        val x = (maxWidth * fraction - boxW / 2).coerceIn(0.dp, (maxWidth - boxW).coerceAtLeast(0.dp))
        Column(Modifier.offset(x = x).width(boxW), horizontalAlignment = Alignment.CenterHorizontally) {
            if (sprite != null && grid != null) {
                val tile = spriteTile(grid, targetMs / 1000.0)
                val col = tile % SPRITE_GRID
                val row = tile / SPRITE_GRID
                Canvas(Modifier.size(boxW, 99.dp).clip(RoundedCornerShape(8.dp))) {
                    drawImage(
                        image = sprite,
                        srcOffset = IntOffset(col * SPRITE_TILE_W, row * SPRITE_TILE_H),
                        srcSize = IntSize(SPRITE_TILE_W, SPRITE_TILE_H),
                        dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()),
                    )
                }
                Spacer(Modifier.height(4.dp))
            }
            Text(
                formatTime(targetMs),
                style = MaterialTheme.typography.titleSmall, color = onScrim,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(scrim.copy(alpha = 0.7f)).padding(horizontal = 10.dp, vertical = 2.dp),
            )
        }
    }
}

@Composable
private fun UpNextCard(
    subtitle: String,
    stillUrl: String?,
    countdown: Int?,
    onPlay: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(shape = RoundedCornerShape(16.dp), tonalElevation = 6.dp, modifier = modifier.widthIn(max = 420.dp)) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (stillUrl != null) {
                AsyncImage(
                    model = stillUrl, contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.size(128.dp, 72.dp).clip(RoundedCornerShape(8.dp)),
                )
            }
            Column(Modifier.weight(1f, fill = false)) {
                Text(stringResource(R.string.player_up_next), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text(subtitle, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (countdown != null) {
                    Text(stringResource(R.string.player_up_next_in, countdown), style = MaterialTheme.typography.bodySmall)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onPlay) { Text(stringResource(R.string.player_play_now)) }
                    TextButton(onClick = onCancel) { Text(stringResource(R.string.action_cancel)) }
                }
            }
        }
    }
}

/** PGS/VobSub/DVB are bitmaps — the server cannot turn them into WebVTT. */
private val BITMAP_SUBS = setOf("hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "dvb_subtitle", "dvbsub", "xsub")

private fun buildVideoItem(context: Context, api: MmoApi, f: VideoFile, hls: Boolean, hlsStartSec: Long, audio: Int = 0): MediaItem {
    val subs = f.subtitleTracks.mapIndexedNotNull { ordinal, t ->
        if (t.codec.lowercase() in BITMAP_SUBS) return@mapIndexedNotNull null
        // The subs route maps to ffmpeg `0:s:<ordinal>`: the ordinal among subtitle streams, not the stream index.
        MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse(api.subtitleUrl(f.fileId, ordinal)))
            .setMimeType(MimeTypes.TEXT_VTT)
            .setLanguage(t.lang)
            .setLabel(t.title ?: t.lang ?: context.getString(R.string.player_subtitle_n, ordinal + 1))
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
