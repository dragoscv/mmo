package ro.mixai.tv.ui.library

import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import ro.mixai.tv.BuildConfig
import ro.mixai.tv.R
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.LibraryIndexRow
import ro.mixai.tv.ui.components.BadgeTone
import ro.mixai.tv.ui.components.CardBadge
import ro.mixai.tv.ui.components.Choice
import ro.mixai.tv.ui.components.ChoiceDialog
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.LocalBackdrop
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PosterCard
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.ScreenTitle
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.RestorableFocus
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.nav.rememberRestorableFocus
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens
import ro.mixai.tv.ui.title.TvPill
import ro.mixai.tv.ui.title.yearOf
import java.text.Normalizer
import java.util.concurrent.ConcurrentHashMap

// Server library grid (WP16-20). Source = `/media/library` (one row per file); grouped by TMDB id
// into entries with a placeholder title parsed from the file name. Cards resolve lazily via
// `/media/title` in pages of 30 around the visible window (max 4 requests in flight) and are kept
// in a process cache so Back from a title is instant. Sort/filter run on local data; genre and
// rating need resolved cards, so choosing them resolves the rest in the background.

private const val TAG = "MixaiPerf"
private const val PAGE = 30
private const val MAX_IN_FLIGHT = 4

/** One title in the library (all its files). */
@Immutable
private data class LibEntry(
    val tmdbId: Long,
    val placeholder: String,
    val year: Int?,
    val addedAt: Long,
    val res: String?,
    val fileCount: Int,
    /** Shortest-path file; its `/video/thumbs/:id/still.jpg` is the placeholder art. */
    val fileId: String = "",
) {
    val key: String get() = tmdbId.toString()
}

/** Resolved card (subset of TitleDetails). */
@Immutable
private data class LibCard(val title: String, val posterPath: String?, val backdropPath: String?, val year: Int?, val rating: Double?, val genres: List<String>)

private data class LibState(val entries: List<LibEntry>, val watched: Set<Long>, val unmatched: Int)

/** Process cache: survives navigation (Title and back), keyed by server + profile + kind. */
private object LibraryCache {
    val cards = ConcurrentHashMap<String, ConcurrentHashMap<Long, LibCard>>()
    val states = ConcurrentHashMap<String, LibState>()
}

private enum class Sort { Added, Az, Year, Rating }
private enum class Dialog { None, Sort, Genre, Decade, Res }

private val YEAR = Regex("""(?<![0-9])(19[0-9]{2}|20[0-9]{2})(?![0-9])""")
private val EPISODE = Regex("""[Ss][0-9]{1,2}[Ee][0-9]{1,3}""")
private val TAGS = Regex("""(?i)\b(2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|bdrip|web-?dl|webrip|hdtv|remux|x26[45]|h\.?26[45]|hevc|hdr|dv)\b""")

private fun resolutionOf(path: String): String? {
    val p = path.lowercase()
    return when {
        "2160p" in p || "4k" in p || "uhd" in p -> "4k"
        "1080p" in p -> "1080p"
        "720p" in p -> "720p"
        else -> null
    }
}

/** "The.Matrix.1999.1080p.mkv" → "The Matrix"; episodes: text before `SxxEyy`, else the show folder. */
private fun placeholderTitle(row: LibraryIndexRow): String {
    val parts = row.path.replace('\\', '/').split('/').filter { it.isNotBlank() }
    val file = parts.lastOrNull().orEmpty().substringBeforeLast('.')
    var base = file
    EPISODE.find(base)?.let { base = base.substring(0, it.range.first) }
    YEAR.find(base)?.let { if (it.range.first > 0) base = base.substring(0, it.range.first) }
    TAGS.find(base)?.let { if (it.range.first > 0) base = base.substring(0, it.range.first) }
    base = base.replace('.', ' ').replace('_', ' ').replace(Regex("""[\[\(\-\s]+$"""), "").trim()
    if (base.isBlank() && row.kind == "tv") {
        base = parts.dropLast(1).lastOrNull { !it.lowercase().startsWith("season") && !it.lowercase().startsWith("sezon") }.orEmpty()
    }
    return base.ifBlank { file }
}

