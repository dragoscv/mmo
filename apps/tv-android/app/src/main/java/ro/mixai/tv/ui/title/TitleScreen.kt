@file:OptIn(ExperimentalFoundationApi::class)

package ro.mixai.tv.ui.title

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.MediaSeasonResponse
import ro.mixai.tv.data.generated.MediaTitleResponse
import ro.mixai.tv.data.generated.SeasonEpisode
import ro.mixai.tv.data.generated.VersionedFile
import ro.mixai.tv.ui.components.BadgeTone
import ro.mixai.tv.ui.components.CardBadge
import ro.mixai.tv.ui.components.Choice
import ro.mixai.tv.ui.components.ChoiceDialog
import ro.mixai.tv.ui.components.IconActionButton
import ro.mixai.tv.ui.components.LandscapeCard
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.LocalBackdrop
import ro.mixai.tv.ui.components.MediaRow
import ro.mixai.tv.ui.components.MetaChips
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PosterCard
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.RowTitle
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.components.SkeletonPosterRow
import ro.mixai.tv.ui.components.formatRuntime
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.RestorableFocus
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.nav.rememberRestorableFocus
import ro.mixai.tv.ui.nav.sharedPoster
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

// Unified title page (WP16-19): full-bleed backdrop, logo, chips, tagline, overview, genres,
// Play/Resume (best version / next episode), Trailer, versions, My list, Mark watched, offers,
// seasons + episodes inline (TV), cast and "More like this". The poster morphs from the card
// (shared element `poster-<kind>-<tmdbId>`).

/**
 * Title list scrolling: a focused element that is already fully visible never scrolls the page
 * (the TV default pivots it to ~30 % from the top, which cut the logo off on open, critic P2-10);
 * anything off screen is brought to that pivot.
 */
private val TitleBringIntoView = object : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float =
        if (offset >= 0f && offset + size <= containerSize) 0f else offset - containerSize * 0.3f
}

@Composable
fun TitleScreen(deps: ScreenDeps, nav: Navigator, kind: String, tmdbId: Long) {
    var data by remember { mutableStateOf<MediaTitleResponse?>(null) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val rf = rememberRestorableFocus("title")
    val backdrop = LocalBackdrop.current
    val density = LocalDensity.current
    val backdropPx = with(density) { 1280.dp.roundToPx() }

    LaunchedEffect(kind, tmdbId, reload) {
        error = null
        try {
            val d = deps.media.title(kind, tmdbId)
            data = d
            backdrop.showNow(deps.api.tmdbImageUrl(TmdbSize.backdrop(backdropPx), d.title.backdropPath ?: d.title.posterPath))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (data == null) error = e
        }
    }

    val d = data
    val err = error
    when {
        d != null -> TitleBody(deps, nav, kind, tmdbId, d, rf, onReload = { reload++ })
        err != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            TitleError(err, onRetry = { reload++ }, onBack = { nav.pop() })
        }
        else -> LoadingState(rows = 1)
    }
}

