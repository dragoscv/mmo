package ro.mixai.app.ui.home

import android.os.SystemClock
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import coil3.compose.AsyncImage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.app.ui.components.CardRow
import ro.mixai.app.ui.components.EmptyState
import ro.mixai.app.ui.components.ErrorState
import ro.mixai.app.ui.components.LandscapeCard
import ro.mixai.app.ui.components.LoadingSkeleton
import ro.mixai.app.ui.components.PosterCard
import ro.mixai.app.ui.components.ProfileButton
import ro.mixai.app.ui.media.PlayTarget
import ro.mixai.app.ui.media.cardKey
import ro.mixai.app.ui.media.formatChips
import ro.mixai.app.ui.media.genresOf
import ro.mixai.app.ui.media.posterKey
import ro.mixai.app.ui.media.resolveTarget
import ro.mixai.app.ui.media.startPlayback
import ro.mixai.app.ui.media.yearOf
import ro.mixai.app.ui.theme.Mixai
import ro.mixai.app.ui.title.TitleLogo
import ro.mixai.app.ui.title.playLabel
import ro.mixai.app.ui.title.toast
import ro.mixai.tv.data.MediaRepository
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.HomeRow
import ro.mixai.tv.data.generated.MediaHome
import ro.mixai.tv.data.generated.MediaTitleResponse
import ro.mixai.tv.data.generated.TitleCard
import ro.mixai.tv.data.titleFor

// Phone Media Home (WP16-46): cinematic hero (continue-watching first item, else the first card)
// over server rows from `/media/home`. Disk cache paints the first frame (homeFlow is
// stale-while-revalidate); the last home per profile stays in a process memo so tab switches and
// Back from Title never flash a skeleton. Pull to refresh forces a network fetch.

private const val PERF_TAG = "MixaiPerf"

/** Last home per profile in this process (Home leaves composition on tab switch). */
private object HomeMemo {
    @Volatile var last: Pair<String, MediaHome>? = null
}

private fun MediaHome.nonEmpty(): MediaHome = copy(rows = rows.filter { it.items.isNotEmpty() })

/** Same file name rule as MediaRepository's disk cache (`home-<profile>.json`). */
private fun homeCacheExists(cacheDir: java.io.File, profile: String): Boolean =
    java.io.File(cacheDir, "home-${profile.replace(Regex("[^A-Za-z0-9_-]"), "_")}.json").exists()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(deps: AppDeps, nav: Navigator) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val profile = deps.media.profile
    val composedAt = remember { SystemClock.elapsedRealtime() }
    val memo = remember(profile) { HomeMemo.last?.takeIf { it.first == profile }?.second }
    var home by remember(profile) { mutableStateOf(memo) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var refreshing by remember { mutableStateOf(false) }
    var fromCache by remember { mutableStateOf(memo != null) }
    var perfLogged by remember { mutableStateOf(false) }

    LaunchedEffect(profile, reload) {
        error = null
        if (home == null) fromCache = homeCacheExists(context.cacheDir, profile)
        try {
            deps.media.homeFlow().collect { h ->
                val next = h.nonEmpty()
                if (home != next) home = next
                HomeMemo.last = profile to next
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (home == null) error = e
        }
    }

    val current = home
    if (!perfLogged && current != null && current.rows.isNotEmpty()) {
        LaunchedEffect(Unit) {
            withFrameNanos { }
            val ms = SystemClock.elapsedRealtime() - composedAt
            Log.i(PERF_TAG, "phone home first frame ${ms}ms cached=$fromCache memo=${memo != null}")
            perfLogged = true
        }
    }

    val err = error
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            scope.launch {
                refreshing = true
                try {
                    val h = deps.media.home(force = true).nonEmpty()
                    home = h
                    error = null
                    HomeMemo.last = profile to h
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (home == null) error = e else toast(context, context.getString(R.string.home_refresh_failed))
                } finally {
                    refreshing = false
                }
            }
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        when {
            current != null && current.rows.isNotEmpty() -> HomeContent(deps, nav, current)
            current != null -> LazyColumn(Modifier.fillMaxSize()) {
                item("empty") {
                    Box(Modifier.fillParentMaxSize()) {
                        ProfileButton(deps, nav, Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(12.dp))
                        if (!current.configured) {
                            EmptyState(
                                icon = Icons.Outlined.Settings,
                                title = stringResource(R.string.home_not_configured_title),
                                hint = stringResource(R.string.home_not_configured_hint),
                            ) {
                                OutlinedButton(onClick = { deps.media.invalidateHome(); reload++ }) { Text(stringResource(R.string.home_refresh)) }
                            }
                        } else {
                            EmptyState(
                                icon = Icons.Outlined.Movie,
                                title = stringResource(R.string.home_empty_title),
                                hint = stringResource(R.string.home_empty_hint),
                            )
                        }
                    }
                }
            }
            err != null -> LazyColumn(Modifier.fillMaxSize()) {
                item("error") {
                    Box(Modifier.fillParentMaxSize()) {
                        ProfileButton(deps, nav, Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(12.dp))
                        ErrorState(err, onRetry = { deps.media.invalidateHome(); reload++ })
                    }
                }
            }
            else -> LoadingSkeleton(hero = true, rows = 3)
        }
    }
}

