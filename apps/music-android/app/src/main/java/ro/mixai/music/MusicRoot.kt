package ro.mixai.music

import android.util.Log
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DownloadForOffline
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material.icons.outlined.LibraryMusic
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import ro.mixai.mobile.auth.SessionVault
import ro.mixai.mobile.onboarding.DiscoverScreen
import ro.mixai.mobile.onboarding.ManualServerScreen
import ro.mixai.mobile.onboarding.PairScreen
import ro.mixai.mobile.onboarding.SignInScreen
import ro.mixai.mobile.onboarding.WelcomeScreen
import ro.mixai.mobile.profiles.ProfilePickerScreen
import ro.mixai.music.downloads.DownloadsScreen
import ro.mixai.music.downloads.MusicDownloads
import ro.mixai.music.nav.Dest
import ro.mixai.music.nav.MusicNavigator
import ro.mixai.music.nav.Tab
import ro.mixai.music.ui.AlbumScreen
import ro.mixai.music.ui.ArtistScreen
import ro.mixai.music.ui.MiniPlayer
import ro.mixai.music.ui.MusicScreen
import ro.mixai.music.ui.MusicSearchScreen
import ro.mixai.music.ui.NowPlayingScreen
import ro.mixai.music.settings.SettingsScreen
import ro.mixai.tv.data.AccountSession
import ro.mixai.tv.data.Connection
import ro.mixai.tv.data.DiscoveredServer

private const val TAG = "MixaiMusic"

private data class TabSpec(val tab: Tab, val label: Int, val icon: ImageVector, val selectedIcon: ImageVector)

private val TABS = listOf(
    TabSpec(Tab.Home, R.string.tab_home, Icons.Outlined.LibraryMusic, Icons.Filled.LibraryMusic),
    TabSpec(Tab.Search, R.string.tab_search, Icons.Outlined.Search, Icons.Filled.Search),
    TabSpec(Tab.Downloads, R.string.tab_downloads, Icons.Outlined.DownloadForOffline, Icons.Filled.DownloadForOffline),
    TabSpec(Tab.Settings, R.string.tab_settings, Icons.Outlined.Settings, Icons.Filled.Settings),
)

/** Connection → graph → splash checks → onboarding or the tabbed music app. */
@Composable
fun MusicRoot(app: MixaiMusicApp, conn: Connection, session: AccountSession, localeTag: String, link: Dest?, onLinkConsumed: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val settings = app.settings
    val nav = remember { MusicNavigator(if (conn.isComplete) Dest.Splash else Dest.Welcome) }
    val graph = remember(conn.baseUrl, conn.token) { if (conn.isComplete) buildMusicGraph(context, conn, settings) else null }

    DisposableEffect(graph) {
        graph?.hub?.start()
        graph?.musicPlayback?.connect()
        graph?.outputs?.install()
        onDispose { graph?.hub?.stop(); graph?.musicPlayback?.release(); graph?.outputs?.release() }
    }

    // Splash: health → profile picker or Home. Unreachable server → discovery with it preselected.
    LaunchedEffect(graph, nav.current is Dest.Splash) {
        val g = graph ?: return@LaunchedEffect
        if (nav.current !is Dest.Splash) return@LaunchedEffect
        try { g.api.health() } catch (_: Exception) {
            nav.resetTo(Dest.Welcome, Dest.Discover(DiscoveredServer.fromBaseUrl(g.api.baseUrl)))
            return@LaunchedEffect
        }
        val picker = runCatching { g.profiles.needsPicker() }.getOrElse { Log.w(TAG, "profiles: ${it.message}"); false }
        g.hub.refreshHello()
        nav.resetTo(if (picker) Dest.ProfilePicker else Dest.TabRoot(Tab.Home))
    }

    // Deep link (TV handoff, widgets) on top of Home once startup settled.
    LaunchedEffect(link, graph, nav.current) {
        val l = link ?: return@LaunchedEffect
        if (graph == null || nav.current.isChromeless) return@LaunchedEffect
        when (l) {
            is Dest.TabRoot -> nav.selectTab(l.tab)
            is Dest.PlaySearch -> {
                val extras = android.os.Bundle().apply {
                    l.focus?.let { putString(android.provider.MediaStore.EXTRA_MEDIA_FOCUS, it) }
                    l.artist?.let { putString(android.provider.MediaStore.EXTRA_MEDIA_ARTIST, it) }
                    l.album?.let { putString(android.provider.MediaStore.EXTRA_MEDIA_ALBUM, it) }
                }
                graph.musicPlayback.playFromSearch(l.query, extras)
                nav.resetTo(Dest.TabRoot(Tab.Home), Dest.NowPlaying)
            }
            else -> nav.resetTo(Dest.TabRoot(Tab.Home), l)
        }
        onLinkConsumed()
    }

    fun changeServer() { scope.launch { settings.clear(); nav.resetTo(Dest.Welcome, Dest.Discover()) } }
    fun signOut() {
        scope.launch {
            app.vault.clear()
            settings.clearAll()
            nav.resetTo(Dest.Welcome)
        }
    }

    val current = nav.current
    val showChrome = graph != null && !current.isChromeless
    val music = graph?.musicPlayback?.state?.collectAsState()?.value

    // "Download upcoming tracks" (setting, 0 = off): keep the next N queue tracks offline while playing.
    val upcoming by app.musicSettings.upcoming.collectAsState(initial = 0)
    LaunchedEffect(music?.track?.id, upcoming) {
        val s = music ?: return@LaunchedEffect
        if (upcoming > 0 && s.track != null) MusicDownloads.prefetch(s.queue, s.index, upcoming)
    }

    NavigationSuiteScaffold(
        navigationSuiteItems = {
            TABS.forEach { t ->
                val selected = nav.currentTab == t.tab
                item(
                    selected = selected,
                    onClick = { nav.selectTab(t.tab) },
                    icon = { Icon(if (selected) t.selectedIcon else t.icon, contentDescription = null) },
                    label = { Text(stringResource(t.label)) },
                )
            }
        },
        layoutType = if (showChrome) NavigationSuiteScaffoldDefaults.calculateFromAdaptiveInfo(currentWindowAdaptiveInfo()) else NavigationSuiteType.None,
        containerColor = MaterialTheme.colorScheme.background,
    ) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) {
                NavDisplay(
                    backStack = nav.backStack,
                    onBack = { nav.pop() },
                    entryDecorators = listOf(rememberSaveableStateHolderNavEntryDecorator()),
                    transitionSpec = { (slideInHorizontally(tween(280)) { it / 4 } + fadeIn(tween(280))) togetherWith fadeOut(tween(180)) },
                    popTransitionSpec = { fadeIn(tween(220)) togetherWith (slideOutHorizontally(tween(260)) { it / 4 } + fadeOut(tween(220))) },
                    predictivePopTransitionSpec = { fadeIn(tween(220)) togetherWith (slideOutHorizontally(tween(260)) { it / 4 } + fadeOut(tween(220))) },
                    entryProvider = { dest ->
                        NavEntry(dest) {
                            Screen(dest, nav, graph, app, conn, session, localeTag, scope, onChangeServer = { changeServer() }, onSignOut = { signOut() })
                        }
                    },
                )
            }
            if (showChrome && graph != null && music?.isActive == true) MiniPlayer(graph, nav)
        }
    }
}

