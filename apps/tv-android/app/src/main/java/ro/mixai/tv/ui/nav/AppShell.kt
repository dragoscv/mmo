@file:OptIn(ExperimentalComposeUiApi::class)

package ro.mixai.tv.ui.nav

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import ro.mixai.tv.R
import ro.mixai.tv.data.MusicHandoff
import ro.mixai.tv.data.MusicPlayback
import ro.mixai.tv.data.MusicRepository
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.data.isKid
import ro.mixai.tv.ui.components.ConfirmDialog
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.profiles.ProfileAvatar
import ro.mixai.tv.ui.theme.Tokens

/** One rail destination. `id` is what `Settings.navOrder` stores. */
data class RailItem(val id: String, val icon: ImageVector, val labelRes: Int, val route: Route) {
    fun matches(r: Route): Boolean = when (id) {
        "home" -> r is Route.Home
        "search" -> r is Route.Search
        "movies" -> r is Route.Library && r.kind == "movie"
        "shows" -> r is Route.Library && r.kind == "tv"
        "music" -> r is Route.Music
        "livetv" -> r is Route.LiveTv
        "settings" -> r is Route.Settings
        else -> false
    }
}

/** All rail destinations, keyed by id. Unknown ids in `navOrder` are ignored. */
val RAIL_ITEMS: Map<String, RailItem> = listOf(
    RailItem("home", Icons.Filled.Home, R.string.wp16_nav_home, Route.Home),
    RailItem("search", Icons.Filled.Search, R.string.wp16_nav_search, Route.Search()),
    RailItem("movies", MixaiIcons.Movie, R.string.wp16_nav_movies, Route.Library("movie")),
    RailItem("shows", MixaiIcons.Tv, R.string.wp16_nav_shows, Route.Library("tv")),
    RailItem("music", MixaiIcons.MusicNote, R.string.wp16_nav_music, Route.Music),
    RailItem("livetv", MixaiIcons.LiveTv, R.string.wp16_nav_livetv, Route.LiveTv),
    RailItem("settings", Icons.Filled.Settings, R.string.wp16_nav_settings, Route.Settings()),
).associateBy { it.id }

private val RAIL_COLLAPSED = 72.dp
private val RAIL_EXPANDED = 260.dp

/**
 * App frame: left navigation rail + [content] (the NavHost). The rail is 72 dp icons-only and
 * expands to 260 dp with labels while it holds focus. D-pad Left at the content's left edge enters
 * the rail (focus lands on the current destination); Right returns to the content's last focus.
 * Back on a top-level route focuses the rail; Back on the rail asks to exit. Elsewhere Back pops.
 * Hidden on full-screen routes ([Route.hidesRail]).
 */
