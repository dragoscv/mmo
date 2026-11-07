package ro.mixai.music.wear

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.TimeText
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import kotlinx.coroutines.launch
import ro.mixai.tv.data.Connection
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.WearHandoff

/** Startup routing: connect (phone handoff / discovery / code) → profile → library. */
@Composable
fun WearRoot(app: WearMusicApp) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val conn by app.settings.connection.collectAsState(initial = null)
    val phoneOffer by remember { PhoneHandoff.offers(context) }.collectAsState(initial = null)
    var pairing by remember { mutableStateOf<DiscoveredServer?>(null) }

    AppScaffold(timeText = { TimeText() }) {
        val c = conn
        when {
            c == null -> CircularProgressIndicator()
            !c.isComplete -> {
                val p = pairing
                if (p != null) {
                    WearPairScreen(p) { base, token, user -> scope.launch { app.settings.save(base, token, user); pairing = null } }
                } else {
                    ServerPickScreen(
                        phoneOffer = phoneOffer,
                        onUsePhone = {
                            val o = phoneOffer ?: return@ServerPickScreen
                            scope.launch {
                                app.settings.save(o.baseUrl, o.token, o.userId)
                                if (o.profileId.isNotBlank()) app.settings.saveActiveProfile(o.profileId)
                            }
                        },
                        onPick = { pairing = it },
                    )
                }
            }
            else -> Connected(app, c)
        }
    }
}

private object Routes {
    const val HOME = "home"
    const val PLAYER = "player"
    const val LIST = "list"
    const val PROFILES = "profiles"
}

@Composable
private fun Connected(app: WearMusicApp, conn: Connection) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val graph = remember(conn) { buildWearGraph(context, conn, app.settings) }
    DisposableEffect(graph) {
        graph.playback.connect()
        onDispose { graph.playback.release() }
    }
    var ready by remember(graph) { mutableStateOf(false) }
    var needsPicker by remember(graph) { mutableStateOf(false) }
    LaunchedEffect(graph) {
        needsPicker = runCatching { graph.profiles.needsPicker() }.getOrDefault(false)
        ready = true
    }
    if (!ready) { CircularProgressIndicator(); return }

    val nav = rememberSwipeDismissableNavController()
    var listSource by remember { mutableStateOf<ListSource>(ListSource.Downloads) }
    val active by graph.profiles.activeProfile.collectAsState()
    val playing by graph.playback.state.collectAsState()
    val phoneOutput by remember { PhoneHandoff.phoneOutput(context) }.collectAsState(initial = null)
    SwipeDismissableNavHost(navController = nav, startDestination = if (needsPicker) Routes.PROFILES else Routes.HOME) {
        composable(Routes.HOME) {
            HomeScreen(
                graph = graph,
                profileName = active?.name,
                nowPlaying = playing.track,
                onNowPlaying = { nav.navigate(Routes.PLAYER) },
                onOpen = { listSource = it; nav.navigate(Routes.LIST) },
                onProfiles = { nav.navigate(Routes.PROFILES) },
                phoneOutput = phoneOutput,
                onPhoneLocal = { PhoneHandoff.requestPhoneLocal(context) },
                onDisconnect = {
                    scope.launch {
                        graph.playback.stop()
                        app.settings.clear()
                    }
                },
            )
        }
        composable(Routes.LIST) { TrackListScreen(graph, listSource) { nav.navigate(Routes.PLAYER) } }
        composable(Routes.PLAYER) { NowPlayingScreen(graph.playback) }
        composable(Routes.PROFILES) {
            ProfilesScreen(graph.profiles) {
                if (!nav.popBackStack(Routes.HOME, inclusive = false)) {
                    nav.navigate(Routes.HOME) { popUpTo(Routes.PROFILES) { inclusive = true } }
                }
            }
        }
    }
}