private fun group(rows: List<LibraryIndexRow>, kind: String): Pair<List<LibEntry>, Int> {
    val mine = rows.filter { it.kind == kind }
    val unmatched = mine.count { it.tmdbId == null }
    val entries = mine.filter { it.tmdbId != null }.groupBy { it.tmdbId!! }.map { (id, files) ->
        val first = files.minByOrNull { it.path.length }!!
        val res = files.mapNotNull { resolutionOf(it.path) }.let { r -> if ("4k" in r) "4k" else r.firstOrNull() }
        LibEntry(
            tmdbId = id,
            placeholder = placeholderTitle(first),
            year = files.firstNotNullOfOrNull { f -> YEAR.find(f.path.replace('\\', '/').substringAfterLast('/'))?.value?.toIntOrNull() },
            addedAt = files.maxOf { maxOf(it.mtime, it.updatedAt) },
            res = res,
            fileCount = files.size,
            fileId = first.serverFileId,
        )
    }
    return entries to unmatched
}

private fun foldKey(s: String): String =
    Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("""\p{M}+"""), "").lowercase().removePrefix("the ").trim()

private fun letterOf(s: String): Char {
    val c = foldKey(s).firstOrNull() ?: return '#'
    return if (c in 'a'..'z') c.uppercaseChar() else '#'
}

@Composable
fun LibraryScreen(deps: ScreenDeps, nav: Navigator, kind: String) {
    val cacheKey = "${deps.api.baseUrl}|${deps.media.profile}|$kind"
    var state by remember { mutableStateOf(LibraryCache.states[cacheKey]) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val rf = rememberRestorableFocus("library-$kind")

    LaunchedEffect(cacheKey, reload) {
        error = null
        try {
            val lib = deps.media.library()
            val (entries, unmatched) = group(lib.items, kind)
            val watched = runCatching {
                val prog = deps.media.getProgress().entries.filter { it.kind == kind }
                if (kind == "tv") prog.map { it.tmdbId }.toSet() else prog.filter { it.completed }.map { it.tmdbId }.toSet()
            }.getOrDefault(emptySet())
            val s = LibState(entries, watched, unmatched)
            LibraryCache.states[cacheKey] = s
            state = s
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (state == null) error = e
        }
    }

    val s = state
    val err = error
    val title = stringResource(if (kind == "tv") R.string.wp16_lib_title_tv else R.string.wp16_lib_title_movies)
    when {
        s != null && s.entries.isNotEmpty() -> LibraryGrid(deps, nav, kind, cacheKey, title, s, rf)
        s != null -> Column(Modifier.fillMaxSize()) {
            ScreenTitle(title)
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                EmptyState(
                    icon = if (kind == "tv") MixaiIcons.Tv else MixaiIcons.Movie,
                    title = stringResource(if (kind == "tv") R.string.wp16_lib_empty_tv else R.string.wp16_lib_empty_movies),
                    message = if (s.unmatched > 0) stringResource(R.string.wp16_lib_unmatched, s.unmatched) else stringResource(R.string.wp16_lib_empty_hint),
                    action = { m -> PrimaryButton(stringResource(R.string.wp16_home_open_settings), { nav.push(Route.Settings("server")) }, m, icon = Icons.Filled.Settings) },
                )
            }
        }
        err != null -> Column(Modifier.fillMaxSize()) {
            ScreenTitle(title)
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                val old = err is ApiException && (err.status == 404 || err.status == 501)
                ErrorState(if (old) stringResource(R.string.wp16_lib_old_server) else err.message ?: err.javaClass.simpleName, onRetry = { reload++ })
            }
        }
        else -> LoadingState(rows = 3, hero = false)
    }
}

