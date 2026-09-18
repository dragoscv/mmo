package ro.mixai.tv

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.launch
import ro.mixai.tv.data.AccountSession
import ro.mixai.tv.data.Album
import ro.mixai.tv.data.Connection
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MediaRepository
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Progress
import ro.mixai.tv.data.ProgressSync
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.Show
import ro.mixai.tv.data.Song
import ro.mixai.tv.data.VideoFile
import ro.mixai.tv.data.WatchNext
import ro.mixai.tv.player.PlayRequest
import ro.mixai.tv.player.PlayerScreen
import ro.mixai.tv.ui.AlbumScreen
import ro.mixai.tv.ui.ConnectScreen
import ro.mixai.tv.ui.DiscoverScreen
import ro.mixai.tv.ui.HomeScreen
import ro.mixai.tv.ui.MovieScreen
import ro.mixai.tv.ui.PairScreen
import ro.mixai.tv.ui.SettingsScreen
import ro.mixai.tv.ui.ShowScreen
import ro.mixai.tv.ui.SignInScreen
import ro.mixai.tv.ui.TitleScreen
import ro.mixai.tv.ui.WelcomeScreen
import ro.mixai.tv.ui.theme.MixaiTheme
import java.net.URI
import java.util.Locale

sealed interface Screen {
    /** First run: MixAI account vs. local server. */
    data object Welcome : Screen
    /** Device-code sign-in on mixai.ro. */
    data object SignIn : Screen
    /** LAN autodiscovery; `preselected` = the saved server whose health check failed. */
    data class Discover(val preselected: DiscoveredServer? = null) : Screen
    data class Pair(val server: DiscoveredServer) : Screen
    /** Manual host + token fallback. */
    data object Connect : Screen
    data object Home : Screen
    data object Settings : Screen
    data class Movie(val file: VideoFile) : Screen
    data class ShowDetail(val show: Show) : Screen
    data class AlbumDetail(val album: Album) : Screen
    /** `resumeMs` > 0 overrides the local DataStore position (server progress from the title page). */
    data class Play(val request: PlayRequest, val resumeMs: Long = -1L) : Screen
    /** Unified TMDB title page (`/media/title/:kind/:tmdbId`). */
    data class Title(val kind: String, val tmdbId: Long) : Screen
}

