package ro.mixai.app.ui.title

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.outlined.ChildCare
import androidx.compose.material.icons.outlined.Hd
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
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
import ro.mixai.app.ui.components.ChipRow
import ro.mixai.app.ui.components.EmptyState
import ro.mixai.app.ui.components.ErrorState
import ro.mixai.app.ui.components.LoadingSkeleton
import ro.mixai.app.ui.components.PosterCard
import ro.mixai.app.ui.components.SkeletonBox
import ro.mixai.app.ui.components.sharedPoster
import ro.mixai.app.ui.media.PlayTarget
import ro.mixai.app.ui.media.episodeTarget
import ro.mixai.app.ui.media.formatChips
import ro.mixai.app.ui.media.genresOf
import ro.mixai.app.ui.media.isEpisode
import ro.mixai.app.ui.media.posterKey
import ro.mixai.app.ui.media.resolveTarget
import ro.mixai.app.ui.media.startPlayback
import ro.mixai.app.ui.media.trailerKey
import ro.mixai.app.ui.media.yearOf
import ro.mixai.app.ui.theme.Mixai
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.MediaSeasonResponse
import ro.mixai.tv.data.generated.MediaTitleResponse
import ro.mixai.tv.data.generated.TitleDetails
import ro.mixai.tv.data.generated.VersionedFile

// Phone title page (WP16-46): parallax backdrop, poster that morphs from the card, logo, chips,
// expandable overview, Play/Resume (best version / next episode), From start, versions sheet,
// Trailer, My list, Mark watched, seasons + episodes (series), cast, where to watch, more like this.

@Composable
fun TitleScreen(deps: AppDeps, nav: Navigator, kind: String, tmdbId: Long) {
    var data by remember(kind, tmdbId) { mutableStateOf<MediaTitleResponse?>(null) }
    var error by remember(kind, tmdbId) { mutableStateOf<Throwable?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(kind, tmdbId, reload) {
        error = null
        try {
            data = deps.media.title(kind, tmdbId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (data == null) error = e
        }
    }

    val d = data
    val err = error
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        when {
            d != null -> TitleBody(deps, nav, kind, tmdbId, d, onReload = { reload++ })
            err != null -> TitleError(err, onRetry = { reload++ }, onBack = { nav.pop() })
            else -> LoadingSkeleton(hero = true, rows = 2)
        }
        IconButton(
            onClick = { nav.pop() },
            modifier = Modifier.statusBarsPadding().padding(8.dp),
            colors = IconButtonDefaults.iconButtonColors(
                containerColor = Mixai.colors.scrimBase.copy(alpha = 0.45f),
                contentColor = Mixai.colors.onScrim,
            ),
        ) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
        }
    }
}

