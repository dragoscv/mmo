package ro.mixai.app

import android.util.Log
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LiveTv
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.LiveTv
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.VideoLibrary
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import android.widget.Toast
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import kotlinx.coroutines.launch
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.app.nav.Tab
import ro.mixai.app.ui.components.LocalSharedTransitionScope
import ro.mixai.app.ui.home.HomeScreen
import ro.mixai.app.ui.library.LibraryScreen
import ro.mixai.app.ui.live.LivePlayerScreen
import ro.mixai.app.ui.live.LiveScreen
import ro.mixai.music.ui.AlbumScreen
import ro.mixai.music.ui.ArtistScreen
import ro.mixai.music.ui.MiniPlayer
import ro.mixai.music.ui.MusicScreen
import ro.mixai.music.ui.NowPlayingScreen
import ro.mixai.app.ui.components.TabHeader
import ro.mixai.mobile.onboarding.DiscoverScreen
import ro.mixai.mobile.onboarding.ManualServerScreen
import ro.mixai.mobile.onboarding.PairScreen
import ro.mixai.mobile.onboarding.SignInScreen
import ro.mixai.mobile.onboarding.WelcomeScreen
import ro.mixai.app.ui.player.PlayerScreen
import ro.mixai.mobile.profiles.ProfilePickerScreen
import ro.mixai.app.ui.search.SearchScreen
import ro.mixai.app.ui.settings.SettingsScreen
import ro.mixai.app.ui.title.TitleScreen
import ro.mixai.app.push.PushRegistrar
import ro.mixai.app.ui.downloads.DownloadsScreen
import ro.mixai.app.ui.family.FamilyStatsScreen
import ro.mixai.app.ui.settings.PlexImportScreen
import ro.mixai.app.ui.remote.RemoteScreen
import ro.mixai.app.ui.together.TogetherScreen
import ro.mixai.mobile.auth.SessionVault
import ro.mixai.tv.data.AccountSession
import ro.mixai.tv.data.Connection
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.Settings

private const val TAG = "MixaiPhone"

private data class TabSpec(val tab: Tab, val label: Int, val icon: ImageVector, val selectedIcon: ImageVector)

private val TABS = listOf(
    TabSpec(Tab.Home, R.string.tab_home, Icons.Outlined.Home, Icons.Filled.Home),
    TabSpec(Tab.Search, R.string.tab_search, Icons.Outlined.Search, Icons.Filled.Search),
    TabSpec(Tab.Library, R.string.tab_library, Icons.Outlined.VideoLibrary, Icons.Filled.VideoLibrary),
    TabSpec(Tab.Music, R.string.tab_music, Icons.Outlined.MusicNote, Icons.Filled.MusicNote),
    TabSpec(Tab.Live, R.string.tab_live, Icons.Outlined.LiveTv, Icons.Filled.LiveTv),
)

