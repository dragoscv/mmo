@file:OptIn(ExperimentalSharedTransitionApi::class)

package ro.mixai.tv.ui.nav

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import kotlinx.coroutines.delay
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.player.PlayRequest
import ro.mixai.tv.ui.components.LocalReducedMotion

/** Every screen of the app. Arguments are plain values so a route can be pushed from anywhere. */
sealed interface Route {
    // ── onboarding (no rail) ──
    /** Resolves the start screen (health check, profile picker vs Home). */
    data object Splash : Route
    /** First run: MixAI account vs. local server. */
    data object Welcome : Route
    /** Device-code sign-in on mixai.ro. */
    data object SignIn : Route
    /** LAN autodiscovery; `preselected` = the saved server whose health check failed. */
    data class Discover(val preselected: DiscoveredServer? = null) : Route
    data class Pair(val server: DiscoveredServer) : Route
    /** Manual host + token fallback. */
    data object Connect : Route
    /** "Who's watching?" */
    data object ProfilePicker : Route

    // ── top level (rail) ──
    data object Home : Route
    data class Search(val initial: String = "") : Route
    /** `kind` = `movie` | `tv`. */
    data class Library(val kind: String) : Route
    data object Music : Route
    data object LiveTv : Route
    /** `section` deep-links a part of Settings (e.g. `profiles`, `livetv`, `server`); `""` = overview. */
    data class Settings(val section: String = "") : Route

    // ── detail ──
    /** Unified TMDB title page (`/media/title/:kind/:tmdbId`). */
    data class Title(val kind: String, val tmdbId: Long) : Route
    data class Season(val tmdbId: Long, val season: Long) : Route
    data class Artist(val id: String) : Route
    /** Subsonic album id. */
    data class Album(val id: String) : Route
    data object NowPlaying : Route
    data object Guide : Route
    data object Recordings : Route
    data object Stats : Route
    data class WatchTogether(val roomId: String? = null) : Route

    // ── full-screen players (no rail, no transition) ──
    /** `resumeMs` ≥ 0 overrides the local resume position; `from` = route that started playback (for "back to"). */
    data class Play(val request: PlayRequest, val resumeMs: Long = -1L, val from: Route? = null) : Route
    data class LivePlay(val channelId: String) : Route
}

/** True for routes that own the whole screen (no rail, no route animation). */
val Route.isFullScreen: Boolean get() = this is Route.Play || this is Route.LivePlay

/** Routes reachable from the rail; Back there focuses the rail, then asks to exit. */
val Route.isTopLevel: Boolean
    get() = this is Route.Home || this is Route.Search || this is Route.Library || this is Route.Music || this is Route.LiveTv || this is Route.Settings

/** Routes that never show the rail. */
val Route.hidesRail: Boolean
    get() = isFullScreen || this is Route.Splash || this is Route.Welcome || this is Route.SignIn || this is Route.Discover ||
        this is Route.Pair || this is Route.Connect || this is Route.ProfilePicker || this is Route.NowPlaying

/**
 * One entry of the back stack. `key` is unique per push so the same route twice keeps separate state;
 * `rev` grows on every [Navigator.replaceInPlace] of this entry.
 */
@Stable
data class NavEntry(val key: Int, val route: Route, val rev: Int = 0)

/** Own back stack (WP16): push/pop/replace/resetTo over a snapshot list, observed by [NavHost]. */
@Stable
class Navigator(initial: Route) {
    private var nextKey = 0
    val entries: SnapshotStateList<NavEntry> = mutableStateListOf(NavEntry(nextKey++, initial))

    /** Direction of the last stack change (drives the transition). */
    var lastWasPop by mutableStateOf(false)
        private set

    val top: NavEntry get() = entries.last()
    val current: Route get() = entries.last().route
    val canPop: Boolean get() = entries.size > 1
    val routes: List<Route> get() = entries.map { it.route }

    fun push(route: Route) {
        lastWasPop = false
        entries.add(NavEntry(nextKey++, route))
    }

