package ro.mixai.tv

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import ro.mixai.tv.data.AccountSession
import ro.mixai.tv.data.Connection
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.HubClient
import ro.mixai.tv.data.HubCommand
import ro.mixai.tv.data.RepeatMode
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import ro.mixai.tv.data.LiveTvRepository
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MediaRepository
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.MusicHandoff
import ro.mixai.tv.data.MusicPlayback
import ro.mixai.tv.data.MusicRepository
import ro.mixai.tv.data.PlayerBus
import ro.mixai.tv.data.PlayerCommand
import ro.mixai.tv.data.ProfileRepository
import ro.mixai.tv.data.Progress
import ro.mixai.tv.data.ProgressSync
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.WatchNext
import ro.mixai.tv.data.argDouble
import ro.mixai.tv.data.argLong
import ro.mixai.tv.data.argString
import ro.mixai.tv.player.PlayRequest
import ro.mixai.tv.player.PlayerScreen
import ro.mixai.tv.ui.ConnectScreen
import ro.mixai.tv.ui.DiscoverScreen
import ro.mixai.tv.ui.LocalSqueeze
import ro.mixai.tv.ui.PairScreen
import ro.mixai.tv.ui.ScreenFormat
import ro.mixai.tv.ui.SignInScreen
import ro.mixai.tv.ui.SqueezeBox
import ro.mixai.tv.ui.WelcomeScreen
import ro.mixai.tv.ui.components.BackdropHost
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.LocalReducedMotion
import ro.mixai.tv.ui.components.reducedMotionFor
import ro.mixai.tv.ui.components.systemReducedMotion
import ro.mixai.tv.ui.detectPanelAspect
import ro.mixai.tv.ui.home.HomeScreen
import ro.mixai.tv.ui.library.LibraryScreen
import ro.mixai.tv.ui.livetv.GuideScreen
import ro.mixai.tv.ui.livetv.LiveTvPlayerScreen
import ro.mixai.tv.ui.livetv.LiveTvScreen
import ro.mixai.tv.ui.livetv.RecordingsScreen
import ro.mixai.tv.ui.music.ArtistScreen
import ro.mixai.tv.ui.music.MusicAlbumScreen
import ro.mixai.tv.ui.music.MusicScreen
import ro.mixai.tv.ui.music.NowPlayingScreen
import ro.mixai.tv.ui.nav.AppShell
import ro.mixai.tv.ui.nav.LocalScreenDeps
import ro.mixai.tv.ui.nav.NavHost
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.profiles.ProfilePickerScreen
import ro.mixai.tv.ui.search.SearchScreen
import ro.mixai.tv.ui.settings.SettingsScreen
import ro.mixai.tv.ui.settings.StatsScreen
import ro.mixai.tv.ui.squeezeFor
import ro.mixai.tv.ui.theme.MixaiTheme
import ro.mixai.tv.ui.title.SeasonScreen
import ro.mixai.tv.ui.title.TitleScreen
import ro.mixai.tv.ui.together.WatchTogetherScreen
import java.util.Locale

private const val TAG = "MainActivity"

