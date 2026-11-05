package ro.mixai.tv.ui.home

import android.os.SystemClock
import android.util.Log
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.MediaRepository
import ro.mixai.tv.data.Progress
import ro.mixai.tv.data.Show
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.VideoFile
import ro.mixai.tv.data.episodeCode
import ro.mixai.tv.data.generated.HomeRow
import ro.mixai.tv.data.generated.MediaHome
import ro.mixai.tv.data.generated.MediaTitleResponse
import ro.mixai.tv.data.generated.TitleCard
import ro.mixai.tv.data.prefetch
import ro.mixai.tv.data.titleFor
import ro.mixai.tv.player.PlayRequest
import ro.mixai.tv.ui.components.BadgeTone
import ro.mixai.tv.ui.components.CardBadge
import ro.mixai.tv.ui.components.Choice
import ro.mixai.tv.ui.components.ChoiceDialog
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.IconActionButton
import ro.mixai.tv.ui.components.LANDSCAPE_WIDTH
import ro.mixai.tv.ui.components.LandscapeCard
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.LocalBackdrop
import ro.mixai.tv.ui.components.LocalReducedMotion
import ro.mixai.tv.ui.components.MediaRow
import ro.mixai.tv.ui.components.MetaChips
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.POSTER_WIDTH
import ro.mixai.tv.ui.components.PerfFlags
import ro.mixai.tv.ui.components.PosterCard
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.RestorableFocus
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.nav.rememberRestorableFocus
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens
import ro.mixai.tv.ui.title.PlayTarget
import ro.mixai.tv.ui.title.TitleLogo
import ro.mixai.tv.ui.title.ageLabel
import ro.mixai.tv.ui.title.formatChips
import ro.mixai.tv.ui.title.playLabel
import ro.mixai.tv.ui.title.resolveTarget
import ro.mixai.tv.ui.title.startPlayback
import ro.mixai.tv.ui.title.toast
import ro.mixai.tv.ui.title.yearOf
import java.io.File

// Media Home (WP16-18): cinematic hero driven by the focused card (backdrop via LocalBackdrop,
// TMDB logo, chips, overview, Play/Resume + More info + My list) over server rows from
// `/media/home` (disk cache first, revalidated). Falls back to `/video/scan` rows when the server
// has no media module / TMDB or no rows. Watch Next publishing lives in MainActivity (homeFlow).

private const val TAG = "MixaiPerf"
private const val HERO_DEBOUNCE_MS = 150L
private const val PREFETCH_AHEAD = 10

/**
 * D25: own rows first (Continue → My list → New in your library → recommendations). The server
 * orders them too (3.9.1+), but cached home blobs and older servers don't. Stable for the rest.
 * Mirrors Tizen `ownLibraryFirst` (Home.tsx).
 */
internal val OWN_FIRST = mapOf("continue" to 0, "watchlist" to 1, "new_in_library" to 2)

internal fun <T> ownLibraryFirst(rows: List<T>, id: (T) -> String): List<T> =
    rows.withIndex().sortedWith(compareBy({ OWN_FIRST[id(it.value)] ?: 3 }, { it.index })).map { it.value }

// Staged Home entrance (critic P1-2): backdrop → logo + chips → rows staggered, total < 700 ms,
// alpha/translation in graphicsLayer only (no relayout). Skipped under reduced motion and when Home
// re-appears from the in-process memo (Back from Title).
private const val ENTER_TOTAL_MS = 660
private const val ENTER_HERO_DELAY = 120
private const val ENTER_HERO_MS = 220
private const val ENTER_ROWS_DELAY = 240
private const val ENTER_ROW_STAGGER = 70
private const val ENTER_ROW_MS = 280
private const val ENTER_SHIFT_DP = 14

/** 0..1 progress of the element that starts at [delayMs] and lasts [durMs], given overall [t] in ms. */
private fun stage(t: Float, delayMs: Int, durMs: Int): Float {
    val x = ((t - delayMs) / durMs).coerceIn(0f, 1f)
    return FastOutSlowInEasing.transform(x)
}

