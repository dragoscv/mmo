package ro.mixai.app.ui.library

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.outlined.FilterAltOff
import androidx.compose.material.icons.outlined.VideoLibrary
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.mobile.ui.EmptyState
import ro.mixai.mobile.ui.ErrorState
import ro.mixai.app.ui.components.PosterCard
import ro.mixai.mobile.ui.SkeletonBox
import ro.mixai.app.ui.components.TabHeader
import ro.mixai.app.ui.media.genresOf
import ro.mixai.tv.data.generated.LibraryIndexRow
import ro.mixai.tv.data.generated.TitleCard
import java.util.concurrent.ConcurrentHashMap

// Library tab (WP16-46). Source = `/media/library` (one row per file) grouped by (kind, tmdbId).
// Rows carry no title/poster: cards come from the Home rows + watchlist first, then `/media/title`
// with at most 6 requests in flight, prioritised around the visible window. Cards live in a
// process cache so Back from a title is instant.

private const val MAX_IN_FLIGHT = 6
private const val WINDOW_AHEAD = 36
private val YEAR = Regex("""(?<![0-9])(19[0-9]{2}|20[0-9]{2})(?![0-9])""")

/** One title of the library (all its files). */
@Immutable
private data class LibEntry(val kind: String, val tmdbId: Long, val fileName: String, val fileYear: Int?, val addedAt: Long) {
    val key: String get() = "$kind-$tmdbId"
}

/** Display data; `genres == null` = not known yet (card came from a list, not from `/media/title`). */
@Immutable
private data class LibCard(val title: String, val posterPath: String?, val year: Int?, val rating: Double?, val genres: List<String>?)

private data class LibData(val entries: List<LibEntry>, val completed: Set<String>, val started: Set<String>)

private object LibraryCache {
    val cards = ConcurrentHashMap<String, ConcurrentHashMap<String, LibCard>>()
    val data = ConcurrentHashMap<String, LibData>()
}

private enum class LibKind(val api: String) { Movies("movie"), Series("tv") }
private enum class Sort { Added, Az, Year, Rating }

private fun fileNameOf(path: String): String =
    path.replace('\\', '/').substringAfterLast('/').substringBeforeLast('.').replace('.', ' ').replace('_', ' ').trim()

private fun group(rows: List<LibraryIndexRow>): List<LibEntry> =
    rows.filter { it.tmdbId != null && (it.kind == "movie" || it.kind == "tv") }
        .groupBy { it.kind to it.tmdbId!! }
        .map { (k, files) ->
            val first = files.minBy { it.path.length }
            LibEntry(
                kind = k.first,
                tmdbId = k.second,
                fileName = fileNameOf(first.path),
                fileYear = files.firstNotNullOfOrNull { YEAR.find(fileNameOf(it.path))?.value?.toIntOrNull() },
                addedAt = files.maxOf { maxOf(it.updatedAt, it.mtime) },
            )
        }

private fun TitleCard.toLib(): LibCard = LibCard(title, posterPath, releaseDate?.take(4)?.toIntOrNull(), voteAverage, null)