@Composable
private fun TitleBody(deps: ScreenDeps, nav: Navigator, kind: String, tmdbId: Long, d: MediaTitleResponse, rf: RestorableFocus, onReload: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val api = deps.api
    val t = d.title
    val isTv = t.kind == "tv" || kind == "tv"

    var preferredFile by rememberSaveable { mutableStateOf<String?>(null) }
    var target by remember { mutableStateOf<PlayTarget?>(null) }
    var resolved by remember { mutableStateOf(false) }
    var inList by remember(d) { mutableStateOf(d.inWatchlist == true) }
    var showVersions by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(d, preferredFile) {
        target = runCatching { resolveTarget(deps, d, preferredFile) }.getOrNull()
        resolved = true
    }
    LaunchedEffect(resolved) { if (resolved) rf.restoreFocus() }

    // Files of the thing the primary button plays (versions picker).
    val targetFiles: List<VersionedFile> = remember(d, target) {
        val tg = target
        when {
            !isTv -> d.files.filter { !it.isEpisode() }.ifEmpty { d.files }
            tg != null -> d.files.filter { it.season == tg.ref.season && it.episode == tg.ref.episode }
            else -> emptyList()
        }.sortedByDescending { it.version.rank }
    }
    val completed = d.progress.isNotEmpty() && d.progress.all { it.completed } && !isTv
    val trailer = remember(t) { trailerKey(t) }
    // Nothing of this title on the server (Tizen `canPlay`, HomeHero.tsx): say so instead of a Back CTA.
    val notInLibrary = resolved && target == null && d.files.isEmpty()
    val hasOffers = d.availability.offers.isNotEmpty()
    val listState = rememberLazyListState()

    fun toggleList() {
        val was = inList
        inList = !was
        scope.launch {
            runCatching { if (was) deps.media.removeWatchlist(t.kind, t.tmdbId) else deps.media.addWatchlist(t.kind, t.tmdbId) }
                .onSuccess { toast(context, context.getString(if (was) R.string.wp16_title_list_removed else R.string.wp16_title_list_added)) }
                .onFailure { inList = was; toast(context, context.getString(R.string.wp16_title_action_failed)) }
        }
    }

    fun play(tg: PlayTarget, fromStart: Boolean = false) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                startPlayback(deps, nav, tg, fromStart)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                toast(context, context.getString(R.string.wp16_title_play_failed, e.message ?: ""))
            } finally {
                busy = false
            }
        }
    }

    CompositionLocalProvider(LocalBringIntoViewSpec provides TitleBringIntoView) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val topHeight = maxHeight * 0.78f
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 56.dp),
            verticalArrangement = Arrangement.spacedBy(28.dp),
        ) {
            item("top") {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = topHeight).padding(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = MixaiFocus.overscanTop),
                    horizontalArrangement = Arrangement.spacedBy(40.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        TitleLogo(api, t.logoPath, t.title, height = 120.dp, maxWidth = 560.dp)
                        MetaChips(
                            year = yearOf(t.releaseDate),
                            age = ageLabel(t.age, t.certification),
                            runtimeMin = t.runtime?.takeIf { !isTv },
                            formats = formatChips(d.files),
                            rating = t.voteAverage,
                        )
                        val extra = buildList {
                            if (isTv) t.numberOfSeasons?.takeIf { it > 0 }?.let { add(stringResource(R.string.wp16_title_seasons, it.toInt())) }
                            addAll(genresOf(t).take(3))
                        }
                        if (extra.isNotEmpty()) Text(extra.joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground, maxLines = 1)
                        t.tagline?.takeIf { it.isNotBlank() }?.let {
                            Text(it, style = MaterialTheme.typography.titleMedium, color = Tokens.foreground.copy(alpha = 0.9f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        t.overview?.takeIf { it.isNotBlank() }?.let {
                            Text(it, style = MaterialTheme.typography.bodyLarge, color = Tokens.foreground.copy(alpha = 0.85f), maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 760.dp))
                        }
                        if (completed) Text(stringResource(R.string.wp16_title_watched), style = MaterialTheme.typography.labelLarge, color = Tokens.success)
                        if (notInLibrary) {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.widthIn(max = 760.dp)) {
                                Text(stringResource(R.string.wp16_title_not_in_library), style = MaterialTheme.typography.titleMedium, color = Tokens.warning)
                                Text(
                                    stringResource(if (hasOffers) R.string.wp16_title_not_in_library_offers else R.string.wp16_title_not_in_library_hint),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = Tokens.mutedForeground,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        Row(
                            Modifier.focusRestorer().padding(top = 8.dp).onFocusChanged {
                                // Keep the logo and chips on screen whenever focus is in the action row.
                                if (it.hasFocus && (listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 0)) {
                                    scope.launch { delay(16); listState.animateScrollToItem(0) }
                                }
                            },
                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            val primaryMod = Modifier.focusRequester(rf.requester).then(rf.item("play"))
                            val tg = target
                            var listIsPrimary = false
                            if (tg != null) {
                                PrimaryButton(playLabel(tg), { play(tg) }, primaryMod, icon = Icons.Filled.PlayArrow)
                                if (tg.resumeMs > 0) SecondaryButton(stringResource(R.string.wp16_title_start_over), { play(tg, fromStart = true) }, rf.item("startover"), icon = MixaiIcons.Replay10)
                            } else if (trailer != null) {
                                PrimaryButton(stringResource(R.string.wp16_title_trailer), { launchTrailer(context, trailer) }, primaryMod, icon = Icons.Filled.PlayArrow)
                            } else if (hasOffers) {
                                PrimaryButton(stringResource(R.string.wp16_title_where_short), { ro.mixai.tv.data.ProviderLauncher.launch(context, d.availability.offers.first()) }, primaryMod, icon = Icons.Filled.PlayArrow)
                            } else {
                                // Never "Back" as the primary action (critic P1-5): My list is the first actionable thing.
                                listIsPrimary = true
                                PrimaryButton(
                                    stringResource(if (inList) R.string.wp16_title_list_remove else R.string.wp16_title_list_add),
                                    { toggleList() },
                                    Modifier.focusRequester(rf.requester).then(rf.item("list")),
                                    icon = if (inList) MixaiIcons.Bookmark else MixaiIcons.BookmarkBorder,
                                )
                            }
                            if (trailer != null && tg != null) SecondaryButton(stringResource(R.string.wp16_title_trailer), { launchTrailer(context, trailer) }, rf.item("trailer"))
                            if (targetFiles.size > 1) {
                                IconActionButton(MixaiIcons.Hd, stringResource(R.string.wp16_title_versions), { showVersions = true }, rf.item("versions"))
                            }
                            if (!listIsPrimary) IconActionButton(
                                icon = if (inList) MixaiIcons.Bookmark else MixaiIcons.BookmarkBorder,
                                label = stringResource(if (inList) R.string.wp16_title_list_remove else R.string.wp16_title_list_add),
                                onClick = { toggleList() },
                                selected = inList,
                                modifier = rf.item("list"),
                            )
                            if (notInLibrary) {
                                SecondaryButton(stringResource(R.string.wp16_title_search_library), { nav.push(Route.Search(t.title)) }, rf.item("search"))
                            }
                            val watchRef: MediaRef? = if (!isTv) MediaRef(t.kind.ifBlank { "movie" }, t.tmdbId) else target?.ref
                            if (watchRef != null && !completed) {
                                IconActionButton(
                                    icon = Icons.Filled.Check,
                                    label = stringResource(R.string.wp16_title_mark_watched),
                                    onClick = {
                                        scope.launch {
                                            runCatching { deps.progressSync.markWatched(watchRef, t.runtime?.takeIf { !isTv }?.let { it * 60.0 }) }
                                            toast(context, context.getString(R.string.wp16_title_marked))
                                            onReload()
                                        }
                                    },
                                    modifier = rf.item("watched"),
                                )
                            }
                        }
                    }
                    val posterUrl = api.tmdbImageUrl(TmdbSize.poster(with(LocalDensity.current) { 260.dp.roundToPx() }), t.posterPath)
                    if (posterUrl != null) {
                        Box(Modifier.padding(bottom = 4.dp).width(260.dp).aspectRatio(2f / 3f).clip(MixaiFocus.cardShape)) {
                            AsyncImage(
                                model = posterUrl,
                                contentDescription = t.title,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize().sharedPoster("$kind-$tmdbId"),
                            )
                        }
                    }
                }
            }

            if (isTv && !t.seasons.isNullOrEmpty()) item("episodes") {
                EpisodesSection(deps, nav, d, rf, onPlay = { play(it) })
            }

            if (d.availability.offers.isNotEmpty()) item("offers") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    RowTitle(stringResource(R.string.wp16_title_where))
                    LazyRow(
                        Modifier.fillMaxWidth().focusRestorer(),
                        contentPadding = PaddingValues(horizontal = MixaiFocus.overscan, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(d.availability.offers.distinctBy { it.providerId to it.type }.take(12), key = { "${it.providerId}-${it.type}" }) { o ->
                            OfferButton(api, o, rf.item("offer:${o.providerId}-${o.type}"))
                        }
                    }
                    if (d.availability.attribution.isNotEmpty()) {
                        Text(
                            stringResource(R.string.wp16_title_attribution, d.availability.attribution.joinToString(", ")),
                            style = MaterialTheme.typography.bodySmall,
                            color = Tokens.mutedForeground,
                            modifier = Modifier.padding(horizontal = MixaiFocus.overscan),
                        )
                    }
                }
            }

            if (t.cast.isNotEmpty()) item("cast") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    RowTitle(stringResource(R.string.wp16_title_cast))
                    LazyRow(
                        Modifier.fillMaxWidth().focusRestorer(),
                        contentPadding = PaddingValues(horizontal = MixaiFocus.overscan, vertical = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(20.dp),
                    ) {
                        items(t.cast.take(20), key = { "${it.id}-${it.role}" }) { p ->
                            CastItem(api, p, onClick = { nav.push(Route.Search(p.name)) }, modifier = rf.item("cast:${p.id}"))
                        }
                    }
                }
            }

            val more = (t.recommendations + t.similar).distinctBy { it.kind to it.tmdbId }.filter { it.tmdbId != tmdbId }.take(24)
            if (more.isNotEmpty()) item("more") {
                val posterPx = with(LocalDensity.current) { ro.mixai.tv.ui.components.POSTER_WIDTH.roundToPx() }
                MediaRow(
                    title = stringResource(R.string.wp16_title_more),
                    items = more,
                    key = { "${it.kind}-${it.tmdbId}" },
                    onClick = { c -> nav.push(Route.Title(c.kind.ifBlank { kind }, c.tmdbId)) },
                ) { c, _, onFocus, onClick ->
                    PosterCard(
                        imageUrl = api.tmdbImageUrl(TmdbSize.poster(posterPx), c.posterPath),
                        title = c.title,
                        subtitle = yearOf(c.releaseDate),
                        onClick = onClick,
                        onFocus = onFocus,
                        badges = if (c.inLibrary == true) listOf(CardBadge(stringResource(R.string.wp16_title_badge_library), BadgeTone.Accent)) else emptyList(),
                        sharedKey = "${c.kind.ifBlank { kind }}-${c.tmdbId}",
                        modifier = rf.item("more:${c.kind}-${c.tmdbId}"),
                    )
                }
            }
        }
    }
    }

    ChoiceDialog(
        title = stringResource(R.string.wp16_title_versions),
        options = targetFiles.map { f ->
            Choice(f.serverFileId, f.version.label.ifBlank { f.path.substringAfterLast('/').substringAfterLast('\\') }, sizeLabel(f.size))
        },
        selected = target?.fileId,
        onPick = { id -> preferredFile = id; showVersions = false },
        onDismiss = { showVersions = false },
        visible = showVersions,
    )
}

