package ro.mixai.app.ui.search

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.LiveTv
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.app.ui.components.CardRow
import ro.mixai.mobile.ui.ErrorState
import ro.mixai.app.ui.components.PosterCard
import ro.mixai.app.ui.components.TabHeader
import ro.mixai.tv.data.generated.AlbumCard
import ro.mixai.tv.data.generated.ArtistCard
import ro.mixai.tv.data.generated.LiveTvChannel
import ro.mixai.tv.data.generated.MusicSearch
import ro.mixai.tv.data.generated.TitleCard
import ro.mixai.tv.data.generated.TrackCard

private const val DEBOUNCE_MS = 350L

private data class SearchResults(
    val query: String,
    val library: List<TitleCard>,
    val titles: List<TitleCard>,
    val music: MusicSearch,
    val channels: List<LiveTvChannel>,
) {
    val isEmpty: Boolean
        get() = library.isEmpty() && titles.isEmpty() && channels.isEmpty() &&
            music.artists.isEmpty() && music.albums.isEmpty() && music.tracks.isEmpty()
}

private sealed interface SearchState {
    data object Idle : SearchState
    data object Loading : SearchState
    data class Loaded(val r: SearchResults) : SearchState
    data class Failed(val error: Throwable) : SearchState
}

@Composable
fun SearchScreen(deps: AppDeps, nav: Navigator) {
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val store = remember(context) { RecentSearches(context) }
    var recent by remember { mutableStateOf(store.load()) }
    var query by rememberSaveable { mutableStateOf("") }
    var retry by remember { mutableIntStateOf(0) }
    var state by remember { mutableStateOf<SearchState>(SearchState.Idle) }
    // Channel list is fetched once per screen; null = not loaded yet, empty = none or unavailable.
    var channelCache by remember { mutableStateOf<List<LiveTvChannel>?>(null) }

    val speechIntent = remember(deps.lang) {
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, deps.lang)
    }
    val canSpeak = remember(speechIntent) { speechIntent.resolveActivity(context.packageManager) != null }
    val speech = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        if (res.resultCode == Activity.RESULT_OK) {
            val text = res.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if (!text.isNullOrBlank()) {
                query = text
                recent = store.add(text)
            }
        }
    }

    LaunchedEffect(query, retry) {
        val q = query.trim()
        if (q.length < 2) { state = SearchState.Idle; return@LaunchedEffect }
        delay(DEBOUNCE_MS)
        state = SearchState.Loading
        state = try {
            coroutineScope {
                val media = async { runCatching { deps.media.search(q).results } }
                val music = async { runCatching { deps.music.search(q) }.getOrDefault(MusicSearch()) }
                val channels = async {
                    val all = channelCache ?: runCatching { deps.liveTv.channels() }.getOrDefault(emptyList()).also { channelCache = it }
                    all.filter { !it.hidden && it.name.contains(q, ignoreCase = true) }.take(30)
                }
                val m = media.await()
                val mu = music.await()
                val ch = channels.await()
                val titles = m.getOrDefault(emptyList()).filter { it.kind == "movie" || it.kind == "tv" }
                val err = m.exceptionOrNull()
                if (err != null && mu.artists.isEmpty() && mu.albums.isEmpty() && mu.tracks.isEmpty() && ch.isEmpty()) {
                    SearchState.Failed(err)
                } else {
                    SearchState.Loaded(
                        SearchResults(
                            query = q,
                            library = titles.filter { it.inLibrary == true },
                            titles = titles.filterNot { it.inLibrary == true },
                            music = mu,
                            channels = ch,
                        ),
                    )
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            SearchState.Failed(e)
        }
    }

    fun saveRecent(q: String) { recent = store.add(q) }

    Column(Modifier.fillMaxSize()) {
        TabHeader(stringResource(R.string.tab_search), deps, nav)
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).widthIn(max = 720.dp),
            singleLine = true,
            placeholder = { Text(stringResource(R.string.search_hint)) },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            trailingIcon = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (query.isNotEmpty()) IconButton(onClick = { query = "" }) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.search_clear))
                    }
                    if (canSpeak) IconButton(onClick = { runCatching { speech.launch(speechIntent) } }) {
                        Icon(Icons.Outlined.Mic, contentDescription = stringResource(R.string.search_voice))
                    }
                }
            },
            shape = MaterialTheme.shapes.extraLarge,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = {
                saveRecent(query)
                focus.clearFocus()
            }),
        )
        Spacer(Modifier.height(8.dp))
        Box(Modifier.fillMaxSize()) {
            when (val s = state) {
                SearchState.Idle -> RecentList(
                    recent = recent,
                    onPick = { query = it; recent = store.add(it) },
                    onRemove = { recent = store.remove(it) },
                    onClear = { recent = store.clear() },
                )
                SearchState.Loading -> CircularProgressIndicator(Modifier.align(Alignment.TopCenter).padding(top = 48.dp))
                is SearchState.Failed -> ErrorState(s.error, onRetry = { retry++ })
                is SearchState.Loaded -> if (s.r.isEmpty) {
                    ro.mixai.mobile.ui.EmptyState(
                        icon = Icons.Outlined.SearchOff,
                        title = stringResource(R.string.search_no_results, s.r.query),
                        hint = stringResource(R.string.search_no_results_hint),
                    )
                } else {
                    Results(deps, nav, s.r, onOpen = { saveRecent(s.r.query) })
                }
            }
        }
    }
}