    /** Pops the top entry; returns false when only one is left. */
    fun pop(): Boolean {
        if (entries.size <= 1) return false
        lastWasPop = true
        entries.removeAt(entries.lastIndex)
        return true
    }

    /** Pops back to the most recent entry matching [predicate] (kept). Returns false if none. */
    fun popTo(predicate: (Route) -> Boolean): Boolean {
        val idx = entries.indexOfLast { predicate(it.route) }
        if (idx < 0) return false
        lastWasPop = true
        while (entries.lastIndex > idx) entries.removeAt(entries.lastIndex)
        return true
    }

    /** Replaces the top entry (new key → fresh state). */
    fun replace(route: Route) {
        lastWasPop = false
        entries[entries.lastIndex] = NavEntry(nextKey++, route)
    }

    /**
     * Swaps the top entry's route but KEEPS its key: the same screen instance stays composed and
     * sees the new route (players reuse their ExoPlayer/MediaSession instead of building a second one).
     */
    fun replaceInPlace(route: Route) {
        lastWasPop = false
        val top = entries.last()
        entries[entries.lastIndex] = top.copy(route = route, rev = top.rev + 1)
    }

    /** Clears the stack and pushes [routes] (bottom → top). */
    fun resetTo(vararg routes: Route) {
        require(routes.isNotEmpty())
        lastWasPop = false
        val fresh = routes.map { NavEntry(nextKey++, it) }
        entries.clear()
        entries.addAll(fresh)
    }
}

/** Shared-element scope of the [NavHost] (null outside it). */
val LocalSharedTransitionScope = compositionLocalOf<SharedTransitionScope?> { null }

/** Animated-visibility scope of the current route's content (null outside [NavHost]). */
val LocalAnimatedVisibilityScope = compositionLocalOf<AnimatedVisibilityScope?> { null }

/** The back-stack entry being composed (null outside [NavHost]). */
val LocalNavEntry = compositionLocalOf<NavEntry?> { null }

private const val NAV_ANIM_MS = 220

/**
 * Renders the top of [nav]'s stack. Each entry's `rememberSaveable` state (scroll, focus keys) lives
 * in a SaveableStateHolder keyed by [NavEntry.key], so popping back restores it. Forward = fade +
 * slight scale-in (220 ms), pop = the reverse; no animation into/out of full-screen players.
 */
@Composable
fun NavHost(nav: Navigator, modifier: Modifier = Modifier, content: @Composable (Route) -> Unit) {
    val holder = rememberSaveableStateHolder()
    val reduced = LocalReducedMotion.current
    val liveKeys = nav.entries.map { it.key }
    val known = remember { mutableSetOf<Int>() }
    LaunchedEffect(liveKeys) {
        known += liveKeys
        val gone = known - liveKeys.toSet()
        if (gone.isEmpty()) return@LaunchedEffect
        delay((NAV_ANIM_MS + 120).toLong()) // let the exit animation finish
        gone.forEach { holder.removeState(it) }
        known -= gone
    }
    if (ro.mixai.tv.ui.components.PerfFlags.noShared) {
        AnimatedContent(
            targetState = nav.top,
            contentKey = { it.key },
            transitionSpec = { navTransition(initialState.route, targetState.route, nav.lastWasPop, reduced) },
            label = "nav",
            modifier = modifier,
        ) { entry ->
                    val live = nav.entries.firstOrNull { it.key == entry.key } ?: entry
                    CompositionLocalProvider(LocalAnimatedVisibilityScope provides this, LocalNavEntry provides live) {
                        holder.SaveableStateProvider(entry.key) { content(live.route) }
            }
        }
        return
    }
    SharedTransitionLayout(modifier) {
        val shared = this
        AnimatedContent(
            targetState = nav.top,
            contentKey = { it.key },
            transitionSpec = { navTransition(initialState.route, targetState.route, nav.lastWasPop, reduced) },
            label = "nav",
        ) { entry ->
            // Same key = same content; read the live entry so an in-place replace reaches the screen.
            val live = nav.entries.firstOrNull { it.key == entry.key } ?: entry
            CompositionLocalProvider(
                LocalSharedTransitionScope provides shared,
                LocalAnimatedVisibilityScope provides this,
                LocalNavEntry provides live,
            ) {
                holder.SaveableStateProvider(entry.key) { content(live.route) }
            }
        }
    }
}