private fun sizeLabel(bytes: Long): String? =
    if (bytes <= 0) null else "%.1f GB".format(bytes / 1_073_741_824.0)

/** Season tabs (season 0 last) + the episodes of the selected season as a row. */
@Composable
private fun EpisodesSection(deps: ScreenDeps, nav: Navigator, d: MediaTitleResponse, rf: RestorableFocus, onPlay: (PlayTarget) -> Unit) {
    val context = LocalContext.current
    val t = d.title
    val seasons = remember(t) { orderedSeasons(t.seasons.orEmpty().map { it.seasonNumber }) }
    var selected by rememberSaveable { mutableStateOf(d.nextUp?.season?.takeIf { it in seasons } ?: seasons.first()) }
    val cache = remember { mutableStateMapOf<Long, MediaSeasonResponse>() }
    var failed by remember { mutableStateOf(false) }

    LaunchedEffect(selected) {
        failed = false
        if (selected !in cache) {
            runCatching { deps.media.season(t.tmdbId, selected) }.onSuccess { cache[selected] = it }.onFailure { failed = true }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        RowTitle(stringResource(R.string.wp16_title_episodes))
        LazyRow(
            Modifier.fillMaxWidth().focusRestorer(),
            contentPadding = PaddingValues(horizontal = MixaiFocus.overscan),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(seasons, key = { it }) { s ->
                val name = t.seasons.orEmpty().firstOrNull { it.seasonNumber == s }?.name
                TvPill(
                    label = seasonLabel(s, name),
                    selected = s == selected,
                    onClick = { if (s == selected) nav.push(Route.Season(t.tmdbId, s)) else selected = s },
                    onLongClick = { nav.push(Route.Season(t.tmdbId, s)) },
                    modifier = rf.item("season:$s"),
                )
            }
        }
        val season = cache[selected]
        when {
            season != null -> {
                val stillPx = with(LocalDensity.current) { 320.dp.roundToPx() }
                MediaRow(
                    title = "",
                    items = season.episodes,
                    key = { "${it.seasonNumber}-${it.episodeNumber}" },
                    onClick = { e -> playEpisode(context, t.tmdbId, e, onPlay) },
                    trailing = null,
                ) { e, _, onFocus, onClick ->
                    EpisodeCard(deps, e, stillPx, onClick, onLongClick = { nav.push(Route.Season(t.tmdbId, e.seasonNumber)) }, onFocus, rf.item("ep:${e.seasonNumber}:${e.episodeNumber}"))
                }
            }
            failed -> Text(stringResource(R.string.wp16_title_season_failed), style = MaterialTheme.typography.bodyMedium, color = Tokens.destructive, modifier = Modifier.padding(horizontal = MixaiFocus.overscan))
            else -> SkeletonPosterRow(count = 5, width = 320.dp, aspect = 16f / 9f)
        }
    }
}

/** Season numbers ascending with specials (0) last. */
fun orderedSeasons(nums: List<Long>): List<Long> {
    val sorted = nums.distinct().sorted()
    return sorted.filter { it != 0L } + sorted.filter { it == 0L }
}

@Composable
fun seasonLabel(n: Long, name: String?): String =
    if (n == 0L) name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.wp16_title_specials) else stringResource(R.string.wp16_title_season_n, n)