@OptIn(FlowPreview::class)
@Composable
private fun LibraryGrid(deps: ScreenDeps, nav: Navigator, kind: String, cacheKey: String, title: String, s: LibState, rf: RestorableFocus) {
    val scope = rememberCoroutineScope()
    val backdrop = LocalBackdrop.current
    val density = LocalDensity.current
    val posterPx = with(density) { 160.dp.roundToPx() }
    val posterSize = remember(posterPx) { TmdbSize.poster(posterPx) }
    val backdropPx = with(density) { 1280.dp.roundToPx() }

    // Resolved cards: process cache mirrored into snapshot state for recomposition.
    val processCards = remember(cacheKey) { LibraryCache.cards.getOrPut(cacheKey) { ConcurrentHashMap() } }
    val cards: SnapshotStateMap<Long, LibCard> = remember(cacheKey) { mutableStateMapOf<Long, LibCard>().apply { putAll(processCards) } }
    val requested = remember(cacheKey) { HashSet<Long>(processCards.keys) }
    val sem = remember { Semaphore(MAX_IN_FLIGHT) }

    var sortName by rememberSaveable { mutableStateOf(Sort.Added.name) }
    var genre by rememberSaveable { mutableStateOf<String?>(null) }
    var decade by rememberSaveable { mutableStateOf<Int?>(null) }
    var res by rememberSaveable { mutableStateOf<String?>(null) }
    var unwatched by rememberSaveable { mutableStateOf(false) }
    var dialog by remember { mutableStateOf(Dialog.None) }
    var letters by remember { mutableStateOf(false) }
    val sort = Sort.valueOf(sortName)
    val needAll = genre != null || sort == Sort.Rating

    fun resolve(ids: List<Long>) {
        val todo = ids.filter { requested.add(it) }
        if (todo.isEmpty()) return
        todo.forEach { id ->
            scope.launch {
                sem.withPermit {
                    val r = runCatching { deps.media.title(kind, id) }.getOrNull() ?: run { requested.remove(id); return@withPermit }
                    val t = r.title
                    val c = LibCard(
                        title = t.title,
                        posterPath = t.posterPath,
                        backdropPath = t.backdropPath,
                        year = yearOf(t.releaseDate)?.toIntOrNull(),
                        rating = t.voteAverage,
                        genres = t.genres.mapNotNull { g -> runCatching { g["name"]?.jsonPrimitive?.contentOrNull }.getOrNull() },
                    )
                    processCards[id] = c
                    cards[id] = c
                }
            }
        }
    }

    // Sorted + filtered list; recomputed on filter/sort changes only (not on every resolved card,
    // which would reshuffle the grid under the focus).
    val list = remember(s, sort, genre, decade, res, unwatched, if (needAll) cards.size / PAGE else 0) {
        val snap = HashMap(cards)
        fun name(e: LibEntry) = snap[e.tmdbId]?.title ?: e.placeholder
        fun year(e: LibEntry) = snap[e.tmdbId]?.year ?: e.year
        s.entries.asSequence()
            .filter { e -> genre == null || snap[e.tmdbId]?.genres?.contains(genre) == true }
            .filter { e -> decade == null || (year(e)?.let { it / 10 * 10 } == decade) }
            .filter { e -> res == null || e.res == res || (res == "1080p" && e.res == "4k") }
            .filter { e -> !unwatched || e.tmdbId !in s.watched }
            .sortedWith(
                when (sort) {
                    Sort.Added -> compareByDescending<LibEntry> { it.addedAt }
                    Sort.Az -> compareBy { foldKey(name(it)) }
                    Sort.Year -> compareByDescending<LibEntry> { year(it) ?: 0 }.thenBy { foldKey(name(it)) }
                    Sort.Rating -> compareByDescending<LibEntry> { snap[it.tmdbId]?.rating ?: -1.0 }.thenBy { foldKey(name(it)) }
                },
            )
            .toList()
    }

    val grid: LazyGridState = rememberLazyGridState()

    // Resolve the visible window ± one page (pages of 30); nothing off-screen hits the network.
    LaunchedEffect(list) {
        snapshotFlow { grid.firstVisibleItemIndex to (grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) }
            .distinctUntilChanged()
            .debounce(120)
            .collect { (first, last) ->
                val p0 = (first / PAGE).coerceAtLeast(0)
                val p1 = (last + PAGE) / PAGE
                val ids = (p0..p1).flatMap { p -> list.drop(p * PAGE).take(PAGE).map { it.tmdbId } }
                resolve(ids)
            }
    }
    // Genre / rating need every card: resolve the rest in the background (still max 4 in flight).
    LaunchedEffect(needAll) { if (needAll) resolve(s.entries.map { it.tmdbId }) }

    LaunchedEffect(Unit) { rf.restoreFocus() }

    // Debug-only frame timing while the grid scrolls: avg + p95 over 5 s windows.
    if (BuildConfig.DEBUG) {
        LaunchedEffect(grid) {
            val frames = ArrayList<Long>(512)
            var windowStart = 0L
            while (true) {
                snapshotFlow { grid.isScrollInProgress }.first { it }
                var last = withFrameNanos { it }
                if (windowStart == 0L) windowStart = last
                while (grid.isScrollInProgress) {
                    val now = withFrameNanos { it }
                    frames += now - last
                    last = now
                    if (now - windowStart >= 5_000_000_000L && frames.size >= 10) {
                        val sorted = frames.sorted()
                        val avg = frames.average() / 1e6
                        val p95 = sorted[(sorted.size * 95 / 100).coerceAtMost(sorted.lastIndex)] / 1e6
                        val janky = frames.count { it > 33_000_000L }
                        Log.i(TAG, "library scroll frames=${frames.size} avg=%.1fms p95=%.1fms janky=%d items=%d".format(avg, p95, janky, list.size))
                        frames.clear()
                        windowStart = now
                    }
                }
            }
        }
    }

    val letterFocus = remember { FocusRequester() }
    val availableLetters = remember(list, sort) {
        if (sort != Sort.Az) emptyList() else list.map { letterOf(cards[it.tmdbId]?.title ?: it.placeholder) }.distinct()
    }

    fun jumpTo(letter: Char) {
        letters = false
        scope.launch {
            val target = if (sort != Sort.Az) {
                sortName = Sort.Az.name
                delay(50)
                null
            } else list.indexOfFirst { letterOf(cards[it.tmdbId]?.title ?: it.placeholder) == letter }
            val idx = target ?: return@launch
            if (idx < 0) return@launch
            grid.scrollToItem(idx)
            rf.record("lib:${list[idx].key}")
            rf.restoreFocus()
        }
    }

    BackHandler(enabled = letters) { letters = false; scope.launch { rf.restoreFocus() } }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            ScreenTitle(title, subtitle = stringResource(R.string.wp16_lib_count, list.size, s.entries.size))
            LazyRow(
                Modifier.fillMaxWidth().focusRestorer(),
                contentPadding = PaddingValues(horizontal = MixaiFocus.overscan, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item("sort") { TvPill(stringResource(R.string.wp16_lib_sort_label, sortLabel(sort)), false, { dialog = Dialog.Sort }, rf.item("tb:sort")) }
                item("genre") { TvPill(genre ?: stringResource(R.string.wp16_lib_genre), genre != null, { dialog = Dialog.Genre }, rf.item("tb:genre")) }
                item("decade") { TvPill(decade?.let { stringResource(R.string.wp16_lib_decade_n, it) } ?: stringResource(R.string.wp16_lib_decade), decade != null, { dialog = Dialog.Decade }, rf.item("tb:decade")) }
                item("res") { TvPill(res?.let { resLabel(it) } ?: stringResource(R.string.wp16_lib_resolution), res != null, { dialog = Dialog.Res }, rf.item("tb:res")) }
                item("unwatched") { TvPill(stringResource(R.string.wp16_lib_unwatched), unwatched, { unwatched = !unwatched }, rf.item("tb:unwatched")) }
                if (sort == Sort.Az) item("az") { TvPill(stringResource(R.string.wp16_lib_jump), false, { letters = true }, rf.item("tb:az")) }
                if (genre != null || decade != null || res != null || unwatched) {
                    item("clear") { TvPill(stringResource(R.string.wp16_lib_clear), false, { genre = null; decade = null; res = null; unwatched = false }, rf.item("tb:clear")) }
                }
            }
            if (list.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    EmptyState(icon = MixaiIcons.Grid, title = stringResource(R.string.wp16_lib_no_match), message = stringResource(R.string.wp16_lib_no_match_hint), focusAction = false)
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(160.dp),
                    state = grid,
                    modifier = Modifier.fillMaxSize().focusRestorer(),
                    contentPadding = PaddingValues(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = 8.dp, bottom = 48.dp),
                    horizontalArrangement = Arrangement.spacedBy(20.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    itemsIndexed(list, key = { _, it -> it.tmdbId }, contentType = { _, _ -> "poster" }) { idx, e ->
                        val c = cards[e.tmdbId]
                        val base = rf.item("lib:${e.key}").let { if (idx == 0) it.focusRequester(rf.requester) else it }
                        PosterCard(
                            imageUrl = c?.posterPath?.let { deps.api.tmdbImageUrl(posterSize, it) },
                            title = c?.title ?: e.placeholder,
                            subtitle = (c?.year ?: e.year)?.toString(),
                            width = 160.dp,
                            placeholderStill = if (c?.posterPath == null && e.fileId.isNotBlank()) deps.api.stillUrl(e.fileId) else null,
                            badges = if (e.res == "4k") listOf(CardBadge("4K", BadgeTone.Neutral)) else emptyList(),
                            sharedKey = "$kind-${e.tmdbId}",
                            onClick = { nav.push(Route.Title(kind, e.tmdbId)) },
                            onFocus = { backdrop.show(c?.backdropPath?.let { deps.api.tmdbImageUrl(TmdbSize.backdrop(backdropPx), it) }) },
                            modifier = base.onPreviewKeyEvent { ev ->
                                if (sort == Sort.Az && ev.type == KeyEventType.KeyDown && ev.key == Key.DirectionLeft) {
                                    val col = grid.layoutInfo.visibleItemsInfo.firstOrNull { it.key == e.tmdbId }?.column
                                    if (col == 0) {
                                        letters = true
                                        scope.launch { delay(60); runCatching { letterFocus.requestFocus() } }
                                        true
                                    } else false
                                } else false
                            },
                        )
                    }
                }
            }
        }

        if (letters && availableLetters.isNotEmpty()) {
            LetterStrip(availableLetters, letterFocus, onPick = { jumpTo(it) })
            LaunchedEffect(Unit) { delay(60); runCatching { letterFocus.requestFocus() } }
        }
    }

    val genres = remember(cards.size) { cards.values.flatMap { it.genres }.distinct().sorted() }
    val decades = remember(s, cards.size / PAGE) { s.entries.mapNotNull { (cards[it.tmdbId]?.year ?: it.year)?.let { y -> y / 10 * 10 } }.distinct().sortedDescending() }
    val allLabel = stringResource(R.string.wp16_lib_all)
    val sortChoices = Sort.entries.map { Choice(it.name, sortLabel(it)) }
    val decadeFmt = stringResource(R.string.wp16_lib_decade_n)
    when (dialog) {
        Dialog.Sort -> ChoiceDialog(stringResource(R.string.wp16_lib_sort), sortChoices, sortName, { sortName = it; dialog = Dialog.None }, { dialog = Dialog.None })
        Dialog.Genre -> ChoiceDialog(
            stringResource(R.string.wp16_lib_genre),
            listOf(Choice("", allLabel, if (cards.size < s.entries.size) stringResource(R.string.wp16_lib_genre_partial, cards.size, s.entries.size) else null)) + genres.map { Choice(it, it) },
            genre ?: "",
            { genre = it.ifBlank { null }; dialog = Dialog.None },
            { dialog = Dialog.None },
        )
        Dialog.Decade -> ChoiceDialog(
            stringResource(R.string.wp16_lib_decade),
            listOf(Choice(0, allLabel)) + decades.map { Choice(it, decadeFmt.format(it)) },
            decade ?: 0,
            { decade = it.takeIf { d -> d > 0 }; dialog = Dialog.None },
            { dialog = Dialog.None },
        )
        Dialog.Res -> ChoiceDialog(
            stringResource(R.string.wp16_lib_resolution),
            listOf(Choice("", allLabel), Choice("4k", resLabel("4k")), Choice("1080p", resLabel("1080p"))),
            res ?: "",
            { res = it.ifBlank { null }; dialog = Dialog.None },
            { dialog = Dialog.None },
        )
        Dialog.None -> Unit
    }
}

@Composable
private fun LetterStrip(letters: List<Char>, focus: FocusRequester, onPick: (Char) -> Unit) {
    Box(Modifier.fillMaxHeight().width(88.dp).background(Tokens.popover.copy(alpha = 0.96f))) {
        LazyColumn(
            Modifier.fillMaxSize().focusRestorer(),
            contentPadding = PaddingValues(vertical = MixaiFocus.overscanTop, horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            items(letters, key = { it }) { l ->
                TvPill(l.toString(), false, { onPick(l) }, if (l == letters.first()) Modifier.focusRequester(focus) else Modifier)
            }
        }
    }
}

@Composable
private fun sortLabel(s: Sort): String = stringResource(
    when (s) {
        Sort.Added -> R.string.wp16_lib_sort_added
        Sort.Az -> R.string.wp16_lib_sort_az
        Sort.Year -> R.string.wp16_lib_sort_year
        Sort.Rating -> R.string.wp16_lib_sort_rating
    },
)

@Composable
private fun resLabel(r: String): String = when (r) {
    "4k" -> "4K"
    "1080p" -> stringResource(R.string.wp16_lib_res_1080)
    else -> r
}