private sealed interface HomeUi {
    data object Loading : HomeUi
    data class Server(val home: MediaHome, val cached: Boolean) : HomeUi
    data class Local(val movies: List<VideoFile>, val shows: List<Show>) : HomeUi
    data object Empty : HomeUi
    data class Failed(val error: Throwable) : HomeUi
}

/** What the hero shows: a TMDB card (server rows) or a local file / show (scan fallback). */
private sealed interface HeroItem {
    val key: String
    data class Card(val card: TitleCard, val rowId: String) : HeroItem { override val key get() = "${card.kind}-${card.tmdbId}" }
    data class LocalFile(val file: VideoFile) : HeroItem { override val key get() = "f-${file.fileId}" }
    data class Series(val show: Show) : HeroItem { override val key get() = "s-${show.key}" }
}

private fun cardKey(c: TitleCard) = "${c.kind}-${c.tmdbId}"

/** Last home per profile in this process: returning from Title paints instantly, then revalidates. */
private object HomeMemo {
    @Volatile var last: Pair<String, HomeUi>? = null
}

/** Same file name rule as MediaRepository's disk cache (`home-<profile>.json`). */
private fun homeCacheExists(cacheDir: File, profile: String): Boolean =
    File(cacheDir, "home-${profile.replace(Regex("[^A-Za-z0-9_-]"), "_")}.json").exists()