/** Connection → graph → splash checks → onboarding or the tabbed app. */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun AppRoot(conn: Connection, session: AccountSession, settings: Settings, localeTag: String, deepLink: Pair<String, Long>?, onDeepLinkConsumed: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val nav = remember { Navigator(if (conn.isComplete) Dest.Splash else Dest.Welcome) }
    var pairToApprove by remember { mutableStateOf<PairLink?>(null) }

    val graph = remember(conn.baseUrl, conn.token) { if (conn.isComplete) buildGraph(context, conn, settings) else null }
    val app = context.applicationContext as MixaiPhoneApp
    DisposableEffect(graph) {
        graph?.hub?.start()
        graph?.musicPlayback?.connect()
        graph?.let { app.progressFlusher.attach(it.media, settings) }
        graph?.outputs?.install()
        onDispose { graph?.hub?.stop(); graph?.musicPlayback?.release(); graph?.outputs?.release(); app.progressFlusher.detach() }
    }
    // Push token registration after sign-in / pairing (skipped without a MixAI account session).
    LaunchedEffect(session.userId, conn.baseUrl) { PushRegistrar.sync(context) }

    fun changeServer() { scope.launch { settings.clear(); nav.resetTo(Dest.Welcome, Dest.Discover()) } }
    fun signOut() {
        scope.launch {
            PushRegistrar.unregister(context)
            app.phone.vault.clear()
            settings.clearAll()
            nav.resetTo(Dest.Welcome)
        }
    }

    val deps = remember(graph, localeTag, session) {
        graph?.let { g ->
            AppDeps(
                api = g.api, media = g.media, profiles = g.profiles, music = g.music, musicPlayback = g.musicPlayback,
                liveTv = g.liveTv, hub = g.hub, settings = settings, progressSync = g.progressSync,
                phoneApi = g.phoneApi, phone = app.phone,
                localeTag = localeTag, session = session, scope = scope, outputs = g.outputs,
                onChangeServer = { changeServer() },
                onSignOut = if (session.isSignedIn) ({ signOut() }) else null,
            )
        }
    }

    // Splash: health → legacy migration → profile picker or Home. Unreachable server → discovery.
    LaunchedEffect(deps, nav.current is Dest.Splash) {
        val d = deps ?: return@LaunchedEffect
        if (nav.current !is Dest.Splash) return@LaunchedEffect
        try { d.api.health() } catch (_: Exception) {
            nav.resetTo(Dest.Welcome, Dest.Discover(DiscoveredServer.fromBaseUrl(d.api.baseUrl)))
            return@LaunchedEffect
        }
        launch { runCatching { if (d.media.status() != null) d.progressSync.migrateLegacyOnce() } }
        val picker = runCatching { d.profiles.needsPicker() }.getOrElse { Log.w(TAG, "profiles: ${it.message}"); false }
        d.hub.refreshHello()
        nav.resetTo(if (picker) Dest.ProfilePicker else Dest.TabRoot(Tab.Home))
    }

    // Deep link → Title on top of Home once startup settled.
    LaunchedEffect(deepLink, deps, nav.current) {
        val l = deepLink ?: return@LaunchedEffect
        if (deps == null || nav.current.isChromeless) return@LaunchedEffect
        when (l.first) {
            "pair" -> pairToApprove = MainActivity.pendingPair.also { MainActivity.pendingPair = null }
            "downloads" -> nav.resetTo(Dest.TabRoot(Tab.Home), Dest.Downloads)
            "together" -> nav.resetTo(Dest.TabRoot(Tab.Home), Dest.Together(MainActivity.pendingRoomId.also { MainActivity.pendingRoomId = null }))
            else -> nav.resetTo(Dest.TabRoot(Tab.Home), Dest.Title(l.first, l.second))
        }
        onDeepLinkConsumed()
    }

    // Approve a browser / TV that showed a Quick Connect QR (D59). The code is approved on THIS phone's server.
    pairToApprove?.let { p ->
        val d = deps
        if (d != null) {
            val other = p.namesOtherServer(d.api.baseUrl)
            AlertDialog(
                onDismissRequest = { pairToApprove = null },
                title = { Text(stringResource(R.string.pair_approve_title)) },
                text = {
                    Text(
                        stringResource(R.string.pair_approve_body, p.code.chunked(3).joinToString(" ")) +
                            if (other) "\n\n" + stringResource(R.string.pair_approve_other_server, p.host.orEmpty()) else ""
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        pairToApprove = null
                        scope.launch {
                            val ok = runCatching { d.api.postJson("/pair/approve", """{"code":"${p.code}"}""") }.isSuccess
                            Toast.makeText(context, if (ok) R.string.pair_approve_done else R.string.pair_approve_failed, Toast.LENGTH_LONG).show()
                        }
                    }) { Text(stringResource(R.string.pair_approve_confirm)) }
                },
                dismissButton = { TextButton(onClick = { pairToApprove = null }) { Text(stringResource(R.string.pair_approve_cancel)) } },
            )
        }
    }

    val current = nav.current
    val showChrome = deps != null && !current.isChromeless
    val music = deps?.musicPlayback?.state?.collectAsState()?.value

    CompositionLocalProvider(LocalAppDeps provides deps) {
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
            layoutType = if (showChrome) NavigationSuiteScaffoldDefaults.calculateFromAdaptiveInfo(androidx.compose.material3.adaptive.currentWindowAdaptiveInfo())
            else NavigationSuiteType.None,
            containerColor = MaterialTheme.colorScheme.background,
        ) {
            Column(Modifier.fillMaxSize()) {
                SharedTransitionLayout(Modifier.weight(1f)) {
                    CompositionLocalProvider(LocalSharedTransitionScope provides this) {
                        NavDisplay(
                            backStack = nav.backStack,
                            onBack = { nav.pop() },
                            entryDecorators = listOf(rememberSaveableStateHolderNavEntryDecorator()),
                            transitionSpec = { (slideInHorizontally(tween(280)) { it / 4 } + fadeIn(tween(280))) togetherWith fadeOut(tween(180)) },
                            popTransitionSpec = { fadeIn(tween(220)) togetherWith (slideOutHorizontally(tween(260)) { it / 4 } + fadeOut(tween(220))) },
                            predictivePopTransitionSpec = { fadeIn(tween(220)) togetherWith (slideOutHorizontally(tween(260)) { it / 4 } + fadeOut(tween(220))) },
                            entryProvider = { dest -> NavEntry(dest) { Screen(dest, nav, deps, conn, settings, scope) } },
                        )
                    }
                }
                if (showChrome && deps != null && music?.isActive == true) MiniPlayer(deps, nav.music)
            }
        }
    }
}