@Composable
private fun TitleError(e: Throwable, onRetry: () -> Unit, onBack: () -> Unit) {
    when ((e as? ApiException)?.status) {
        403 -> EmptyState(
            icon = Icons.Outlined.ChildCare,
            title = stringResource(R.string.title_age_title),
            hint = stringResource(R.string.title_age_message),
        ) { OutlinedButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } }
        503 -> EmptyState(
            icon = Icons.Outlined.Settings,
            title = stringResource(R.string.error_title),
            hint = stringResource(R.string.title_tmdb_missing),
        ) { Button(onClick = onRetry) { Text(stringResource(R.string.action_retry)) } }
        else -> ErrorState(e, onRetry)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TitleBody(deps: AppDeps, nav: Navigator, kind: String, tmdbId: Long, d: MediaTitleResponse, onReload: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val api = deps.api
    val t = d.title
    val isTv = t.kind == "tv" || kind == "tv"

    var preferredFile by rememberSaveable { mutableStateOf<String?>(null) }
    var target by remember { mutableStateOf<PlayTarget?>(null) }
    var inList by remember(d) { mutableStateOf(d.inWatchlist == true) }
    var showVersions by remember { mutableStateOf(false) }

    LaunchedEffect(d, preferredFile) {
        target = runCatching { resolveTarget(deps, d, preferredFile) }.getOrNull()
    }

    val targetFiles: List<VersionedFile> = remember(d, target) {
        val tg = target
        when {
            !isTv -> d.files.filter { !it.isEpisode() }.ifEmpty { d.files }
            tg != null -> d.files.filter { it.season == tg.ref.season && it.episode == tg.ref.episode }
            else -> emptyList()
        }.sortedByDescending { it.version.rank }
    }
    val completed = !isTv && d.progress.isNotEmpty() && d.progress.all { it.completed }
    val trailer = remember(t) { trailerKey(t) }
    val listState = rememberLazyListState()

    fun toggleList() {
        val was = inList
        inList = !was
        scope.launch {
            runCatching { if (was) deps.media.removeWatchlist(t.kind.ifBlank { kind }, t.tmdbId) else deps.media.addWatchlist(t.kind.ifBlank { kind }, t.tmdbId) }
                .onSuccess { toast(context, context.getString(if (was) R.string.title_list_removed else R.string.title_list_added)) }
                .onFailure { inList = was; toast(context, context.getString(R.string.title_action_failed)) }
        }
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        item("header") { Header(api, kind, tmdbId, t, listState) }

        item("meta") {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val chips = buildList {
                    yearOf(t.releaseDate)?.let { add(it) }
                    ageLabel(t.age, t.certification)?.let { add(it) }
                    if (!isTv) runtimeLabel(t.runtime)?.let { add(it) }
                    if (isTv) t.numberOfSeasons?.takeIf { it > 0 }?.let { add(stringResource(R.string.title_seasons_count, it.toInt())) }
                    addAll(formatChips(d.files))
                    t.voteAverage?.takeIf { it > 0 }?.let { add(stringResource(R.string.title_rating, "%.1f".format(it))) }
                }
                if (chips.isNotEmpty()) ChipRow(chips)
                val genres = genresOf(t).take(3)
                if (genres.isNotEmpty()) {
                    Text(genres.joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
                if (completed) Text(stringResource(R.string.title_watched), style = MaterialTheme.typography.labelLarge, color = Mixai.colors.success)

                PrimaryActions(
                    target = target,
                    trailer = trailer,
                    hasOffers = d.availability.offers.isNotEmpty(),
                    onPlay = { tg, fromStart -> startPlayback(nav, tg, fromStart) },
                    onTrailer = { k -> launchTrailer(context, k) },
                    onWhere = { PhoneProviderLauncher.launch(context, d.availability.offers.first()) },
                )

                SecondaryActions(
                    inList = inList,
                    showVersions = targetFiles.size > 1,
                    showTrailer = trailer != null && target != null,
                    canMarkWatched = !completed && (!isTv || target != null),
                    onToggleList = { toggleList() },
                    onVersions = { showVersions = true },
                    onTrailer = { trailer?.let { launchTrailer(context, it) } },
                    onMarkWatched = {
                        val ref: MediaRef? = if (!isTv) MediaRef(t.kind.ifBlank { "movie" }, t.tmdbId) else target?.ref
                        if (ref != null) scope.launch {
                            runCatching { deps.progressSync.markWatched(ref, t.runtime?.takeIf { !isTv }?.let { it * 60.0 }) }
                                .onSuccess { toast(context, context.getString(R.string.title_marked)); onReload() }
                                .onFailure { toast(context, context.getString(R.string.title_action_failed)) }
                        }
                    },
                )

                t.tagline?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                t.overview?.takeIf { it.isNotBlank() }?.let { Overview(it) }
            }
        }

        if (isTv && !t.seasons.isNullOrEmpty()) item("episodes") {
            EpisodesSection(deps, nav, d)
        }

        if (t.cast.isNotEmpty()) item("cast") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionTitle(stringResource(R.string.title_cast))
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(t.cast.distinctBy { "${it.id}-${it.role}" }.take(20), key = { "${it.id}-${it.role}" }) { p -> CastItem(api, p) }
                }
            }
        }

        if (d.availability.offers.isNotEmpty()) item("offers") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionTitle(stringResource(R.string.title_where))
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(d.availability.offers.distinctBy { it.providerId to it.type }.take(12), key = { "${it.providerId}-${it.type}" }) { o ->
                        OfferButton(api, o)
                    }
                }
                if (d.availability.attribution.isNotEmpty()) {
                    Text(
                        stringResource(R.string.title_attribution, d.availability.attribution.joinToString(", ")),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                }
            }
        }

        val more = (t.recommendations + t.similar).distinctBy { it.kind to it.tmdbId }.filter { it.tmdbId != tmdbId }.take(24)
        if (more.isNotEmpty()) item("more") {
            CardRow(stringResource(R.string.title_more), more) { c ->
                val k = c.kind.ifBlank { kind }
                PosterCard(api, c, onClick = { nav.push(Dest.Title(k, c.tmdbId)) }, sharedKey = posterKey(k, c.tmdbId))
            }
        }

        item("bottom") { Spacer(Modifier.navigationBarsPadding()) }
    }

    if (showVersions) {
        val sheetState = rememberModalBottomSheetState()
        ModalBottomSheet(onDismissRequest = { showVersions = false }, sheetState = sheetState) {
            Text(stringResource(R.string.title_versions), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            targetFiles.forEach { f ->
                val selected = f.serverFileId == target?.fileId
                ListItem(
                    headlineContent = { Text(f.version.label.ifBlank { f.path.substringAfterLast('/').substringAfterLast('\\') }, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = {
                        val parts = listOfNotNull(f.version.resolution, f.version.hdr, f.version.edition, sizeLabel(f.size))
                        if (parts.isNotEmpty()) Text(parts.joinToString(" · "))
                    },
                    leadingContent = { RadioButton(selected = selected, onClick = null) },
                    modifier = Modifier.clickable {
                        preferredFile = f.serverFileId
                        showVersions = false
                    },
                )
            }
            Spacer(Modifier.navigationBarsPadding().height(16.dp))
        }
    }
}

private fun sizeLabel(bytes: Long): String? = if (bytes <= 0) null else "%.1f GB".format(bytes / 1_073_741_824.0)

/** Backdrop (parallax 0.5x) + scrim + poster thumbnail (shared element) + logo / title. */
@Composable
private fun Header(api: MmoApi, kind: String, tmdbId: Long, t: TitleDetails, listState: LazyListState) {
    val scrim = Mixai.colors.scrimBase
    val onScrim = Mixai.colors.onScrim
    val screenH = LocalConfiguration.current.screenHeightDp.dp
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val h = min(maxWidth * 0.95f, screenH * 0.62f)
        Box(Modifier.fillMaxWidth().height(h).clip(androidx.compose.ui.graphics.RectangleShape).background(scrim)) {
            val url = api.tmdbImageUrl(TmdbSize.backdrop(1280), t.backdropPath ?: t.posterPath)
            if (url != null) {
                AsyncImage(
                    url, contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize().graphicsLayer {
                        translationY = if (listState.firstVisibleItemIndex == 0) listState.firstVisibleItemScrollOffset * 0.5f else 0f
                    },
                )
            }
            Box(
                Modifier.fillMaxWidth().height(110.dp).align(Alignment.TopCenter)
                    .background(Brush.verticalGradient(listOf(scrim.copy(alpha = 0.55f), Color.Transparent))),
            )
            Box(
                Modifier.fillMaxSize().background(
                    Brush.verticalGradient(0f to Color.Transparent, 0.45f to Color.Transparent, 0.85f to scrim.copy(alpha = 0.85f), 1f to scrim),
                ),
            )
            Row(
                Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                Box(
                    Modifier.width(104.dp).aspectRatio(2f / 3f).sharedPoster(posterKey(kind, tmdbId))
                        .clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.surfaceContainerHigh),
                ) {
                    val poster = api.tmdbImageUrl(TmdbSize.poster(342), t.posterPath)
                    if (poster != null) AsyncImage(poster, contentDescription = t.title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
                Column(Modifier.weight(1f)) {
                    TitleLogo(api, t.logoPath, t.title, height = 72.dp, maxWidth = 260.dp, color = onScrim)
                }
            }
        }
    }
}

@Composable
private fun PrimaryActions(
    target: PlayTarget?,
    trailer: String?,
    hasOffers: Boolean,
    onPlay: (PlayTarget, Boolean) -> Unit,
    onTrailer: (String) -> Unit,
    onWhere: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().widthIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when {
            target != null -> {
                Button(onClick = { onPlay(target, false) }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(playLabel(target), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (target.resumeMs > 0) {
                    OutlinedButton(onClick = { onPlay(target, true) }, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Filled.Replay, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(R.string.title_from_start))
                    }
                }
            }
            trailer != null -> Button(onClick = { onTrailer(trailer) }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Filled.PlayArrow, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.title_trailer))
            }
            hasOffers -> Button(onClick = onWhere, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.Movie, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.title_where_short))
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SecondaryActions(
    inList: Boolean,
    showVersions: Boolean,
    showTrailer: Boolean,
    canMarkWatched: Boolean,
    onToggleList: () -> Unit,
    onVersions: () -> Unit,
    onTrailer: () -> Unit,
    onMarkWatched: () -> Unit,
) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        FilledTonalButton(onClick = onToggleList) {
            Icon(if (inList) Icons.Filled.Check else Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(if (inList) R.string.title_list_remove else R.string.title_list_add))
        }
        if (showTrailer) FilledTonalButton(onClick = onTrailer) {
            Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.title_trailer))
        }
        if (showVersions) FilledTonalButton(onClick = onVersions) {
            Icon(Icons.Outlined.Hd, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.title_versions))
        }
        if (canMarkWatched) FilledTonalButton(onClick = onMarkWatched) {
            Icon(Icons.Filled.DoneAll, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.title_mark_watched))
        }
    }
}