@Composable
fun HomeScreen(deps: ScreenDeps, nav: Navigator) {
    val context = LocalContext.current
    val composedAt = remember { SystemClock.elapsedRealtime() }
    val memo = remember { HomeMemo.last?.takeIf { it.first == deps.media.profile }?.second }
    var ui by remember { mutableStateOf(memo ?: HomeUi.Loading) }
    var reload by remember { mutableIntStateOf(0) }
    var perfLogged by remember { mutableStateOf(false) }
    var emitAt by remember { mutableStateOf(if (memo != null) composedAt else 0L) }
    val rf = rememberRestorableFocus("home")

    LaunchedEffect(reload, deps.media.profile) {
        if (reload > 0) ui = HomeUi.Loading
        val cachedAtStart = homeCacheExists(context.cacheDir, deps.media.profile)
        var first = true
        var serverError: Throwable? = null
        try {
            deps.media.homeFlow().collect { h ->
                val rows = h.rows.filter { it.items.isNotEmpty() }
                // Rows come from the server's own cache, so they are usable even when TMDB is not
                // configured right now (Tizen does the same: `mediaMode = rows.length > 0`).
                if (rows.isNotEmpty()) {
                    if (first) emitAt = SystemClock.elapsedRealtime()
                    val next = HomeUi.Server(h.copy(rows = rows), cached = first && cachedAtStart)
                    // Same content as the memo → keep the instance (no hero/row reset under the focus).
                    val cur = ui
                    if (!(cur is HomeUi.Server && cur.home == next.home)) ui = next
                    first = false
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            serverError = e
        }
        if (ui is HomeUi.Server) { HomeMemo.last = deps.media.profile to ui; return@LaunchedEffect }
        // Fallback: library rows from `/video/scan` (servers without /media or TMDB, or no rows yet).
        val err = serverError
        ui = try {
            val files = deps.api.scanAll()
            val movies = files.filter { it.parsed.season == null }.sortedBy { it.title.lowercase() }
            val shows = Show.group(files)
            val oldServer = err is ApiException && (err.status == 404 || err.status == 501)
            when {
                movies.isNotEmpty() || shows.isNotEmpty() -> HomeUi.Local(movies, shows)
                err != null && !oldServer -> HomeUi.Failed(err)
                else -> HomeUi.Empty
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            HomeUi.Failed(err ?: e)
        }
        if (ui is HomeUi.Local) HomeMemo.last = deps.media.profile to ui
    }

    // First rows on screen → one perf line per screen instance.
    val current = ui
    if (!perfLogged && (current is HomeUi.Server || current is HomeUi.Local)) {
        LaunchedEffect(Unit) {
            withFrameNanos { }
            val cached = memo != null || (current as? HomeUi.Server)?.cached == true
            val mode = if (current is HomeUi.Server) "server" else "scan"
            val now = SystemClock.elapsedRealtime()
            val data = if (emitAt > 0) emitAt - composedAt else -1
            Log.i(TAG, "home first frame ${now - composedAt}ms cached=$cached mode=$mode data=${data}ms memo=${memo != null}")
            perfLogged = true
        }
    }

    AnimatedContent(
        targetState = current,
        contentKey = { it.javaClass },
        transitionSpec = {
            // Loading → content is staged inside ServerHome; a plain swap avoids a double fade.
            if (initialState is HomeUi.Loading && targetState is HomeUi.Server) fadeIn(snap()) togetherWith fadeOut(snap())
            else fadeIn(tween(220)) togetherWith fadeOut(tween(160))
        },
        label = "home",
    ) { state ->
        when (state) {
            HomeUi.Loading -> LoadingState(rows = 2)
            is HomeUi.Failed -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                ErrorState(
                    message = state.error.message ?: state.error.javaClass.simpleName,
                    onRetry = { deps.media.invalidateHome(); reload++ },
                    title = stringResource(R.string.wp16_home_error),
                )
            }
            HomeUi.Empty -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                EmptyState(
                    icon = MixaiIcons.Movie,
                    title = stringResource(R.string.wp16_home_empty_title),
                    message = stringResource(R.string.wp16_home_empty_message),
                    action = { m -> PrimaryButton(stringResource(R.string.wp16_home_open_settings), { nav.push(Route.Settings("server")) }, m, icon = Icons.Filled.Settings) },
                )
            }
            is HomeUi.Server -> ServerHome(deps, nav, state.home, rf, animateIn = memo == null)
            is HomeUi.Local -> LocalHome(deps, nav, state.movies, state.shows, rf)
        }
    }
}

// ─── server rows ─────────────────────────────────────────────────────────────

@Composable
private fun ServerHome(deps: ScreenDeps, nav: Navigator, home: MediaHome, rf: RestorableFocus, animateIn: Boolean) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val backdrop = LocalBackdrop.current
    val reduced = LocalReducedMotion.current
    val scope = rememberCoroutineScope()
    val api = deps.api
    val rows = remember(home) { ownLibraryFirst(home.rows.distinctBy { it.id }) { it.id } }
    val posterPx = with(density) { POSTER_WIDTH.roundToPx() }
    val posterSize = remember(posterPx) { TmdbSize.poster(posterPx) }
    val landPx = with(density) { LANDSCAPE_WIDTH.roundToPx() }
    val backdropPx = with(density) { 1280.dp.roundToPx() }

    val initial = remember(home) {
        val c = rows.firstOrNull { it.id == MediaRepository.ROW_CONTINUE } ?: rows.first()
        HeroItem.Card(c.items.first(), c.id)
    }
    var focused by remember { mutableStateOf(initial) }
    var hero by remember { mutableStateOf(initial) }
    var inRows by remember { mutableStateOf(false) }
    val details = remember { mutableStateMapOf<String, MediaTitleResponse>() }
    val watchlist = remember { mutableStateMapOf<String, Boolean>() }
    var target by remember { mutableStateOf<PlayTarget?>(null) }
    var busy by remember { mutableStateOf(false) }

    // Hero follows the focused card after a short settle; details (logo, runtime, files) load lazily.
    LaunchedEffect(focused) {
        if (focused.key != hero.key) delay(HERO_DEBOUNCE_MS)
        hero = focused
        backdrop.show(api.tmdbImageUrl(TmdbSize.backdrop(backdropPx), hero.card.backdropPath ?: hero.card.posterPath))
    }
    LaunchedEffect(hero.key) {
        target = null
        val c = hero.card
        val key = hero.key
        val d = details[key] ?: runCatching { deps.media.title(c.kind, c.tmdbId) }.getOrNull()?.also { details[key] = it }
        if (d != null) {
            if (key !in watchlist) watchlist[key] = d.inWatchlist == true
            target = runCatching { resolveTarget(deps, d) }.getOrNull()
        }
    }

    // Restore the last focused card (Back from Title), else the hero's primary button.
    LaunchedEffect(Unit) { rf.restoreFocus() }

    // Only the first poster occurrence of a title gets the shared-element key (duplicates would clash).
    val sharedOwners = remember(home) {
        val seen = HashSet<String>()
        val out = HashMap<String, String>()
        rows.filter { it.id != MediaRepository.ROW_CONTINUE }.forEach { r -> r.items.forEach { c -> if (seen.add(cardKey(c))) out[cardKey(c)] = r.id } }
        out
    }

    fun play(t: PlayTarget) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                startPlayback(deps, nav, t)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                toast(context, context.getString(R.string.wp16_home_play_failed, e.message ?: ""))
            } finally {
                busy = false
            }
        }
    }

    fun openContinue(c: TitleCard) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                val d = details[cardKey(c)] ?: deps.media.title(c.kind, c.tmdbId).also { details[cardKey(c)] = it }
                val t = resolveTarget(deps, d)
                if (t != null) startPlayback(deps, nav, t) else nav.push(Route.Title(c.kind, c.tmdbId))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                nav.push(Route.Title(c.kind, c.tmdbId))
            } finally {
                busy = false
            }
        }
    }

    fun prefetchFrom(row: HomeRow, index: Int) {
        val next = row.items.drop(index + 1).take(PREFETCH_AHEAD)
        if (row.id == MediaRepository.ROW_CONTINUE) {
            prefetch(context, next.map { api.tmdbImageUrl(TmdbSize.backdrop(landPx), it.backdropPath ?: it.posterPath) }, landPx, landPx * 9 / 16)
        } else {
            prefetch(context, next.map { api.tmdbImageUrl(posterSize, it.posterPath) }, posterPx, posterPx * 3 / 2)
        }
        val bd = row.items.drop(index).take(2).map { api.tmdbImageUrl(TmdbSize.backdrop(backdropPx), it.backdropPath ?: it.posterPath) }
        prefetch(context, bd, backdropPx, backdropPx * 9 / 16)
    }

    // One clock for the whole entrance; finished (= ENTER_TOTAL_MS) when skipped.
    val skipEntrance = !animateIn || reduced || PerfFlags.noEntrance
    val enter = remember { Animatable(if (skipEntrance) ENTER_TOTAL_MS.toFloat() else 0f) }
    LaunchedEffect(Unit) {
        if (enter.value < ENTER_TOTAL_MS) enter.animateTo(ENTER_TOTAL_MS.toFloat(), tween(ENTER_TOTAL_MS, easing = androidx.compose.animation.core.LinearEasing))
    }
    val shiftPx = with(density) { ENTER_SHIFT_DP.dp.toPx() }
    val heroMod = if (PerfFlags.noEntrance) Modifier else Modifier.graphicsLayer {
        val p = stage(enter.value, ENTER_HERO_DELAY, ENTER_HERO_MS)
        alpha = p
        translationY = (1f - p) * shiftPx
    }
    fun rowMod(index: Int) = if (PerfFlags.noEntrance) Modifier else Modifier.graphicsLayer {
        val p = stage(enter.value, ENTER_ROWS_DELAY + ENTER_ROW_STAGGER * index.coerceAtMost(4), ENTER_ROW_MS)
        alpha = p
        translationY = (1f - p) * shiftPx * 1.5f
    }

    val heroFraction by animateFloatAsState(if (inRows) 0.46f else 0.56f, if (reduced) snap() else tween(260), label = "heroH")
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val heroHeight = maxHeight * heroFraction
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxWidth().height(heroHeight).then(heroMod)) {
                if (!ro.mixai.tv.ui.components.PerfFlags.noHero) CardHero(
                    deps = deps,
                    item = hero,
                    details = details[hero.key],
                    target = target,
                    inWatchlist = watchlist[hero.key] == true,
                    rf = rf,
                    onPlay = { t -> play(t) },
                    onInfo = { nav.push(Route.Title(hero.card.kind, hero.card.tmdbId)) },
                    onToggleList = {
                        val key = hero.key
                        val c = hero.card
                        val was = watchlist[key] == true
                        watchlist[key] = !was
                        scope.launch {
                            runCatching { if (was) deps.media.removeWatchlist(c.kind, c.tmdbId) else deps.media.addWatchlist(c.kind, c.tmdbId) }
                                .onSuccess { toast(context, context.getString(if (was) R.string.wp16_home_list_removed else R.string.wp16_home_list_added)) }
                                .onFailure { watchlist[key] = was; toast(context, context.getString(R.string.wp16_home_list_failed)) }
                        }
                    },
                )
            }
            LazyColumn(
                state = rememberLazyListState(),
                modifier = Modifier.fillMaxWidth().weight(1f).onFocusChanged { inRows = it.hasFocus },
                contentPadding = PaddingValues(bottom = 48.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                itemsIndexed(rows, key = { _, it -> it.id }) { rowIndex, row ->
                    val isContinue = row.id == MediaRepository.ROW_CONTINUE
                    MediaRow(
                        title = row.titleFor(deps.lang),
                        items = row.items,
                        key = { cardKey(it) },
                        onFocusItem = { focused = HeroItem.Card(it, row.id) },
                        onClick = { c -> if (isContinue) openContinue(c) else nav.push(Route.Title(c.kind, c.tmdbId)) },
                        modifier = rowMod(rowIndex),
                    ) { c, i, onFocus, onClick ->
                        val fk = "${row.id}:${cardKey(c)}"
                        val focusNow = { onFocus(); prefetchFrom(row, i) }
                        if (isContinue) {
                            ContinueCard(deps, c, landPx, onClick = onClick, onLongClick = { nav.push(Route.Title(c.kind, c.tmdbId)) }, onFocus = focusNow, modifier = rf.item(fk))
                        } else {
                            PosterCard(
                                imageUrl = api.tmdbImageUrl(posterSize, c.posterPath),
                                title = c.title,
                                subtitle = yearOf(c.releaseDate),
                                onClick = onClick,
                                badges = if (c.inLibrary == true) listOf(CardBadge(stringResource(R.string.wp16_home_badge_library), BadgeTone.Accent)) else emptyList(),
                                progress = c.progress?.toFloat(),
                                sharedKey = if (sharedOwners[cardKey(c)] == row.id) cardKey(c) else null,
                                onFocus = focusNow,
                                modifier = rf.item(fk),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ContinueCard(deps: ScreenDeps, c: TitleCard, widthPx: Int, onClick: () -> Unit, onLongClick: () -> Unit, onFocus: () -> Unit, modifier: Modifier) {
    val ne = c.nextEpisode
    val caption = when {
        ne != null && ne.season > 0 && c.reason == "up_next" -> stringResource(R.string.wp16_home_up_next, ne.season, ne.episode)
        ne != null && ne.season > 0 -> stringResource(R.string.wp16_home_episode, ne.season, ne.episode)
        else -> null
    }
    LandscapeCard(
        imageUrl = deps.api.tmdbImageUrl(TmdbSize.backdrop(widthPx), c.backdropPath ?: c.posterPath),
        title = c.title,
        caption = caption,
        progress = c.progress?.toFloat(),
        onClick = onClick,
        onLongClick = onLongClick,
        onFocus = onFocus,
        modifier = modifier,
    )
}

@Composable
private fun CardHero(
    deps: ScreenDeps,
    item: HeroItem.Card,
    details: MediaTitleResponse?,
    target: PlayTarget?,
    inWatchlist: Boolean,
    rf: RestorableFocus,
    onPlay: (PlayTarget) -> Unit,
    onInfo: () -> Unit,
    onToggleList: () -> Unit,
) {
    val c = item.card
    val t = details?.title
    val reduced = LocalReducedMotion.current
    Column(
        Modifier.fillMaxSize().padding(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = MixaiFocus.overscanTop, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.Bottom),
    ) {
        AnimatedContent(
            targetState = item.key to t?.logoPath,
            transitionSpec = { if (reduced) fadeIn(snap()) togetherWith fadeOut(snap()) else fadeIn(tween(220)) togetherWith fadeOut(tween(120)) },
            label = "heroLogo",
        ) { (_, logo) ->
            TitleLogo(deps.api, logo, c.title, height = 96.dp)
        }
        MetaChips(
            year = yearOf(c.releaseDate),
            age = ageLabel(c.age ?: t?.age, t?.certification),
            runtimeMin = t?.runtime?.takeIf { c.kind != "tv" },
            formats = details?.let { formatChips(it.files) }.orEmpty(),
            rating = c.voteAverage,
        )
        Text(
            (c.overview ?: t?.overview).orEmpty(),
            style = MaterialTheme.typography.bodyLarge,
            color = Tokens.foreground.copy(alpha = 0.85f),
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 640.dp).height(72.dp),
        )
        Row(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            val primary = Modifier.focusRequester(rf.requester).then(rf.item("hero:primary"))
            if (target != null) {
                PrimaryButton(playLabel(target), { onPlay(target) }, primary, icon = Icons.Filled.PlayArrow)
                SecondaryButton(stringResource(R.string.wp16_home_more_info), onInfo, rf.item("hero:info"), icon = Icons.Filled.Info)
            } else {
                PrimaryButton(stringResource(R.string.wp16_home_more_info), onInfo, primary, icon = Icons.Filled.Info)
            }
            IconActionButton(
                icon = if (inWatchlist) MixaiIcons.Bookmark else MixaiIcons.BookmarkBorder,
                label = stringResource(if (inWatchlist) R.string.wp16_home_list_remove else R.string.wp16_home_list_add),
                onClick = onToggleList,
                selected = inWatchlist,
                modifier = rf.item("hero:list"),
            )
        }
    }
}

// ─── scan fallback ───────────────────────────────────────────────────────────

@Composable
private fun LocalHome(deps: ScreenDeps, nav: Navigator, movies: List<VideoFile>, shows: List<Show>, rf: RestorableFocus) {
    val backdrop = LocalBackdrop.current
    val progress by deps.settings.progress.collectAsState(initial = emptyMap())
    val initial: HeroItem = remember(movies, shows) { movies.firstOrNull()?.let { HeroItem.LocalFile(it) } ?: HeroItem.Series(shows.first()) }
    var focused by remember { mutableStateOf(initial) }
    var hero by remember { mutableStateOf(initial) }
    var pickShow by remember { mutableStateOf<Show?>(null) }

    LaunchedEffect(focused) {
        if (focused.key != hero.key) delay(HERO_DEBOUNCE_MS)
        hero = focused
        val fileId = when (val h = hero) {
            is HeroItem.LocalFile -> h.file.fileId
            is HeroItem.Series -> h.show.episodes.first().fileId
            is HeroItem.Card -> null
        }
        backdrop.show(fileId?.let { deps.api.stillUrl(it) })
    }
    LaunchedEffect(Unit) { rf.restoreFocus() }

    fun play(f: VideoFile) = nav.push(Route.Play(PlayRequest.Video(f, hls = !f.directPlayable), from = nav.current))
    fun nextEpisode(s: Show): VideoFile =
        s.episodes.filter { progress[it.fileId] != null }.maxByOrNull { progress.getValue(it.fileId).at } ?: s.episodes.first()

    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxWidth().weight(0.5f).padding(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = MixaiFocus.overscanTop, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.Bottom),
        ) {
            when (val h = hero) {
                is HeroItem.LocalFile -> {
                    Text(h.file.title, style = MaterialTheme.typography.displaySmall, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    MetaChips(year = h.file.parsed.year?.toString(), runtimeMin = h.file.durationSec?.let { (it / 60).toLong() }, formats = fileFormats(h.file))
                }
                is HeroItem.Series -> {
                    Text(h.show.title, style = MaterialTheme.typography.displaySmall, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(stringResource(R.string.wp16_home_episodes_seasons, h.show.episodes.size, h.show.seasons), style = MaterialTheme.typography.bodyLarge, color = Tokens.mutedForeground)
                }
                is HeroItem.Card -> Unit
            }
            Row(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                val primary = Modifier.focusRequester(rf.requester).then(rf.item("hero:primary"))
                when (val h = hero) {
                    is HeroItem.LocalFile -> PrimaryButton(localPlayLabel(progress[h.file.fileId]), { play(h.file) }, primary, icon = Icons.Filled.PlayArrow)
                    is HeroItem.Series -> {
                        val ep = nextEpisode(h.show)
                        PrimaryButton(localPlayLabel(progress[ep.fileId], ep.episodeCode()), { play(ep) }, primary, icon = Icons.Filled.PlayArrow)
                        SecondaryButton(stringResource(R.string.wp16_home_episodes_button), { pickShow = h.show }, rf.item("hero:episodes"))
                    }
                    is HeroItem.Card -> Unit
                }
            }
        }
        LazyColumn(Modifier.fillMaxWidth().weight(0.5f), contentPadding = PaddingValues(bottom = 48.dp)) {
            if (movies.isNotEmpty()) item("movies") {
                MediaRow(
                    title = stringResource(R.string.wp16_home_row_movies),
                    items = movies,
                    key = { it.fileId },
                    onFocusItem = { focused = HeroItem.LocalFile(it) },
                    onClick = { play(it) },
                    trailing = movies.size.toString(),
                ) { f, _, onFocus, onClick ->
                    LandscapeCard(
                        imageUrl = deps.api.stillUrl(f.fileId),
                        title = f.title,
                        caption = listOfNotNull(f.parsed.year?.toString(), f.height?.let { "${it}p" }).joinToString(" · "),
                        progress = progress[f.fileId]?.fraction,
                        onClick = onClick,
                        onFocus = onFocus,
                        modifier = rf.item("m:${f.fileId}"),
                    )
                }
            }
            if (shows.isNotEmpty()) item("shows") {
                MediaRow(
                    title = stringResource(R.string.wp16_home_row_shows),
                    items = shows,
                    key = { it.key },
                    onFocusItem = { focused = HeroItem.Series(it) },
                    onClick = { pickShow = it },
                    trailing = shows.size.toString(),
                ) { s, _, onFocus, onClick ->
                    LandscapeCard(
                        imageUrl = deps.api.stillUrl(s.episodes.first().fileId),
                        title = s.title,
                        caption = stringResource(R.string.wp16_home_episodes_count, s.episodes.size),
                        progress = s.episodes.mapNotNull { progress[it.fileId] }.maxByOrNull { it.at }?.fraction,
                        onClick = onClick,
                        onFocus = onFocus,
                        modifier = rf.item("s:${s.key}"),
                    )
                }
            }
        }
    }

    val s = pickShow
    val leftFmt = stringResource(R.string.wp16_home_min_left)
    ChoiceDialog(
        title = s?.title.orEmpty(),
        options = s?.episodes?.map { f ->
            Choice(f, listOf(f.episodeCode(), f.title).filter(String::isNotBlank).joinToString(" · "), progress[f.fileId]?.let { p -> leftFmt.format(minutesLeft(p)) })
        }.orEmpty(),
        selected = s?.let { nextEpisode(it) },
        onPick = { f -> pickShow = null; play(f) },
        onDismiss = { pickShow = null },
        visible = s != null,
    )
}

private fun fileFormats(f: VideoFile): List<String> = buildList {
    val h = f.height ?: 0
    if (h >= 2000) add("4K") else if (h >= 1000) add("HD")
    when (f.hdr?.lowercase()) {
        null, "", "sdr" -> Unit
        "dv", "dolby vision", "dovi" -> add("DV")
        else -> add("HDR")
    }
}

private fun minutesLeft(p: Progress): Long = ((p.dur - p.pos) / 60_000).coerceAtLeast(1)

@Composable
private fun localPlayLabel(p: Progress?, code: String = ""): String {
    if (p != null && p.pos > 0 && p.fraction < 0.95f) {
        val left = minutesLeft(p)
        return if (code.isNotBlank()) stringResource(R.string.wp16_home_resume_code, code, left) else stringResource(R.string.wp16_home_resume_local, left)
    }
    return if (code.isNotBlank()) stringResource(R.string.wp16_home_play_code, code) else stringResource(R.string.wp16_title_play)
}