@Composable
private fun Screen(
    dest: Dest,
    nav: MusicNavigator,
    graph: MusicGraph?,
    app: MixaiMusicApp,
    conn: Connection,
    session: AccountSession,
    localeTag: String,
    scope: CoroutineScope,
    onChangeServer: () -> Unit,
    onSignOut: () -> Unit,
) {
    val settings = app.settings
    when (dest) {
        Dest.Welcome -> WelcomeScreen(
            appName = stringResource(R.string.app_name),
            tagline = stringResource(R.string.welcome_tagline),
            onSignIn = { nav.push(Dest.SignIn) },
            onLocal = { nav.push(Dest.Discover()) },
        )
        Dest.SignIn -> SignInScreen(
            onSignedIn = { body, picked ->
                scope.launch {
                    app.vault.save(body.session_token)
                    settings.saveSession(SessionVault.MARKER, body.user)
                    if (picked != null) { settings.save(picked.second, picked.first.token, body.user.id); nav.resetTo(Dest.Splash) }
                    else nav.resetTo(Dest.Welcome, Dest.Discover())
                }
            },
            onBack = { nav.pop() },
        )
        is Dest.Discover -> DiscoverScreen(
            preselected = dest.preselected,
            onSelect = { nav.push(Dest.Pair(it)) },
            onManual = { nav.push(Dest.Manual) },
            onBack = if (nav.backStack.size > 1) ({ nav.pop() }) else null,
        )
        is Dest.Pair -> PairScreen(
            server = dest.server,
            onPaired = { base, token, userId -> scope.launch { settings.save(base, token, userId); nav.resetTo(Dest.Splash) } },
            onBack = { nav.pop() },
        )
        Dest.Manual -> ManualServerScreen(
            onConnected = { base, token -> scope.launch { settings.save(base, token, ""); nav.resetTo(Dest.Splash) } },
            onQuickConnect = { nav.push(Dest.Pair(it)) },
            onBack = { nav.pop() },
        )
        else -> {
            val g = graph
            if (g == null) {
                LaunchedEffect(dest) { if (!conn.isComplete) nav.resetTo(Dest.Welcome) }
                Loading()
                return
            }
            when (dest) {
                Dest.Splash -> Loading()
                Dest.ProfilePicker -> ProfilePickerScreen(g.profiles, onSelected = { g.hub.refreshHello() }) {
                    if (nav.backStack.size > 1 && nav.backStack.none { it is Dest.Splash }) nav.pop() else nav.resetTo(Dest.TabRoot(Tab.Home))
                }
                is Dest.TabRoot -> when (dest.tab) {
                    Tab.Home -> MusicScreen(g, nav) { TabTitle(stringResource(R.string.tab_home)) }
                    Tab.Search -> MusicSearchScreen(g, nav) { TabTitle(stringResource(R.string.tab_search)) }
                    Tab.Downloads -> {
                        val cap by app.musicSettings.capGb.collectAsState(initial = 2)
                        DownloadsScreen(g, cap)
                    }
                    Tab.Settings -> SettingsScreen(
                        app = app, graph = g, conn = conn, session = session, localeTag = localeTag,
                        onProfiles = { nav.push(Dest.ProfilePicker) },
                        onSignIn = { nav.push(Dest.SignIn) },
                        onChangeServer = onChangeServer,
                        onSignOut = onSignOut,
                    )
                }
                is Dest.Album -> AlbumScreen(g, nav, dest.id)
                is Dest.Artist -> ArtistScreen(g, nav, dest.id)
                Dest.NowPlaying -> NowPlayingScreen(g, nav)
                Dest.Welcome, Dest.SignIn, Dest.Manual, is Dest.Discover, is Dest.Pair, is Dest.PlaySearch -> Unit
            }
        }
    }
}

@Composable
private fun TabTitle(title: String) {
    Row(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 20.dp, end = 16.dp, top = 12.dp, bottom = 8.dp)) {
        Text(title, style = MaterialTheme.typography.headlineLarge)
    }
}

@Composable
private fun Loading() {
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}