class MainActivity : ComponentActivity() {
    /** Pending `mixai://title/<kind>/<tmdbId>` from Watch Next; consumed by `App`. */
    private val deepLink = mutableStateOf<Pair<String, Long>?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        deepLink.value = WatchNext.parseDeepLink(intent)
        val settings = (application as MixaiApp).settings
        setContent {
            val localeTag by settings.locale.collectAsState(initial = "")
            LocalizedContent(localeTag) {
                MixaiTheme {
                    val conn by settings.connection.collectAsState(initial = null)
                    val session by settings.session.collectAsState(initial = null)
                    val progress by settings.progress.collectAsState(initial = emptyMap())
                    val c = conn ?: return@MixaiTheme
                    val s = session ?: return@MixaiTheme
                    val link by deepLink
                    App(
                        c, s, progress, settings, localeTag,
                        deepLink = link,
                        onDeepLinkConsumed = { deepLink.value = null },
                        onSave = { host, token, userId -> settings.save(host, token, userId) },
                        onSaveSession = { tok, user -> settings.saveSession(tok, user) },
                        onForget = { settings.clear() },
                        onSignOut = { settings.clearAll() },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        WatchNext.parseDeepLink(intent)?.let { deepLink.value = it }
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

@Composable
private fun App(
    conn: Connection,
    session: AccountSession,
    progress: Map<String, Progress>,
    settings: Settings,
    localeTag: String,
    deepLink: Pair<String, Long>?,
    onDeepLinkConsumed: () -> Unit,
    onSave: suspend (String, String, String) -> Unit,
    onSaveSession: suspend (String, ro.mixai.tv.data.SessionUser) -> Unit,
    onForget: suspend () -> Unit,
    onSignOut: suspend () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val stack = remember { mutableStateListOf<Screen>(if (conn.isComplete) Screen.Home else Screen.Welcome) }
    val api = remember(conn.baseUrl, conn.token) { if (conn.isComplete) MmoApi(conn.baseUrl, conn.token) else null }
    val media = remember(api) { api?.let { MediaRepository(it) } }
    val progressSync = remember(media) { media?.let { ProgressSync(it, settings) } }
    val context = LocalContext.current

    fun push(s: Screen) = stack.add(s)
    fun pop() { if (stack.size > 1) stack.removeAt(stack.lastIndex) }
    fun goHome() { stack.clear(); stack.add(Screen.Home) }
    fun goWelcome() { stack.clear(); stack.add(Screen.Welcome) }
    fun changeServer() { scope.launch { onForget(); stack.clear(); stack.add(Screen.Welcome); stack.add(Screen.Discover()) } }
    fun signOut() { scope.launch { onSignOut(); goWelcome() } }

    BackHandler(enabled = stack.size > 1) { pop() }

    // Watch Next deep link → title page on top of Home.
    LaunchedEffect(deepLink, api) {
        val l = deepLink ?: return@LaunchedEffect
        if (api == null) return@LaunchedEffect
        if (stack.lastOrNull() != Screen.Home) { stack.clear(); stack.add(Screen.Home) }
        stack.add(Screen.Title(l.first, l.second))
        onDeepLinkConsumed()
    }

    // One-shot legacy progress migration + queued writes flush, once a media-capable server answers.
    LaunchedEffect(progressSync) {
        val ps = progressSync ?: return@LaunchedEffect
        val m = media ?: return@LaunchedEffect
        runCatching { if (m.status() != null) ps.migrateLegacyOnce() }
    }

    // Saved server: skip to Home, but if it no longer answers /health fall back
    // to discovery with that server preselected.
    LaunchedEffect(api) {
        val a = api ?: return@LaunchedEffect
        if (stack.lastOrNull() != Screen.Home) return@LaunchedEffect
        try { a.health() } catch (_: Exception) {
            val u = runCatching { URI(a.baseUrl) }.getOrNull()
            val saved = u?.host?.let { DiscoveredServer(it, if (u.port > 0) u.port else 17899, "") }
            stack.clear(); stack.add(Screen.Discover(saved))
        }
    }

    when (val top = stack.last()) {
        Screen.Welcome -> WelcomeScreen(
            onSignIn = { push(Screen.SignIn) },
            onLocal = { push(Screen.Discover()) },
        )
        Screen.SignIn -> SignInScreen(
            onSignedIn = { body, picked ->
                scope.launch {
                    onSaveSession(body.session_token, body.user)
                    if (picked != null) { onSave(picked.second, picked.first.token, body.user.id); goHome() }
                    else { stack.clear(); stack.add(Screen.Welcome); stack.add(Screen.Discover()) }
                }
            },
            onBack = { pop() },
        )
        is Screen.Discover -> DiscoverScreen(
            preselected = top.preselected,
            onSelect = { push(Screen.Pair(it)) },
            onManual = { push(Screen.Connect) },
        )
        is Screen.Pair -> PairScreen(
            server = top.server,
            onPaired = { base, token, userId -> scope.launch { onSave(base, token, userId); goHome() } },
            onBack = { pop() },
        )
        Screen.Connect -> ConnectScreen(
            initialHost = conn.baseUrl,
            initialToken = conn.token,
            onConnected = { host, token ->
                scope.launch { onSave(host, token, ""); goHome() }
            },
            onQuickConnect = { push(Screen.Pair(it)) },
        )
        Screen.Home -> {
            val a = api ?: run { goWelcome(); return }
            HomeScreen(
                api = a,
                media = media!!,
                progress = progress,
                userName = if (session.isSignedIn) session.displayName else null,
                onMovie = { push(Screen.Movie(it)) },
                onShow = { push(Screen.ShowDetail(it)) },
                onAlbum = { push(Screen.AlbumDetail(it)) },
                onTitle = { push(Screen.Title(it.kind, it.tmdbId)) },
                onSettings = { push(Screen.Settings) },
                onMediaHome = { home ->
                    val cont = home.rows.firstOrNull { it.id == MediaRepository.ROW_CONTINUE }?.items.orEmpty()
                    scope.launch { WatchNext.publish(context, cont) { c -> a.tmdbImageUrl("w342", c.posterPath) } }
                },
            )
        }
        is Screen.Title -> TitleScreen(
            api = api!!,
            media = media!!,
            progressSync = progressSync!!,
            kind = top.kind,
            tmdbId = top.tmdbId,
            onPlay = { req, ref, resumeMs ->
                val r = (req as PlayRequest.Video).copy(ref = ref)
                push(Screen.Play(r, resumeMs))
            },
            onOpenTitle = { k, id -> push(Screen.Title(k, id)) },
            onBack = { pop() },
        )
        Screen.Settings -> SettingsScreen(
            api = api!!,
            localeTag = localeTag,
            signedInAs = if (session.isSignedIn) session.displayName else null,
            onLocale = { tag -> scope.launch { settings.setLocale(tag) } },
            onClearProgress = { scope.launch { settings.clearProgress() } },
            onChangeServer = { changeServer() },
            onSignOut = if (session.isSignedIn) ({ signOut() }) else null,
            onBack = { pop() },
        )
        is Screen.Movie -> MovieScreen(
            api = api!!,
            file = top.file,
            progress = progress[top.file.fileId],
            onPlay = { push(Screen.Play(it)) },
            onBack = { pop() },
        )
        is Screen.ShowDetail -> ShowScreen(
            api = api!!,
            show = top.show,
            progress = progress,
            onPlay = { push(Screen.Play(it)) },
            onBack = { pop() },
        )
        is Screen.AlbumDetail -> AlbumScreen(
            api = api!!,
            album = top.album,
            onPlay = { songs: List<Song>, start: Int -> push(Screen.Play(PlayRequest.Music(songs, start))) },
            onBack = { pop() },
        )
        is Screen.Play -> PlayerScreen(
            api = api!!,
            request = top.request,
            resumeMs = (top.request as? PlayRequest.Video)?.let { r ->
                when {
                    r.fromStart -> 0L
                    top.resumeMs >= 0 -> top.resumeMs
                    else -> progress[r.file.fileId]?.pos ?: 0L
                }
            } ?: 0L,
            onProgress = { fileId, pos, dur -> scope.launch { settings.saveProgress(fileId, pos, dur) } },
            onServerProgress = { ref: MediaRef, pos, dur -> progressSync?.let { ps -> scope.launch { ps.save(ref, pos, dur) } } },
            onExit = { pop() },
        )
    }
}