private fun opt(label: String, action: () -> Unit): Pair<String, () -> Unit> = label to action

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(deps: AppDeps, nav: Navigator) {
    val cacheKey = "${deps.api.baseUrl}|${deps.media.profile}"
    val cards = remember(cacheKey) { LibraryCache.cards.getOrPut(cacheKey) { ConcurrentHashMap() } }
    // Bumped whenever a card lands so derived lists recompute.
    var cardsRev by remember { mutableIntStateOf(0) }
    var data by remember(cacheKey) { mutableStateOf(LibraryCache.data[cacheKey]) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    var kind by rememberSaveable { mutableStateOf(LibKind.Movies) }
    var sort by rememberSaveable { mutableStateOf(Sort.Added) }
    var genre by rememberSaveable { mutableStateOf<String?>(null) }
    var decade by rememberSaveable { mutableStateOf<Int?>(null) }
    var unwatched by rememberSaveable { mutableStateOf(false) }

    val scope = rememberCoroutineScope()
    val resolver = remember(cacheKey) { Resolver(deps, cards, scope) { cardsRev++ } }

    LaunchedEffect(cacheKey, reload) {
        error = null
        try {
            val lib = deps.media.library()
            val progress = runCatching { deps.media.getProgress().entries }.getOrDefault(emptyList())
            val d = LibData(
                entries = group(lib.items),
                completed = progress.filter { it.completed }.map { "${it.kind}-${it.tmdbId}" }.toSet(),
                started = progress.map { "${it.kind}-${it.tmdbId}" }.toSet(),
            )
            LibraryCache.data[cacheKey] = d
            data = d
            // Seed display cards from lists the server already rendered.
            val seeds = buildList {
                runCatching { deps.media.home().rows.flatMap { it.items } }.getOrNull()?.let(::addAll)
                runCatching { deps.media.watchlist().items }.getOrNull()?.let(::addAll)
            }
            var added = false
            seeds.forEach { c -> if (c.tmdbId > 0 && cards.putIfAbsent("${c.kind}-${c.tmdbId}", c.toLib()) == null) added = true }
            if (added) cardsRev++
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (data == null) error = e
        }
    }

    val d = data
    val ofKind = remember(d, kind) { d?.entries?.filter { it.kind == kind.api }.orEmpty() }

    // Genre / rating / A–Z need every card (genre needs `/media/title` details).
    LaunchedEffect(ofKind, sort, genre) {
        if (sort == Sort.Az || sort == Sort.Rating || sort == Sort.Year) resolver.request(ofKind, needGenres = false)
        if (genre != null) resolver.request(ofKind, needGenres = true)
    }

    val visible = remember(ofKind, cardsRev, sort, genre, decade, unwatched, d) {
        fun card(e: LibEntry) = cards[e.key]
        fun title(e: LibEntry) = card(e)?.title ?: e.fileName
        fun year(e: LibEntry) = card(e)?.year ?: e.fileYear
        ofKind.asSequence()
            .filter { e -> genre == null || card(e)?.genres?.contains(genre) == true }
            .filter { e -> decade == null || year(e)?.let { it / 10 * 10 } == decade }
            .filter { e ->
                !unwatched || when (e.kind) {
                    "movie" -> e.key !in d!!.completed
                    else -> e.key !in d!!.started
                }
            }
            .toList()
            .let { list ->
                when (sort) {
                    Sort.Added -> list.sortedByDescending { it.addedAt }
                    Sort.Az -> list.sortedBy { alphaSortKey(title(it)) }
                    Sort.Year -> list.sortedByDescending { year(it) ?: 0 }
                    Sort.Rating -> list.sortedByDescending { card(it)?.rating ?: -1.0 }
                }
            }
    }
    val genres = remember(ofKind, cardsRev) { ofKind.flatMap { cards[it.key]?.genres.orEmpty() }.distinct().sorted() }
    val decades = remember(ofKind, cardsRev) { ofKind.mapNotNull { (cards[it.key]?.year ?: it.fileYear)?.let { y -> y / 10 * 10 } }.distinct().sortedDescending() }

    val grid = rememberLazyGridState()
    LaunchedEffect(visible) {
        snapshotFlow { grid.firstVisibleItemIndex }.collect { first ->
            val from = (first - 6).coerceAtLeast(0)
            val to = (first + WINDOW_AHEAD).coerceAtMost(visible.size)
            if (from < to) resolver.request(visible.subList(from, to), needGenres = false)
        }
    }
    LaunchedEffect(kind, sort, genre, decade, unwatched) { grid.scrollToItem(0) }

    Column(Modifier.fillMaxSize()) {
        TabHeader(stringResource(R.string.tab_library), deps, nav)
        SingleChoiceSegmentedButtonRow(Modifier.padding(horizontal = 16.dp).widthIn(max = 480.dp).fillMaxWidth()) {
            LibKind.entries.forEachIndexed { i, k ->
                SegmentedButton(
                    selected = kind == k,
                    onClick = { kind = k; genre = null; decade = null },
                    shape = SegmentedButtonDefaults.itemShape(i, LibKind.entries.size),
                ) {
                    Text(stringResource(if (k == LibKind.Movies) R.string.library_movies else R.string.library_series))
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val sortLabels = mapOf(
                Sort.Added to stringResource(R.string.library_sort_added),
                Sort.Az to stringResource(R.string.library_sort_az),
                Sort.Year to stringResource(R.string.library_sort_year),
                Sort.Rating to stringResource(R.string.library_sort_rating),
            )
            DropdownChip(
                label = stringResource(R.string.library_sort_label, sortLabels.getValue(sort)),
                selected = sort != Sort.Added,
                options = Sort.entries.map { s -> opt(sortLabels.getValue(s)) { sort = s } },
            )
            val allGenres = stringResource(R.string.library_genre_all)
            DropdownChip(
                label = genre ?: stringResource(R.string.library_genre),
                selected = genre != null,
                options = listOf(opt(allGenres) { genre = null }) + genres.map { g -> opt(g) { genre = g } },
                onOpen = { resolver.request(ofKind, needGenres = true) },
            )
            val allDecades = stringResource(R.string.library_decade_all)
            DropdownChip(
                label = decade?.let { stringResource(R.string.library_decade_value, it) } ?: stringResource(R.string.library_decade),
                selected = decade != null,
                options = listOf(opt(allDecades) { decade = null }) + decades.map { y -> opt(stringResource(R.string.library_decade_value, y)) { decade = y } },
            )
            FilterChip(selected = unwatched, onClick = { unwatched = !unwatched }, label = { Text(stringResource(R.string.library_unwatched)) })
        }

        Box(Modifier.fillMaxSize()) {
            when {
                d == null && error != null -> ErrorState(error, onRetry = { reload++ })
                d == null -> SkeletonGrid()
                d.entries.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.VideoLibrary,
                    title = stringResource(R.string.library_empty_title),
                    hint = stringResource(R.string.library_empty_hint),
                )
                visible.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.FilterAltOff,
                    title = stringResource(if (ofKind.isEmpty()) R.string.library_empty_kind else R.string.library_no_match),
                ) {
                    if (ofKind.isNotEmpty()) OutlinedButton(onClick = { genre = null; decade = null; unwatched = false }) {
                        Text(stringResource(R.string.library_clear_filters))
                    }
                }
                else -> {
                    val showRail = sort == Sort.Az
                    val index = remember(visible, cardsRev, showRail) {
                        if (showRail) alphaIndex(visible.map { cards[it.key]?.title ?: it.fileName }) else emptyMap()
                    }
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(110.dp),
                        state = grid,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(start = 16.dp, end = if (showRail) 36.dp else 16.dp, top = 4.dp, bottom = 24.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(visible.distinctBy { it.key }, key = { it.key }) { e ->
                            val c = cards[e.key]
                            val card = TitleCard(
                                kind = e.kind,
                                tmdbId = e.tmdbId,
                                title = c?.title ?: e.fileName,
                                posterPath = c?.posterPath,
                                releaseDate = (c?.year ?: e.fileYear)?.toString(),
                                voteAverage = c?.rating,
                                inLibrary = true,
                            )
                            PosterCard(deps.api, card, onClick = { nav.push(Dest.Title(e.kind, e.tmdbId)) }, width = 200.dp, modifier = Modifier.fillMaxWidth())
                        }
                    }
                    if (showRail && index.size > 1) {
                        AlphaRail(
                            letters = index.keys.toList(),
                            onLetter = { ch -> index[ch]?.let { i -> scope.launch { grid.scrollToItem(i) } } },
                            modifier = Modifier.align(Alignment.CenterEnd).fillMaxHeight().padding(vertical = 8.dp),
                        )
                    }
                }
            }
        }
    }
}

/** Fetches `/media/title` for entries lacking a card, at most [MAX_IN_FLIGHT] at once, each key once. */
private class Resolver(
    private val deps: AppDeps,
    private val cards: ConcurrentHashMap<String, LibCard>,
    private val scope: CoroutineScope,
    private val onCard: () -> Unit,
) {
    private val sem = Semaphore(MAX_IN_FLIGHT)
    private val pending = ConcurrentHashMap.newKeySet<String>()
    private val failed = ConcurrentHashMap.newKeySet<String>()

    fun request(entries: List<LibEntry>, needGenres: Boolean) {
        entries.forEach { e -> launchOne(e, needGenres) }
    }

    private fun launchOne(e: LibEntry, needGenres: Boolean) {
        val have = cards[e.key]
        if (have != null && (!needGenres || have.genres != null)) return
        if (e.key in failed || !pending.add(e.key)) return
        scope.launch {
            try {
                sem.withPermit {
                    val t = deps.media.title(e.kind, e.tmdbId).title
                    cards[e.key] = LibCard(
                        title = t.title.ifBlank { e.fileName },
                        posterPath = t.posterPath,
                        year = t.releaseDate?.take(4)?.toIntOrNull(),
                        rating = t.voteAverage,
                        genres = genresOf(t),
                    )
                }
                onCard()
            } catch (c: CancellationException) {
                throw c
            } catch (_: Exception) {
                failed.add(e.key)
            } finally {
                pending.remove(e.key)
            }
        }
    }
}

@Composable
private fun DropdownChip(label: String, selected: Boolean, options: List<Pair<String, () -> Unit>>, onOpen: () -> Unit = {}) {
    var open by remember { mutableStateOf(false) }
    Box {
        FilterChip(
            selected = selected,
            onClick = { onOpen(); open = true },
            label = { Text(label, maxLines = 1) },
            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, contentDescription = null) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (text, action) ->
                DropdownMenuItem(text = { Text(text) }, onClick = { action(); open = false })
            }
        }
    }
}

@Composable
private fun AlphaRail(letters: List<Char>, onLetter: (Char) -> Unit, modifier: Modifier = Modifier) {
    val label = stringResource(R.string.library_alpha_rail)
    fun pick(y: Float, h: Int) {
        if (h <= 0 || letters.isEmpty()) return
        val i = ((y / h) * letters.size).toInt().coerceIn(0, letters.lastIndex)
        onLetter(letters[i])
    }
    Column(
        modifier
            .width(28.dp)
            .pointerInput(letters) { detectTapGestures { pick(it.y, size.height) } }
            .pointerInput(letters) { detectVerticalDragGestures { change, _ -> pick(change.position.y, size.height) } }
            .semantics { contentDescription = label },
        verticalArrangement = Arrangement.SpaceEvenly,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        letters.forEach { ch ->
            Text(
                ch.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun SkeletonGrid() {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(110.dp),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        userScrollEnabled = false,
    ) {
        items(18) { SkeletonBox(Modifier.fillMaxWidth().aspectRatio(2f / 3f)) }
    }
}