@Composable
private fun HomeContent(deps: AppDeps, nav: Navigator, home: MediaHome) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val api = deps.api
    val rows = home.rows
    val continueRow = rows.firstOrNull { it.id == MediaRepository.ROW_CONTINUE }
    val heroCard = (continueRow ?: rows.first()).items.first()
    val heroKey = cardKey(heroCard)

    val details = remember { mutableStateMapOf<String, MediaTitleResponse>() }
    val watchlist = remember { mutableStateMapOf<String, Boolean>() }
    var heroTarget by remember { mutableStateOf<PlayTarget?>(null) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(heroKey) {
        heroTarget = null
        val d = details[heroKey] ?: runCatching { deps.media.title(heroCard.kind, heroCard.tmdbId) }.getOrNull()?.also { details[heroKey] = it }
        if (d != null) {
            if (heroKey !in watchlist) watchlist[heroKey] = d.inWatchlist == true
            heroTarget = runCatching { resolveTarget(deps, d) }.getOrNull()
        }
    }

    // Only the first poster occurrence of a title owns the shared-element key (duplicates clash).
    val sharedOwners = remember(home) {
        val out = HashMap<String, String>()
        rows.filter { it.id != MediaRepository.ROW_CONTINUE }.forEach { r -> r.items.forEach { c -> out.putIfAbsent(cardKey(c), r.id) } }
        out
    }

    fun openTitle(c: TitleCard) = nav.push(Dest.Title(c.kind, c.tmdbId))

    /** Play the best target of a card; no local file → open Title. */
    fun playCard(c: TitleCard) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                val key = cardKey(c)
                val d = details[key] ?: deps.media.title(c.kind, c.tmdbId).also { details[key] = it }
                val t = resolveTarget(deps, d)
                if (t != null) startPlayback(nav, t) else openTitle(c)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                openTitle(c)
            } finally {
                busy = false
            }
        }
    }

    fun toggleList(c: TitleCard) {
        val key = cardKey(c)
        val was = watchlist[key] == true
        watchlist[key] = !was
        scope.launch {
            runCatching { if (was) deps.media.removeWatchlist(c.kind, c.tmdbId) else deps.media.addWatchlist(c.kind, c.tmdbId) }
                .onSuccess { toast(context, context.getString(if (was) R.string.home_list_removed else R.string.home_list_added)) }
                .onFailure { watchlist[key] = was; toast(context, context.getString(R.string.home_list_failed)) }
        }
    }

    LazyColumn(
        state = rememberLazyListState(),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        item("hero") {
            Hero(
                deps = deps,
                nav = nav,
                card = heroCard,
                details = details[heroKey],
                target = heroTarget,
                inList = watchlist[heroKey] == true,
                onPlay = {
                    val t = heroTarget
                    if (t != null) startPlayback(nav, t) else playCard(heroCard)
                },
                onToggleList = { toggleList(heroCard) },
                onInfo = { openTitle(heroCard) },
            )
        }
        items(rows.distinctBy { it.id }, key = { it.id }) { row ->
            HomeRowView(deps, row, sharedOwners, onOpen = { openTitle(it) }, onPlay = { playCard(it) })
        }
    }
}