private fun navTransition(from: Route, to: Route, pop: Boolean, reduced: Boolean): ContentTransform {
    if (reduced || from.isFullScreen || to.isFullScreen) return EnterTransition.None togetherWith ExitTransition.None
    val t = tween<Float>(NAV_ANIM_MS)
    return if (!pop) {
        (fadeIn(t) + scaleIn(t, initialScale = 0.96f)) togetherWith (fadeOut(t) + scaleOut(t, targetScale = 1.02f))
    } else {
        (fadeIn(t) + scaleIn(t, initialScale = 1.02f)) togetherWith (fadeOut(t) + scaleOut(t, targetScale = 0.96f))
    }
}

/**
 * Shared poster transition between a card and the detail page: applies
 * `sharedElement(rememberSharedContentState("poster-$key"), animatedVisibilityScope)` when both
 * scopes are present (inside [NavHost]); otherwise returns the modifier unchanged.
 */
@Composable
fun Modifier.sharedPoster(key: String): Modifier {
    if (LocalReducedMotion.current) return this
    val shared = LocalSharedTransitionScope.current ?: return this
    val visibility = LocalAnimatedVisibilityScope.current ?: return this
    return with(shared) { this@sharedPoster.sharedElement(rememberSharedContentState("poster-$key"), visibility) }
}

/**
 * Remembers which child had focus on this back-stack entry so a screen can put focus back
 * there when the user returns (Back from a detail page).
 *
 * ```
 * val rf = rememberRestorableFocus("home")
 * LazyRow { items(cards, key = { it.id }) { c -> PosterCard(..., modifier = rf.item("row1:${c.id}")) } }
 * LaunchedEffect(Unit) { rf.restoreFocus() }   // or RestoreFocusOnReturn(rf)
 * ```
 * [requester] is the fallback target (attach it to the first/primary element).
 */
@Stable
class RestorableFocus internal constructor(private val lastKeyState: androidx.compose.runtime.MutableState<String?>) {
    /** Fallback target when nothing was recorded yet (or the recorded item is gone). */
    val requester = FocusRequester()
    private val requesters = HashMap<String, FocusRequester>()

    /** Key of the last focused child on this entry (survives pop via SaveableStateHolder). */
    val lastKey: String? get() = lastKeyState.value

    private fun requesterFor(key: String): FocusRequester = requesters.getOrPut(key) { FocusRequester() }

    /** Attach to each focusable child: records it as last focused and makes it restorable. */
    fun item(key: String): Modifier = Modifier
        .focusRequester(requesterFor(key))
        .onFocusChanged { if (it.isFocused) lastKeyState.value = key }

    /** Records [key] as focused without a modifier (e.g. from an `onFocus` callback). */
    fun record(key: String) { lastKeyState.value = key }

    /**
     * Requests focus on the last focused child, else on [requester]. Waits one frame first
     * (requestFocus before the first layout throws). Returns true when a request succeeded.
     */
    suspend fun restoreFocus(): Boolean {
        delay(50)
        val k = lastKeyState.value
        if (k != null) {
            val r = requesters[k]
            if (r != null && runCatching { r.requestFocus() }.isSuccess) return true
        }
        return runCatching { requester.requestFocus() }.isSuccess
    }
}

/** See [RestorableFocus]. `id` scopes the record within the current back-stack entry. */
@Composable
fun rememberRestorableFocus(id: String): RestorableFocus {
    val state = rememberSaveable(id) { mutableStateOf<String?>(null) }
    return remember(id) { RestorableFocus(state) }
}

/** Calls [RestorableFocus.restoreFocus] once when the screen (re)enters composition. */
@Composable
fun RestoreFocusOnReturn(focus: RestorableFocus) {
    LaunchedEffect(focus) { focus.restoreFocus() }
}