@Composable
private fun Screen(dest: Dest, nav: Navigator, deps: AppDeps?, conn: Connection, settings: Settings, scope: kotlinx.coroutines.CoroutineScope) {
    val app = LocalContext.current.applicationContext as MixaiPhoneApp
    when (dest) {
        Dest.Welcome -> WelcomeScreen(
            appName = stringResource(R.string.app_name),
            tagline = stringResource(R.string.welcome_tagline),
            onSignIn = { nav.push(Dest.SignIn) },
            onLocal = { nav.push(Dest.Discover()) },
            product = ro.mixai.mobile.theme.BrandProduct.Tv,
        )
        Dest.SignIn -> SignInScreen(
            onSignedIn = { body, picked ->
                scope.launch {
                    app.phone.vault.save(body.session_token)
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
            val d = deps
            if (d == null) {
                LaunchedEffect(dest) { if (!conn.isComplete) nav.resetTo(Dest.Welcome) }
                Loading()
                return
            }
            Connected(dest, nav, d)
        }
    }
}

@Composable
private fun Connected(dest: Dest, nav: Navigator, d: AppDeps) {
    when (dest) {
        Dest.Splash -> Loading()
        Dest.ProfilePicker -> ProfilePickerScreen(d.profiles, onSelected = { d.media.invalidateHome(); d.hub.refreshHello() }) {
            if (nav.backStack.size > 1 && nav.backStack.none { it is Dest.Splash }) nav.pop() else nav.resetTo(Dest.TabRoot(Tab.Home))
        }
        is Dest.TabRoot -> when (dest.tab) {
            Tab.Home -> HomeScreen(d, nav)
            Tab.Search -> SearchScreen(d, nav)
            Tab.Library -> LibraryScreen(d, nav)
            Tab.Music -> MusicScreen(d, nav.music) { TabHeader(stringResource(R.string.tab_music), d, nav) }
            Tab.Live -> LiveScreen(d, nav)
        }
        is Dest.Title -> TitleScreen(d, nav, dest.kind, dest.tmdbId)
        is Dest.Player -> PlayerScreen(d, nav, dest)
        is Dest.Artist -> ArtistScreen(d, nav.music, dest.id)
        is Dest.Album -> AlbumScreen(d, nav.music, dest.id)
        Dest.NowPlaying -> NowPlayingScreen(d, nav.music)
        is Dest.LivePlayer -> LivePlayerScreen(d, nav, dest.channelId)
        Dest.Settings -> SettingsScreen(d, nav)
        Dest.Downloads -> DownloadsScreen(d, nav)
        is Dest.Remote -> RemoteScreen(d, nav, dest.deviceId)
        is Dest.Together -> TogetherScreen(d, nav, dest.roomId)
        Dest.FamilyStats -> FamilyStatsScreen(d, nav)
        Dest.PlexImport -> PlexImportScreen(d, nav)
        Dest.Welcome, Dest.SignIn, Dest.Manual, is Dest.Discover, is Dest.Pair -> Unit
    }
}

@Composable
private fun Loading() {
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}
