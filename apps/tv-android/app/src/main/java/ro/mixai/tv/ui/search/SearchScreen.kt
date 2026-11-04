package ro.mixai.tv.ui.search

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.AlbumCard
import ro.mixai.tv.data.generated.ArtistCard
import ro.mixai.tv.data.generated.LiveTvChannel
import ro.mixai.tv.data.generated.MusicSearch
import ro.mixai.tv.data.generated.TitleCard
import ro.mixai.tv.data.generated.TrackCard
import ro.mixai.tv.ui.components.BadgeTone
import ro.mixai.tv.ui.components.CardBadge
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.IconActionButton
import ro.mixai.tv.ui.components.LandscapeCard
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.NoBackdrop
import ro.mixai.tv.ui.components.PosterCard
import ro.mixai.tv.ui.components.RowTitle
import ro.mixai.tv.ui.components.SkeletonPosterRow
import ro.mixai.tv.ui.components.TvKeyboard
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.settings.OptionChip
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens
import java.text.Normalizer

/** Search results grouped the way the screen shows them. */
data class SearchResults(
    val query: String,
    val library: List<TitleCard>,
    val titles: List<TitleCard>,
    val music: MusicSearch,
    val channels: List<LiveTvChannel>,
) {
    val isEmpty: Boolean
        get() = library.isEmpty() && titles.isEmpty() && music.artists.isEmpty() && music.albums.isEmpty() &&
            music.tracks.isEmpty() && channels.isEmpty()
}

private sealed interface SearchState {
    data object Idle : SearchState
    data object Loading : SearchState
    data class Ready(val results: SearchResults) : SearchState
    data class Error(val message: String) : SearchState
}

/** Lower-case + strip diacritics (ș → s, ă → a) for client-side matching. */
internal fun foldForSearch(s: String): String =
    Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase()

/** Channels whose name (or number) matches every word of [q]. */
internal fun matchChannels(all: List<LiveTvChannel>, q: String, limit: Int = 30): List<LiveTvChannel> {
    val words = foldForSearch(q).split(' ').filter { it.isNotBlank() }
    if (words.isEmpty()) return emptyList()
    return all.asSequence().filter { !it.hidden }.filter { c ->
        val hay = foldForSearch(c.name + " " + (c.number ?: ""))
        words.all { hay.contains(it) }
    }.take(limit).toList()
}

/** Splits `/media/search` results into "In your library" and the rest. */
internal fun splitByLibrary(results: List<TitleCard>): Pair<List<TitleCard>, List<TitleCard>> =
    results.filter { it.kind == "movie" || it.kind == "tv" }.partition { it.inLibrary == true }

private const val DEBOUNCE_MS = 300L

/**
 * Search (WP16-26): left = on-screen keyboard (focused first) + voice, right = debounced results in
 * sections (library, movies & shows, music, channels). Hardware keyboards / `adb input text` type
 * through onPreviewKeyEvent; hub `text` commands arrive as [initial]. Recent searches per profile.
 */