@Composable
private fun HomeRowView(
    deps: AppDeps,
    row: HomeRow,
    sharedOwners: Map<String, String>,
    onOpen: (TitleCard) -> Unit,
    onPlay: (TitleCard) -> Unit,
) {
    val title = row.titleFor(deps.lang)
    if (row.id == MediaRepository.ROW_CONTINUE) {
        CardRow(title, row.items) { c ->
            LandscapeCard(deps.api, c, continueSubtitle(c), onClick = { onPlay(c) })
        }
    } else {
        CardRow(title, row.items) { c ->
            PosterCard(
                deps.api, c,
                onClick = { onOpen(c) },
                sharedKey = if (sharedOwners[cardKey(c)] == row.id) posterKey(c.kind, c.tmdbId) else null,
            )
        }
    }
}

@Composable
private fun continueSubtitle(c: TitleCard): String? {
    val ne = c.nextEpisode
    if (ne != null && ne.season > 0 && ne.episode > 0) return stringResource(R.string.home_ep_code, ne.season.toInt(), ne.episode.toInt())
    val p = c.progress ?: return null
    if (p <= 0.0 || p >= 1.0) return null
    val left = ((1.0 - p) * 100).toInt().coerceIn(1, 99)
    return stringResource(R.string.home_left_pct, left)
}

@Composable
private fun Hero(
    deps: AppDeps,
    nav: Navigator,
    card: TitleCard,
    details: MediaTitleResponse?,
    target: PlayTarget?,
    inList: Boolean,
    onPlay: () -> Unit,
    onToggleList: () -> Unit,
    onInfo: () -> Unit,
) {
    val api = deps.api
    val scrim = Mixai.colors.scrimBase
    val onScrim = Mixai.colors.onScrim
    val screenH = LocalConfiguration.current.screenHeightDp.dp
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val heroH = min(maxWidth / 0.62f, screenH * 0.72f)
        Box(Modifier.fillMaxWidth().height(heroH).background(scrim)) {
            val url = api.tmdbImageUrl(TmdbSize.backdrop(1280), card.backdropPath ?: card.posterPath)
            if (url != null) {
                AsyncImage(url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            }
            // Top scrim (status bar + profile button) and bottom scrim (text).
            Box(
                Modifier.fillMaxWidth().height(120.dp).align(Alignment.TopCenter)
                    .background(Brush.verticalGradient(listOf(scrim.copy(alpha = 0.6f), Color.Transparent))),
            )
            Box(
                Modifier.fillMaxSize().background(
                    Brush.verticalGradient(0f to Color.Transparent, 0.4f to Color.Transparent, 0.78f to scrim.copy(alpha = 0.85f), 1f to scrim),
                ),
            )
            ProfileButton(deps, nav, Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(12.dp))

            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().widthIn(max = 640.dp).padding(horizontal = 20.dp, vertical = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                val t = details?.title
                TitleLogo(api, t?.logoPath, card.title, height = 96.dp, maxWidth = 300.dp, color = onScrim)
                val chips = buildList {
                    yearOf(card.releaseDate ?: t?.releaseDate)?.let { add(it) }
                    if (t != null) addAll(genresOf(t).take(2))
                    if (details != null) addAll(formatChips(details.files))
                }
                if (chips.isNotEmpty()) {
                    Text(
                        chips.joinToString("  ·  "),
                        style = MaterialTheme.typography.labelLarge,
                        color = onScrim.copy(alpha = 0.85f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    HeroAction(
                        icon = if (inList) Icons.Filled.Check else Icons.Filled.Add,
                        label = stringResource(R.string.home_my_list),
                        color = onScrim,
                        onClick = onToggleList,
                    )
                    Button(
                        onClick = onPlay,
                        colors = ButtonDefaults.buttonColors(containerColor = onScrim, contentColor = scrim),
                        contentPadding = PaddingValues(horizontal = 28.dp, vertical = 12.dp),
                    ) {
                        Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.size(8.dp))
                        Text(playLabel(target), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    HeroAction(
                        icon = Icons.Outlined.Info,
                        label = stringResource(R.string.home_info),
                        color = onScrim,
                        onClick = onInfo,
                    )
                }
            }
        }
    }
}

@Composable
private fun HeroAction(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, color: Color, onClick: () -> Unit) {
    Column(
        Modifier.clip(MaterialTheme.shapes.small).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(26.dp))
        Spacer(Modifier.height(2.dp))
        Text(label, style = MaterialTheme.typography.labelSmall, color = color, maxLines = 1)
    }
}