@Composable
private fun Overview(text: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.animateContentSize()) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = if (expanded) Int.MAX_VALUE else 4,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.clickable { expanded = !expanded },
        )
        TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(horizontal = 0.dp)) {
            Text(stringResource(if (expanded) R.string.title_read_less else R.string.title_read_more))
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 16.dp))
}

/** Season tabs + episodes of the selected season. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EpisodesSection(deps: AppDeps, nav: Navigator, d: MediaTitleResponse) {
    val context = LocalContext.current
    val t = d.title
    val seasons = remember(t) { orderedSeasons(t.seasons.orEmpty().map { it.seasonNumber }) }
    if (seasons.isEmpty()) return
    var selected by rememberSaveable(t.tmdbId) { mutableStateOf(d.nextUp?.season?.takeIf { it in seasons } ?: seasons.first()) }
    val cache = remember { mutableStateMapOf<Long, MediaSeasonResponse>() }
    var failed by remember { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }

    LaunchedEffect(selected, retry) {
        failed = false
        if (selected !in cache) {
            try {
                cache[selected] = deps.media.season(t.tmdbId, selected)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                failed = true
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle(stringResource(R.string.title_episodes))
        val idx = seasons.indexOf(selected).coerceAtLeast(0)
        PrimaryScrollableTabRow(selectedTabIndex = idx, edgePadding = 16.dp) {
            seasons.forEach { s ->
                val name = t.seasons.orEmpty().firstOrNull { it.seasonNumber == s }?.name
                Tab(
                    selected = s == selected,
                    onClick = { selected = s },
                    text = {
                        Text(
                            if (s == 0L) name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.title_specials)
                            else stringResource(R.string.title_season_n, s.toInt()),
                            maxLines = 1,
                        )
                    },
                )
            }
        }
        val season = cache[selected]
        when {
            season != null -> Column {
                season.episodes.forEachIndexed { i, e ->
                    if (i > 0) HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
                    EpisodeRow(deps.api, e, onClick = {
                        val tg = episodeTarget(t.tmdbId, e.seasonNumber, e.episodeNumber, e.files, e.progress)
                        if (tg != null) startPlayback(nav, tg) else toast(context, context.getString(R.string.title_not_on_server))
                    })
                }
            }
            failed -> Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.title_season_failed), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                TextButton(onClick = { retry++ }) { Text(stringResource(R.string.action_retry)) }
            }
            else -> Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                repeat(3) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        SkeletonBox(Modifier.width(140.dp).aspectRatio(16f / 9f))
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            SkeletonBox(Modifier.width(160.dp).height(16.dp))
                            SkeletonBox(Modifier.width(100.dp).height(12.dp))
                        }
                    }
                }
            }
        }
    }
}