@Composable
private fun RecentList(recent: List<String>, onPick: (String) -> Unit, onRemove: (String) -> Unit, onClear: () -> Unit) {
    if (recent.isEmpty()) {
        ro.mixai.mobile.ui.EmptyState(
            icon = Icons.Filled.Search,
            title = stringResource(R.string.search_empty_title),
            hint = stringResource(R.string.search_empty_hint),
        )
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        item(key = "recent-header") {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.search_recent), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = onClear) { Text(stringResource(R.string.search_clear_all)) }
            }
        }
        items(recent, key = { "r-$it" }) { q ->
            ListItem(
                headlineContent = { Text(q, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                leadingContent = { Icon(Icons.Outlined.History, contentDescription = null) },
                trailingContent = {
                    IconButton(onClick = { onRemove(q) }) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.search_remove_recent, q))
                    }
                },
                colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                modifier = Modifier.clickable { onPick(q) },
            )
        }
    }
}

@Composable
private fun Results(deps: AppDeps, nav: Navigator, r: SearchResults, onOpen: () -> Unit) {
    val openTitle: (TitleCard) -> Unit = { onOpen(); nav.push(Dest.Title(it.kind, it.tmdbId)) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = 8.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        if (r.library.isNotEmpty()) item(key = "lib") {
            CardRow(stringResource(R.string.search_in_library), r.library) { PosterCard(deps.api, it, onClick = { openTitle(it) }) }
        }
        if (r.titles.isNotEmpty()) item(key = "titles") {
            CardRow(stringResource(R.string.search_movies_series), r.titles) { PosterCard(deps.api, it, onClick = { openTitle(it) }) }
        }
        val m = r.music
        if (m.artists.isNotEmpty() || m.albums.isNotEmpty() || m.tracks.isNotEmpty()) item(key = "music") {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                SectionTitle(stringResource(R.string.search_music))
                if (m.artists.isNotEmpty()) {
                    SubTitle(stringResource(R.string.search_artists))
                    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(m.artists.distinctBy { it.id }, key = { "a-${it.id}" }) { a ->
                            ArtistItem(deps, a) { onOpen(); nav.push(Dest.Artist(a.id)) }
                        }
                    }
                }
                if (m.albums.isNotEmpty()) {
                    SubTitle(stringResource(R.string.search_albums))
                    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(m.albums.distinctBy { it.id }, key = { "al-${it.id}" }) { al ->
                            AlbumItem(deps, al) { onOpen(); nav.push(Dest.Album(al.id)) }
                        }
                    }
                }
                if (m.tracks.isNotEmpty()) {
                    SubTitle(stringResource(R.string.search_tracks))
                    Column {
                        m.tracks.take(10).forEach { t -> TrackItem(deps, t) { onOpen(); deps.musicPlayback.play(listOf(t)) } }
                    }
                }
            }
        }
        if (r.channels.isNotEmpty()) item(key = "channels") {
            Column {
                SectionTitle(stringResource(R.string.search_channels))
                r.channels.forEach { c ->
                    ListItem(
                        headlineContent = { Text(c.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        supportingContent = { c.group?.takeIf { it.isNotBlank() }?.let { g -> Text(g, maxLines = 1) } },
                        leadingContent = {
                            Box(
                                Modifier.size(48.dp).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.surfaceContainerHigh),
                                contentAlignment = Alignment.Center,
                            ) {
                                val logo = c.logo
                                if (!logo.isNullOrBlank()) AsyncImage(logo, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize().padding(4.dp))
                                else Icon(Icons.Outlined.LiveTv, contentDescription = null)
                            }
                        },
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                        modifier = Modifier.clickable { onOpen(); nav.push(Dest.LivePlayer(c.id)) },
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 16.dp))
}

@Composable
private fun SubTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
}

@Composable
private fun ArtistItem(deps: AppDeps, a: ArtistCard, onClick: () -> Unit) {
    Column(Modifier.width(96.dp).clip(MaterialTheme.shapes.small).clickable(onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(88.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
            val url = deps.music.coverUrl(a)
            if (url != null) AsyncImage(url, contentDescription = a.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            else Icon(Icons.Outlined.MusicNote, contentDescription = null)
        }
        Spacer(Modifier.height(6.dp))
        Text(a.name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun AlbumItem(deps: AppDeps, al: AlbumCard, onClick: () -> Unit) {
    Column(Modifier.width(120.dp).clip(MaterialTheme.shapes.small).clickable(onClick = onClick)) {
        Box(Modifier.size(120.dp).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
            val url = deps.music.coverUrl(al)
            if (url != null) AsyncImage(url, contentDescription = al.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            else Icon(Icons.Outlined.MusicNote, contentDescription = null)
        }
        Spacer(Modifier.height(6.dp))
        Text(al.name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        al.artist?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
}

@Composable
private fun TrackItem(deps: AppDeps, t: TrackCard, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(t.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = { Text(listOfNotNull(t.artist, t.album).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        leadingContent = {
            Box(Modifier.size(48.dp).clip(MaterialTheme.shapes.extraSmall).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
                val url = deps.music.coverUrl(t)
                if (url != null) AsyncImage(url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                else Icon(Icons.Outlined.MusicNote, contentDescription = null)
            }
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.clickable(onClick = onClick),
    )
}