fun playEpisode(context: android.content.Context, tmdbId: Long, e: SeasonEpisode, onPlay: (PlayTarget) -> Unit) {
    val tg = episodeTarget(tmdbId, e.seasonNumber, e.episodeNumber, e.files, e.progress)
    if (tg != null) onPlay(tg) else toast(context, context.getString(R.string.wp16_title_not_on_server))
}

@Composable
fun EpisodeCard(
    deps: ScreenDeps,
    e: SeasonEpisode,
    stillPx: Int,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)?,
    onFocus: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = e.progress
    val frac = if (p != null && !p.completed && p.durationSec > 0) (p.positionSec / p.durationSec).toFloat() else null
    val badges = buildList {
        if (e.files.isNotEmpty()) add(CardBadge(stringResource(R.string.wp16_title_on_server), BadgeTone.Success))
        if (p?.completed == true) add(CardBadge(stringResource(R.string.wp16_title_watched), BadgeTone.Neutral))
    }
    val runtime = e.runtime?.takeIf { it > 0 }?.let { formatRuntime(it) }
    LandscapeCard(
        imageUrl = deps.api.tmdbImageUrl(TmdbSize.backdrop(stillPx), e.stillPath),
        title = stringResource(R.string.wp16_title_episode_name, e.episodeNumber, e.name.ifBlank { stringResource(R.string.wp16_title_episode_fallback, e.episodeNumber) }),
        caption = listOfNotNull(stringResource(R.string.wp16_title_episode_code, e.seasonNumber, e.episodeNumber), runtime).joinToString(" · "),
        progress = frac,
        badges = badges,
        onClick = onClick,
        onLongClick = onLongClick,
        onFocus = onFocus,
        modifier = modifier,
    )
}

/** Large still used by the season page. */
@Composable
fun EpisodeStill(url: String?, modifier: Modifier = Modifier) {
    Box(modifier.width(360.dp).aspectRatio(16f / 9f).clip(MixaiFocus.cardShape)) {
        if (url != null) AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
}