@Composable
fun SearchScreen(deps: ScreenDeps, nav: Navigator, initial: String) {
    NoBackdrop()
    val context = LocalContext.current
    val recentStore = remember { RecentSearches(context) }
    val profileId = deps.profiles.activeId
    var query by rememberSaveable { mutableStateOf(initial) }
    var recent by remember(profileId) { mutableStateOf(recentStore.list(profileId)) }
    var state by remember { mutableStateOf<SearchState>(SearchState.Idle) }
    var last by remember { mutableStateOf<SearchResults?>(null) }
    var channels by remember { mutableStateOf<List<LiveTvChannel>?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    var voiceAvailable by remember { mutableStateOf(runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false)) }
    val keyboardFocus = remember { FocusRequester() }

    LaunchedEffect(initial) {
        if (initial.isNotBlank()) { query = initial; recent = recentStore.add(profileId, initial) }
    }

    val voice = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        if (r.resultCode == Activity.RESULT_OK) {
            r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.takeIf { it.isNotBlank() }?.let {
                query = it.take(100)
                recent = recentStore.add(profileId, it)
            }
        }
    }
    val voicePrompt = stringResource(R.string.search_voice_prompt)
    fun startVoice() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, deps.lang)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, voicePrompt)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        try { voice.launch(intent) } catch (_: ActivityNotFoundException) { voiceAvailable = false }
    }

    LaunchedEffect(query, retry) {
        val q = query.trim()
        if (q.length < 2) { state = SearchState.Idle; return@LaunchedEffect }
        delay(DEBOUNCE_MS)
        state = SearchState.Loading
        state = coroutineScope {
            val media = async { runCatching { deps.media.search(q) } }
            val music = async { runCatching { deps.music.search(q) } }
            val chans = channels ?: runCatching { deps.liveTv.channels() }.getOrDefault(emptyList()).also { channels = it }
            val m = media.await()
            val mu = music.await()
            if (m.isFailure && mu.isFailure) {
                SearchState.Error((m.exceptionOrNull() ?: mu.exceptionOrNull())?.message ?: "error")
            } else {
                val (lib, rest) = splitByLibrary(m.getOrNull()?.results.orEmpty())
                SearchResults(q, lib, rest, mu.getOrNull() ?: MusicSearch(q), matchChannels(chans, q)).let { last = it; SearchState.Ready(it) }
            }
        }
    }

    fun commit(q: String) { recent = recentStore.add(profileId, q) }

    Row(
        Modifier.fillMaxSize().padding(start = MixaiFocus.overscan, top = MixaiFocus.overscanTop).onPreviewKeyEvent { e ->
            // Hardware keyboards / remote IMEs / `adb input text` type anywhere on the screen.
            if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            when {
                e.key == Key.Backspace || e.key == Key.Delete -> { query = query.dropLast(1); true }
                e.key == Key.Spacebar -> { if (query.isNotEmpty() && !query.endsWith(' ')) query += " "; true }
                else -> {
                    val cp = e.utf16CodePoint
                    if (cp > 32 && cp != 127 && Character.isLetterOrDigit(cp)) { query = (query + cp.toChar().lowercaseChar()).take(100); true } else false
                }
            }
        },
    ) {
        Column(Modifier.width(400.dp).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                QueryBox(query, Modifier.weight(1f))
                if (voiceAvailable) IconActionButton(MixaiIcons.Mic, stringResource(R.string.search_voice), { startVoice() })
            }
            TvKeyboard(text = query, onTextChange = { query = it }, keySize = 46.dp, focusRequester = keyboardFocus)
        }
        Spacer(Modifier.width(28.dp))
        Box(Modifier.weight(1f).fillMaxHeight()) {
            when (val s = state) {
                SearchState.Idle -> IdlePane(recent, onPick = { query = it; commit(it) }, onClear = { recentStore.clear(profileId); recent = emptyList() })
                SearchState.Loading -> {
                    val prev = last
                    if (prev != null && prev.query.isNotBlank()) ResultsPane(deps, nav, prev, ::commit)
                    else Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                        SkeletonPosterRow(count = 5, width = 130.dp)
                        SkeletonPosterRow(count = 5, width = 130.dp)
                    }
                }
                is SearchState.Error -> ErrorState(s.message, onRetry = { retry++ }, title = stringResource(R.string.search_failed))
                is SearchState.Ready -> if (s.results.isEmpty) {
                    EmptyState(Icons.Filled.Search, stringResource(R.string.search_no_results, s.results.query), stringResource(R.string.search_no_results_hint), focusAction = false)
                } else ResultsPane(deps, nav, s.results, ::commit)
            }
        }
    }
}

@Composable
private fun QueryBox(query: String, modifier: Modifier) {
    Row(
        modifier.background(Tokens.foreground.copy(alpha = 0.08f), RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Search, contentDescription = null, tint = Tokens.mutedForeground, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(10.dp))
        Text(
            if (query.isEmpty()) stringResource(R.string.search_placeholder) else query + "▏",
            style = MaterialTheme.typography.titleMedium,
            color = if (query.isEmpty()) Tokens.mutedForeground else Tokens.foreground,
            maxLines = 1,
        )
    }
}

@Composable
private fun IdlePane(recent: List<String>, onPick: (String) -> Unit, onClear: () -> Unit) {
    Column(Modifier.padding(top = 8.dp, end = MixaiFocus.overscan), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(stringResource(R.string.search_title), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
        Text(stringResource(R.string.search_hint), style = MaterialTheme.typography.bodyLarge, color = Tokens.mutedForeground)
        if (recent.isNotEmpty()) {
            RowTitle(stringResource(R.string.search_recent))
            LazyRow(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 6.dp)) {
                itemsIndexed(recent, key = { _, q -> q }) { _, q -> OptionChip(q, false, { onPick(q) }) }
                item { OptionChip(stringResource(R.string.search_recent_clear), false, onClear) }
            }
        }
    }
}

private fun year(c: TitleCard) = c.releaseDate?.take(4)?.takeIf { it.length == 4 }