@Composable
fun AppShell(
    nav: Navigator,
    settings: Settings,
    activeProfile: Profile?,
    musicPlayback: MusicPlayback?,
    music: MusicRepository?,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val route = nav.current
    val showRail = !route.hidesRail
    val order by settings.navOrder.collectAsState(initial = Settings.DEFAULT_NAV_ORDER)
    val items = remember(order) { order.mapNotNull { RAIL_ITEMS[it] }.ifEmpty { listOf(RAIL_ITEMS.getValue("home")) } }
    var railFocused by remember { mutableStateOf(false) }
    var confirmExit by remember { mutableStateOf(false) }
    val railEntry = remember { FocusRequester() }
    val contentFocus = remember { FocusRequester() }
    val activity = LocalContext.current as? Activity

    val railWidth by animateDpAsState(if (railFocused) RAIL_EXPANDED else RAIL_COLLAPSED, tween(180), label = "rail")

    // Back: pop; on top-level → rail; on rail → exit confirm.
    BackHandler(enabled = !confirmExit) {
        when {
            showRail && railFocused -> confirmExit = true
            showRail && route.isTopLevel -> runCatching { railEntry.requestFocus() }
            nav.canPop -> nav.pop()
            else -> confirmExit = true
        }
    }

    Box(modifier.fillMaxSize()) {
        // Content: offset by the collapsed rail so the expanded rail overlays it. focusRestorer()
        // puts focus back on the last focused child when the rail hands focus back (Right).
        Box(
            Modifier
                .fillMaxSize()
                .padding(start = if (showRail) RAIL_COLLAPSED else 0.dp)
                .focusRequester(contentFocus)
                .focusProperties {
                    onExit = {
                        if (showRail && requestedFocusDirection == androidx.compose.ui.focus.FocusDirection.Left) {
                            runCatching { railEntry.requestFocus() }
                        }
                    }
                }
                .focusRestorer(),
        ) { content() }

        if (showRail) {
            Column(
                Modifier
                    .fillMaxHeight()
                    .width(railWidth)
                    .background(
                        if (railFocused) Brush.horizontalGradient(listOf(Tokens.sidebar, Tokens.sidebar.copy(alpha = 0.92f), Color.Transparent))
                        else Brush.horizontalGradient(listOf(Tokens.sidebar.copy(alpha = 0.85f), Tokens.sidebar.copy(alpha = 0.0f))),
                    )
                    .onFocusChanged { railFocused = it.hasFocus }
                    .focusProperties {
                        // Entering the rail from anywhere lands on the current destination.
                        onEnter = { runCatching { railEntry.requestFocus() } }
                    }
                    .onPreviewKeyEvent { e ->
                        if (e.type == KeyEventType.KeyDown && e.key == Key.DirectionRight) { runCatching { contentFocus.requestFocus() }; true } else false
                    }
                    .focusGroup()
                    .padding(vertical = 28.dp, horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                // Profile avatar → picker.
                RailButton(
                    expanded = railFocused,
                    label = activeProfile?.name ?: stringResource(R.string.wp16_profile_switch),
                    selected = false,
                    onClick = { nav.push(Route.ProfilePicker) },
                    leading = { ProfileAvatar(activeProfile, size = 40.dp, showKidBadge = activeProfile?.isKid == true) },
                )
                Spacer(Modifier.height(18.dp))
                val currentIndex = items.indexOfFirst { it.matches(route) }
                items.forEachIndexed { i, item ->
                    val isCurrent = i == currentIndex || (currentIndex < 0 && i == 0)
                    RailButton(
                        expanded = railFocused,
                        label = stringResource(item.labelRes),
                        selected = i == currentIndex,
                        modifier = if (isCurrent) Modifier.focusRequester(railEntry) else Modifier,
                        onClick = {
                            // Music installed → hand off to MixAI Music (WP17-45); else built-in player.
                            if (item.id == "music" && activity != null && MusicHandoff.openFromTv(activity, musicPlayback)) {
                                // MixAI Music took over.
                            } else if (!item.matches(route)) {
                                // Top-level destinations sit on top of Home so Back from them returns Home.
                                if (item.id == "home") nav.resetTo(Route.Home) else nav.resetTo(Route.Home, item.route)
                            }
                            runCatching { contentFocus.requestFocus() }
                        },
                        leading = { Icon(item.icon, contentDescription = null, modifier = Modifier.size(26.dp)) },
                    )
                }
                Spacer(Modifier.weight(1f))
                if (musicPlayback != null) MiniPlayerChip(musicPlayback, music, railFocused, onOpen = { nav.push(Route.NowPlaying) })
            }
        }
    }

    if (confirmExit) {
        ConfirmDialog(
            title = stringResource(R.string.wp16_exit_title),
            message = stringResource(R.string.wp16_exit_message),
            confirmLabel = stringResource(R.string.wp16_exit_confirm),
            onConfirm = { confirmExit = false; activity?.finish() },
            onDismiss = { confirmExit = false },
            focusDismiss = true,
        )
    }
}

@Composable
private fun RailButton(
    expanded: Boolean,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leading: @Composable () -> Unit,
) {
    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().height(52.dp),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(12.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) Tokens.sidebarAccent else Color.Transparent,
            contentColor = if (selected) Tokens.sidebarForeground else Tokens.mutedForeground,
            focusedContainerColor = Tokens.sidebarForeground,
            focusedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.03f),
    ) {
        Row(Modifier.fillMaxSize().padding(horizontal = 11.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(26.dp + 0.dp), contentAlignment = Alignment.Center) { leading() }
            if (expanded) {
                Spacer(Modifier.width(16.dp))
                Text(label, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** Small now-playing chip at the rail bottom while music plays; opens Now Playing. */
@Composable
private fun MiniPlayerChip(playback: MusicPlayback, music: MusicRepository?, expanded: Boolean, onOpen: () -> Unit) {
    val s by playback.state.collectAsState()
    val t = s.track ?: return
    AnimatedVisibility(s.isActive, enter = fadeIn(), exit = fadeOut()) {
        Surface(
            onClick = onOpen,
            modifier = Modifier.fillMaxWidth().height(60.dp),
            shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(12.dp)),
            colors = ClickableSurfaceDefaults.colors(
                containerColor = Tokens.sidebarAccent,
                contentColor = Tokens.sidebarForeground,
                focusedContainerColor = Tokens.sidebarForeground,
                focusedContentColor = Tokens.background,
            ),
        ) {
            Row(Modifier.fillMaxSize().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)).background(Tokens.muted), contentAlignment = Alignment.Center) {
                    val cover = music?.coverUrl(t)
                    if (cover != null) AsyncImage(cover, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    else Icon(if (s.playing) MixaiIcons.MusicNote else Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(20.dp))
                }
                if (expanded) {
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(t.title, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(t.artist ?: "", style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Icon(if (s.playing) MixaiIcons.Pause else Icons.Filled.PlayArrow, contentDescription = stringResource(R.string.wp16_now_playing), modifier = Modifier.size(20.dp))
                }
            }
        }
    }
}