class MainActivity : ComponentActivity() {
    /** Pending `mixai://title/<kind>/<tmdbId>` from Watch Next; consumed by `App`. */
    private val deepLink = mutableStateOf<Pair<String, Long>?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        deepLink.value = WatchNext.parseDeepLink(intent)
        val settings = (application as MixaiApp).settings
        val detectedAspect = detectPanelAspect(this)
        setContent {
            val localeTag by settings.locale.collectAsState(initial = "")
            val formatKey by settings.screenFormat.collectAsState(initial = "auto")
            val squeeze = squeezeFor(ScreenFormat.of(formatKey), detectedAspect)
            LocalizedContent(localeTag) {
                MixaiTheme {
                    CompositionLocalProvider(LocalSqueeze provides squeeze) {
                        SqueezeBox(squeeze) {
                            val conn by settings.connection.collectAsState(initial = null)
                            val session by settings.session.collectAsState(initial = null)
                            val c = conn ?: return@SqueezeBox
                            val s = session ?: return@SqueezeBox
                            val link by deepLink
                            App(c, s, settings, localeTag, deepLink = link, onDeepLinkConsumed = { deepLink.value = null })
                            // BackdropHost now paints an opaque base: the window background is one
                            // extra full-screen fill per frame on the TV GPU, so drop it once we draw.
                            androidx.compose.runtime.LaunchedEffect(Unit) {
                                androidx.compose.runtime.withFrameNanos { }
                                window.setBackgroundDrawable(null)
                            }
                            // Brand signature: once per cold start, after the first frame is on screen.
                            LaunchedEffect(Unit) {
                                androidx.compose.runtime.withFrameNanos { }
                                BrandSound.playAtStart(this@MainActivity, settings.startupSound.first())
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        WatchNext.parseDeepLink(intent)?.let { deepLink.value = it }
    }

    /** Any remote key pauses the ambient backdrop motion (it resumes after a short idle). */
    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
        ro.mixai.tv.ui.components.AmbientMotion.poke()
        return super.dispatchKeyEvent(event)
    }
}

/**
 * Locale override ("" = system). Wraps the tree in a context whose configuration carries the
 * chosen locale so `stringResource` resolves `values-ro`/`values`; `key(tag)` recomposes everything.
 */
@Composable
private fun LocalizedContent(tag: String, content: @Composable () -> Unit) {
    val base = LocalContext.current
    val baseConfig = LocalConfiguration.current
    if (tag.isBlank()) {
        content()
        return
    }
    val locale = remember(tag) { Locale.forLanguageTag(tag) }
    val ctx: Context = remember(tag, base, baseConfig) {
        Locale.setDefault(locale)
        val cfg = Configuration(baseConfig).apply { setLocale(locale) }
        base.createConfigurationContext(cfg)
    }
    key(tag) {
        CompositionLocalProvider(LocalContext provides ctx, LocalConfiguration provides ctx.resources.configuration) {
            content()
        }
    }
}

/** Long-lived objects of one server connection (rebuilt when base URL / token change). */
private class ConnectionGraph(
    val api: MmoApi,
    val profiles: ProfileRepository,
    val media: MediaRepository,
    val music: MusicRepository,
    val musicPlayback: MusicPlayback,
    val liveTv: LiveTvRepository,
    val hub: HubClient,
    val progressSync: ProgressSync,
)

private fun buildGraph(context: Context, conn: Connection, settings: Settings): ConnectionGraph {
    val api = MmoApi(conn.baseUrl, conn.token)
    val profiles = ProfileRepository(api, settings)
    val profileId = { profiles.activeId }
    val media = MediaRepository(api, profileId, context.cacheDir)
    val music = MusicRepository(api, profileId)
    val musicPlayback = MusicPlayback(context.applicationContext, music, media)
    // `music` cap (WP17-41h): phones can send their queue here; the TV reports what it plays.
    val hub = HubClient(api, settings, { profiles.activeProfile.value?.id }, extraCaps = listOf("music"))
    hub.musicNowPlaying = musicPlayback.hubNowPlaying
    return ConnectionGraph(
        api = api,
        profiles = profiles,
        media = media,
        music = music,
        musicPlayback = musicPlayback,
        liveTv = LiveTvRepository(api, profileId),
        hub = hub,
        progressSync = ProgressSync(media, settings),
    )
}

@Composable
private fun App(
    conn: Connection,
    session: AccountSession,
    settings: Settings,
    localeTag: String,
    deepLink: Pair<String, Long>?,
    onDeepLinkConsumed: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val nav = remember { Navigator(if (conn.isComplete) Route.Splash else Route.Welcome) }
    val progress by settings.progress.collectAsState(initial = emptyMap())

    val graph = remember(conn.baseUrl, conn.token) { if (conn.isComplete) buildGraph(context, conn, settings) else null }
    DisposableEffect(graph) {
        graph?.hub?.start()
        onDispose { graph?.hub?.stop(); graph?.musicPlayback?.release() }
    }

    fun changeServer() { scope.launch { settings.clear(); nav.resetTo(Route.Welcome, Route.Discover()) } }
    fun signOut() { scope.launch { settings.clearAll(); nav.resetTo(Route.Welcome) } }
    val signedIn = session.isSignedIn

    val deps = remember(graph, localeTag, session) {
        graph?.let { g ->
            ScreenDeps(
                api = g.api, media = g.media, profiles = g.profiles, music = g.music, musicPlayback = g.musicPlayback,
                liveTv = g.liveTv, hub = g.hub, settings = settings, progressSync = g.progressSync,
                localeTag = localeTag, session = session, scope = scope,
                onChangeServer = { changeServer() },
                onSignOut = if (signedIn) ({ signOut() }) else null,
            )
        }
    }

    // Splash: health check → legacy migration → profile picker or Home. A saved server that no
    // longer answers /health falls back to discovery with that server preselected.
    LaunchedEffect(deps, nav.current is Route.Splash) {
        val d = deps ?: return@LaunchedEffect
        if (nav.current !is Route.Splash) return@LaunchedEffect
        try { d.api.health() } catch (_: Exception) {
            val saved = DiscoveredServer.fromBaseUrl(d.api.baseUrl)
            nav.resetTo(Route.Discover(saved))
            return@LaunchedEffect
        }
        launch { runCatching { if (d.media.status() != null) d.progressSync.migrateLegacyOnce() } }
        val picker = runCatching { d.profiles.needsPicker() }.getOrElse { Log.w(TAG, "profiles: ${it.message}"); false }
        d.hub.refreshHello()
        nav.resetTo(if (picker) Route.ProfilePicker else Route.Home)
    }

    // Watch Next deep link → title page on top of Home (once startup has settled).
    LaunchedEffect(deepLink, deps, nav.current) {
        val l = deepLink ?: return@LaunchedEffect
        if (deps == null) return@LaunchedEffect
        val cur = nav.current
        if (cur is Route.Splash || cur is Route.ProfilePicker || cur.hidesOnboarding()) return@LaunchedEffect
        nav.resetTo(Route.Home, Route.Title(l.first, l.second))
        onDeepLinkConsumed()
    }

    // Publish the server `continue` row into the Android TV Watch Next channel (per active profile).
    val activeId = graph?.profiles?.activeProfile?.collectAsState()?.value?.id
    LaunchedEffect(graph, activeId) {
        val g = graph ?: return@LaunchedEffect
        if (activeId == null) return@LaunchedEffect
        runCatching {
            g.media.homeFlow().map { h -> h.rows.firstOrNull { it.id == MediaRepository.ROW_CONTINUE }?.items.orEmpty() }
                .distinctUntilChanged()
                .collect { cont -> WatchNext.publish(context, cont) { c -> g.api.tmdbImageUrl(TmdbSize.poster(342), c.posterPath) } }
        }.onFailure { Log.w(TAG, "watch next: ${it.message}") }
    }

    // Remote control from the hub (phone/web → this TV).
    LaunchedEffect(deps) {
        val d = deps ?: return@LaunchedEffect
        d.hub.incomingCommands.collect { cmd -> handleHubCommand(context, d, nav, cmd, scope) }
    }

    // Reduced motion: the active profile's choice, else Android's animator scale (read per launch).
    val activeProfile = graph?.profiles?.activeProfile?.collectAsState()?.value
    val systemReduced = remember { systemReducedMotion(context) }
    val reducedMotion = reducedMotionFor(activeProfile, systemReduced)

    CompositionLocalProvider(LocalScreenDeps provides deps, LocalReducedMotion provides reducedMotion) {
        BackdropHost {
            AppShell(
                nav = nav,
                settings = settings,
                activeProfile = activeProfile,
                musicPlayback = graph?.musicPlayback,
                music = graph?.music,
            ) {
                NavHost(nav, Modifier.fillMaxSize()) { route ->
                    Screen(route, nav, deps, conn, settings, progress, scope)
                }
            }
        }
    }
}

private fun Route.hidesOnboarding(): Boolean =
    this is Route.Welcome || this is Route.SignIn || this is Route.Discover || this is Route.Pair || this is Route.Connect

/** Route → screen. Onboarding routes work without a connection; the rest need [deps]. */
@Composable
private fun Screen(
    route: Route,
    nav: Navigator,
    deps: ScreenDeps?,
    conn: Connection,
    settings: Settings,
    progress: Map<String, Progress>,
    scope: CoroutineScope,
) {
    when (route) {
        Route.Welcome -> WelcomeScreen(onSignIn = { nav.push(Route.SignIn) }, onLocal = { nav.push(Route.Discover()) })
        Route.SignIn -> SignInScreen(
            onSignedIn = { body, picked ->
                scope.launch {
                    settings.saveSession(body.session_token, body.user)
                    if (picked != null) { settings.save(picked.second, picked.first.token, body.user.id); nav.resetTo(Route.Splash) }
                    else nav.resetTo(Route.Welcome, Route.Discover())
                }
            },
            onBack = { nav.pop() },
        )
        is Route.Discover -> DiscoverScreen(preselected = route.preselected, onSelect = { nav.push(Route.Pair(it)) }, onManual = { nav.push(Route.Connect) })
        is Route.Pair -> PairScreen(
            server = route.server,
            onPaired = { base, token, userId -> scope.launch { settings.save(base, token, userId); nav.resetTo(Route.Splash) } },
            onBack = { nav.pop() },
        )
        Route.Connect -> ConnectScreen(
            initialHost = conn.baseUrl,
            initialToken = conn.token,
            onConnected = { host, token -> scope.launch { settings.save(host, token, ""); nav.resetTo(Route.Splash) } },
            onQuickConnect = { nav.push(Route.Pair(it)) },
        )
        else -> {
            val d = deps
            if (d == null) {
                // Connection forgotten (change server / sign out) or not loaded yet.
                LaunchedEffect(route) { if (!conn.isComplete) nav.resetTo(Route.Welcome) }
                Box(Modifier.fillMaxSize()) { LoadingState(rows = 1) }
                return
            }
            ConnectedScreen(route, nav, d, progress)
        }
    }
}

@Composable
private fun ConnectedScreen(route: Route, nav: Navigator, d: ScreenDeps, progress: Map<String, Progress>) {
    when (route) {
        Route.Splash -> Box(Modifier.fillMaxSize()) { LoadingState(rows = 2) }
        Route.ProfilePicker -> ProfilePickerScreen(d, nav)
        Route.Home -> HomeScreen(d, nav)
        is Route.Search -> SearchScreen(d, nav, route.initial)
        is Route.Library -> LibraryScreen(d, nav, route.kind)
        Route.Music -> MusicScreen(d, nav)
        Route.LiveTv -> LiveTvScreen(d, nav)
        is Route.Settings -> SettingsScreen(d, nav, route.section)
        is Route.Title -> TitleScreen(d, nav, route.kind, route.tmdbId)
        is Route.Season -> SeasonScreen(d, nav, route.tmdbId, route.season)
        is Route.Artist -> ArtistScreen(d, nav, route.id)
        is Route.Album -> MusicAlbumScreen(d, nav, route.id)
        Route.NowPlaying -> NowPlayingScreen(d, nav)
        Route.Guide -> GuideScreen(d, nav)
        Route.Recordings -> RecordingsScreen(d, nav)
        Route.Stats -> StatsScreen(d, nav)
        is Route.WatchTogether -> WatchTogetherScreen(d, nav, route.roomId)
        is Route.LivePlay -> LiveTvPlayerScreen(d, nav, route.channelId)
        is Route.Play -> {
            val resumeMs = (route.request as? PlayRequest.Video)?.let { r ->
                when {
                    r.fromStart -> 0L
                    route.resumeMs >= 0 -> route.resumeMs
                    else -> progress[r.file.fileId]?.pos ?: 0L
                }
            } ?: 0L
            PlayerScreen(d, nav, route.request, resumeMs)
        }
        // Onboarding routes are handled by Screen().
        Route.Welcome, Route.SignIn, Route.Connect, is Route.Discover, is Route.Pair -> Unit
    }
}

/**
 * Hub `play {trackIds,index,positionSec,shuffle,repeat}` (WP17-41h): a phone or the web music player sends its
 * queue; it plays in the TV's background music (own crossfade / normalisation). A video on screen is stopped
 * first; Now Playing opens.
 *
 * Shared arg shape (devices advertising the `music` cap):
 *
 *   { trackIds: string[]   Subsonic track ids (`tr_<n>`), ≤ 2000, in play order
 *     index: number        position of the track to start with in `trackIds`
 *     positionSec: number  where to start inside that track
 *     shuffle: boolean     true = shuffle the list here
 *     repeat: "off" | "all" | "one" }
 *
 * Senders: web music "Play on TV" (`apps/web/src/components/mmo/music/send-to-tv.ts`), MixAI Music Android
 * (`cast/Transports.kt` `HubTvTransport.load`), MixAI Music iOS (`MusicAppModel.handoff`). The same names are read
 * by tv-tizen `src/lib/music-remote.ts` `parseMusicPlayArgs` — change all sides together.
 */
private fun playMusicQueue(d: ScreenDeps, nav: Navigator, cmd: HubCommand, ids: List<String>, scope: CoroutineScope) {
    val hub = d.hub
    if (ids.isEmpty()) { hub.ack(cmd.seq, false, "trackIds_required"); return }
    if (PlayerBus.hasPlayer) PlayerBus.send(PlayerCommand.Stop)
    scope.launch {
        try {
            val n = d.musicPlayback.playIds(
                ids.take(2000),
                index = (cmd.args.argLong("index") ?: 0L).toInt().coerceIn(0, ids.lastIndex),
                positionMs = ((cmd.args.argDouble("positionSec") ?: 0.0) * 1000).toLong().coerceAtLeast(0),
                shuffle = (cmd.args["shuffle"] as? kotlinx.serialization.json.JsonPrimitive)?.booleanOrNull,
                repeat = RepeatMode.of(cmd.args.argString("repeat")),
            )
            if (n == 0) { hub.ack(cmd.seq, false, "tracks_not_found"); return@launch }
            if (nav.current != Route.NowPlaying) nav.push(Route.NowPlaying)
            hub.ack(cmd.seq, true)
        } catch (e: Exception) {
            hub.ack(cmd.seq, false, e.message ?: "play_failed")
        }
    }
}

/**
 * Hub `cmd` actions (server/openapi.yaml `/hub/command`): play, pause, resume, seek, stop, next,
 * previous, text, navigate. Transport goes to the on-screen player (PlayerBus) or, when only
 * music is playing, to background music. Every command is acked.
 */
private fun handleHubCommand(context: Context, d: ScreenDeps, nav: Navigator, cmd: HubCommand, scope: CoroutineScope) {
    val hub = d.hub
    val music = d.musicPlayback
    val musicActive = music.state.value.isActive
    fun transport(player: PlayerCommand, onMusic: () -> Unit) {
        when {
            PlayerBus.hasPlayer -> { PlayerBus.send(player); hub.ack(cmd.seq, true) }
            musicActive -> { onMusic(); hub.ack(cmd.seq, true) }
            else -> hub.ack(cmd.seq, false, "no_player")
        }
    }
    when (cmd.action) {
        "play" -> {
            val trackIds = (cmd.args["trackIds"] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank) }
            if (trackIds != null) { playMusicQueue(d, nav, cmd, trackIds, scope); return }
            val fileId = cmd.args.argString("fileId")
            if (fileId == null) { transport(PlayerCommand.Resume) { music.resume() }; return }
            scope.launch {
                try {
                    val f = d.api.fileInfo(fileId)
                    val kind = cmd.args.argString("kind")
                    val tmdbId = cmd.args.argLong("tmdbId")
                    val ref = if (kind != null && tmdbId != null) MediaRef(kind, tmdbId, cmd.args.argLong("season"), cmd.args.argLong("episode")) else null
                    val startMs = cmd.args.argDouble("startSec")?.let { (it * 1000).toLong() } ?: -1L
                    val video = PlayRequest.Video(f, hls = !f.directPlayable, ref = ref)
                    when (val cur = nav.current) {
                        // Already playing: same player entry, new media (reuses ExoPlayer + MediaSession).
                        is Route.Play -> nav.replaceInPlace(Route.Play(video, resumeMs = startMs, from = cur.from))
                        is Route.LivePlay -> nav.replace(Route.Play(video, resumeMs = startMs, from = cur))
                        else -> nav.push(Route.Play(video, resumeMs = startMs, from = cur))
                    }
                    hub.ack(cmd.seq, true)
                } catch (e: Exception) {
                    hub.ack(cmd.seq, false, e.message ?: "play_failed")
                }
            }
        }
        "pause" -> transport(PlayerCommand.Pause) { music.pause() }
        "resume" -> transport(PlayerCommand.Resume) { music.resume() }
        "seek" -> {
            val pos = cmd.args.argDouble("positionSec")
            if (pos == null) hub.ack(cmd.seq, false, "positionSec required")
            else transport(PlayerCommand.Seek(pos)) { music.seek((pos * 1000).toLong()) }
        }
        "stop" -> transport(PlayerCommand.Stop) { music.stop() }
        "next" -> transport(PlayerCommand.Next) { music.next() }
        "previous" -> transport(PlayerCommand.Previous) { music.prev() }
        "text" -> {
            val v = cmd.args.argString("value") ?: ""
            if (nav.current is Route.Search) nav.replace(Route.Search(v)) else nav.push(Route.Search(v))
            hub.ack(cmd.seq, true)
        }
        "navigate" -> {
            val target = when (cmd.args.argString("to")) {
                "home" -> Route.Home
                "music" -> Route.Music
                "livetv" -> Route.LiveTv
                "settings" -> Route.Settings()
                "search" -> Route.Search()
                "movies" -> Route.Library("movie")
                "shows" -> Route.Library("tv")
                else -> null
            }
            if (target == null) hub.ack(cmd.seq, false, "unknown_target")
            else if (target == Route.Music && MusicHandoff.openFromTv(context, d.musicPlayback)) hub.ack(cmd.seq, true)
            else {
                if (target == Route.Home) nav.resetTo(Route.Home) else nav.resetTo(Route.Home, target)
                hub.ack(cmd.seq, true)
            }
        }
        else -> hub.ack(cmd.seq, false, "unsupported")
    }
}