@Composable
private fun ResultsPane(deps: ScreenDeps, nav: Navigator, r: SearchResults, onCommit: (String) -> Unit) {
    val inLib = stringResource(R.string.search_badge_library)
    val movie = stringResource(R.string.search_kind_movie)
    val show = stringResource(R.string.search_kind_show)
    fun openTitle(c: TitleCard) { onCommit(r.query); nav.push(Route.Title(c.kind, c.tmdbId)) }
    @Composable
    fun TitleRowItem(c: TitleCard) {
        PosterCard(
            imageUrl = deps.api.tmdbImageUrl(TmdbSize.poster(260), c.posterPath),
            title = c.title,
            subtitle = listOfNotNull(year(c), if (c.kind == "tv") show else movie).joinToString(" · "),
            badges = if (c.inLibrary == true) listOf(CardBadge(inLib, BadgeTone.Success)) else emptyList(),
            width = 130.dp,
            onClick = { openTitle(c) },
        )
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(18.dp),
        contentPadding = PaddingValues(bottom = 48.dp),
    ) {
        if (r.library.isNotEmpty()) item(key = "lib") {
            Section(stringResource(R.string.search_sec_library, r.library.size)) {
                itemsIndexed(r.library, key = { _, c -> "l${c.kind}${c.tmdbId}" }) { _, c -> TitleRowItem(c) }
            }
        }
        if (r.titles.isNotEmpty()) item(key = "titles") {
            Section(stringResource(R.string.search_sec_titles)) {
                itemsIndexed(r.titles, key = { _, c -> "t${c.kind}${c.tmdbId}" }) { _, c -> TitleRowItem(c) }
            }
        }
        val m = r.music
        if (m.artists.isNotEmpty() || m.albums.isNotEmpty() || m.tracks.isNotEmpty()) item(key = "music") {
            Section(stringResource(R.string.search_sec_music)) {
                itemsIndexed(m.artists, key = { _, a -> "a${a.id}" }) { _, a -> ArtistItem(deps, a) { onCommit(r.query); nav.push(Route.Artist(a.id)) } }
                itemsIndexed(m.albums, key = { _, a -> "b${a.id}" }) { _, a -> AlbumItem(deps, a) { onCommit(r.query); nav.push(Route.Album(a.id)) } }
                itemsIndexed(m.tracks, key = { _, t -> "s${t.id}" }) { i, t ->
                    TrackItem(deps, t) {
                        onCommit(r.query)
                        deps.musicPlayback.play(m.tracks, i)
                        nav.push(Route.NowPlaying)
                    }
                }
            }
        }
        if (r.channels.isNotEmpty()) item(key = "channels") {
            Section(stringResource(R.string.search_sec_channels)) {
                itemsIndexed(r.channels, key = { _, c -> "c${c.id}" }) { _, c ->
                    LandscapeCard(
                        imageUrl = c.logo?.takeIf { it.isNotBlank() },
                        title = c.name,
                        caption = listOfNotNull(c.number, c.group).joinToString(" · ").ifBlank { null },
                        width = 220.dp,
                        onClick = { onCommit(r.query); nav.push(Route.LivePlay(c.id)) },
                    )
                }
            }
        }
    }
}

@Composable
private fun Section(title: String, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RowTitle(title)
        LazyRow(
            Modifier.fillMaxWidth().focusRestorer(),
            contentPadding = PaddingValues(start = 4.dp, end = MixaiFocus.overscan, top = 10.dp, bottom = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp),
            content = content,
        )
    }
}

@Composable
private fun ArtistItem(deps: ScreenDeps, a: ArtistCard, onClick: () -> Unit) {
    PosterCard(
        imageUrl = deps.music.coverUrl(a),
        title = a.name,
        subtitle = stringResource(R.string.search_kind_artist),
        width = 130.dp,
        onClick = onClick,
    )
}

@Composable
private fun AlbumItem(deps: ScreenDeps, a: AlbumCard, onClick: () -> Unit) {
    PosterCard(
        imageUrl = deps.music.coverUrl(a),
        title = a.name,
        subtitle = listOfNotNull(a.artist, a.year?.toString()).joinToString(" · ").ifBlank { stringResource(R.string.search_kind_album) },
        width = 130.dp,
        onClick = onClick,
    )
}

@Composable
private fun TrackItem(deps: ScreenDeps, t: TrackCard, onClick: () -> Unit) {
    PosterCard(
        imageUrl = deps.music.coverUrl(t),
        title = t.title,
        subtitle = listOfNotNull(t.artist, stringResource(R.string.search_kind_track)).joinToString(" · "),
        width = 130.dp,
        onClick = onClick,
    )
}
