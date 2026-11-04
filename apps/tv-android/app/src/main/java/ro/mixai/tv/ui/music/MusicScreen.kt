package ro.mixai.tv.ui.music

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Search
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.generated.AlbumCard
import ro.mixai.tv.data.generated.ArtistCard
import ro.mixai.tv.data.generated.MusicHome
import ro.mixai.tv.data.generated.MusicSearch
import ro.mixai.tv.data.generated.PlaylistCard
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.LocalBackdrop
import ro.mixai.tv.ui.components.MediaRow
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.SkeletonPosterRow
import ro.mixai.tv.ui.components.TvKeyboard
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.RestorableFocus
import ro.mixai.tv.ui.nav.RestoreFocusOnReturn
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.nav.rememberRestorableFocus
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

private enum class MusicTab(val label: Int) {
    Home(R.string.music_tab_home), Artists(R.string.music_tab_artists), Albums(R.string.music_tab_albums),
    Playlists(R.string.music_tab_playlists), Search(R.string.music_tab_search),
}

private val LETTERS: List<String> = listOf("") + ('A'..'Z').map { it.toString() } + "#"

/** Music home (Plexamp TV / Apple Music tvOS style): tabs Home · Artists · Albums · Playlists · Search. */
@Composable
fun MusicScreen(deps: ScreenDeps, nav: Navigator) {
    var tabName by rememberSaveable { mutableStateOf(MusicTab.Home.name) }
    val tab = MusicTab.valueOf(tabName)
    var genre by rememberSaveable { mutableStateOf<String?>(null) }
    val rf = rememberRestorableFocus("music")
    RestoreFocusOnReturn(rf)
    val backdrop = LocalBackdrop.current
    val profile = deps.profiles.activeId

    var home by remember { mutableStateOf<Load<MusicHome>>(MusicHomeCache.get(profile)?.let { Load.Ok(it) } ?: Load.Loading) }
    var reload by remember { mutableIntStateOf(0) }
    val errText = stringResource(R.string.music_load_error)
    LaunchedEffect(profile, reload) {
        if (home !is Load.Ok) home = Load.Loading
        home = try {
            val h = deps.music.home()
            MusicHomeCache.put(profile, h)
            Load.Ok(h)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (home is Load.Ok) home else Load.Err(e.message ?: errText)
        }
    }

    if (genre != null) BackHandler { genre = null }

    val playPlaylist = rememberPlaylistPlayer(deps, nav)
    val onAlbum: (AlbumCard) -> Unit = { nav.push(Route.Album(it.id)) }
    val onFocusAlbum: (AlbumCard) -> Unit = { backdrop.show(deps.music.backdropCover(it.coverArt)) }

    Column(Modifier.fillMaxSize()) {
        // ── header: title + tabs ──
        Row(
            Modifier.fillMaxWidth().padding(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = MixaiFocus.overscanTop, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.music_title), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground, modifier = Modifier.padding(end = 20.dp))
            MusicTab.entries.forEach { t ->
                val icon = when (t) { MusicTab.Home -> Icons.Filled.Home; MusicTab.Search -> Icons.Filled.Search; else -> null }
                PillButton(
                    label = stringResource(t.label),
                    selected = t == tab,
                    icon = icon,
                    onClick = { tabName = t.name; genre = null },
                    modifier = (if (t == MusicTab.Home) Modifier.focusRequester(rf.requester) else Modifier).then(rf.item("tab:${t.name}")),
                )
            }
        }

        Box(Modifier.fillMaxSize()) {
            val g = genre
            when {
                g != null -> GenreGrid(deps, g, onAlbum, onFocusAlbum)
                tab == MusicTab.Home -> when (val h = home) {
                    Load.Loading -> LoadingState(rows = 3, hero = false)
                    is Load.Err -> ErrorState(h.message, onRetry = { reload++ })
                    is Load.Ok -> if (h.value.isEmptyLibrary) NoLibrary() else HomeRows(
                        deps, h.value, rf,
                        onAlbum = onAlbum, onFocusAlbum = onFocusAlbum,
                        onGenre = { genre = it },
                        onPlaylist = playPlaylist,
                    )
                }
                tab == MusicTab.Artists -> ArtistsGrid(deps, nav)
                tab == MusicTab.Albums -> AlbumsGrid(deps, onAlbum, onFocusAlbum)
                tab == MusicTab.Playlists -> when (val h = home) {
                    Load.Loading -> LoadingState(rows = 1, hero = false)
                    is Load.Err -> ErrorState(h.message, onRetry = { reload++ })
                    is Load.Ok -> PlaylistsGrid(deps, h.value.playlists, playPlaylist)
                }
                tab == MusicTab.Search -> MusicSearchPane(deps, nav)
            }
        }
    }
}

@Composable
private fun NoLibrary() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        EmptyState(
            icon = MixaiIcons.MusicNote,
            title = stringResource(R.string.music_empty_title),
            message = stringResource(R.string.music_empty_message),
        )
    }
}

/** Fetches a playlist's tracks, starts it and opens Now Playing. */
@Composable
private fun rememberPlaylistPlayer(deps: ScreenDeps, nav: Navigator): (PlaylistCard) -> Unit {
    val scope = rememberCoroutineScope()
    return remember(deps, nav) {
        fun(p: PlaylistCard) {
            scope.launch {
                val tracks = runCatching { MusicSubsonic.playlistTracks(deps.api, p.id) }.getOrDefault(emptyList())
                if (tracks.isNotEmpty()) {
                    deps.musicPlayback.play(tracks, 0)
                    nav.push(Route.NowPlaying)
                }
            }
        }
    }
}

// ─── Home ───────────────────────────────────────────────────────────────────

@Composable
private fun HomeRows(
    deps: ScreenDeps,
    home: MusicHome,
    rf: RestorableFocus,
    onAlbum: (AlbumCard) -> Unit,
    onFocusAlbum: (AlbumCard) -> Unit,
    onGenre: (String) -> Unit,
    onPlaylist: (PlaylistCard) -> Unit,
) {
    val backdrop = LocalBackdrop.current
    val scope = rememberCoroutineScope()
    val music = deps.music
    // One shared-element key per album on screen: "Recently played" owns it, "New albums" the rest.
    val recentIds = remember(home) { home.recent.mapTo(HashSet()) { it.id } }
    val newestShared = remember(home) { home.newest.map { it.id }.filterTo(HashSet()) { it !in recentIds } }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = 8.dp, bottom = 64.dp),
        verticalArrangement = Arrangement.spacedBy(28.dp),
    ) {
        if (home.recent.isNotEmpty()) item("recent") {
            AlbumRow(stringResource(R.string.music_row_recent), "recent", home.recent, recentIds, deps, rf, onAlbum, onFocusAlbum)
        }
        if (home.newest.isNotEmpty()) item("newest") {
            AlbumRow(stringResource(R.string.music_row_new), "newest", home.newest, newestShared, deps, rf, onAlbum, onFocusAlbum)
        }
        if (home.mostPlayed.isNotEmpty()) item("most") {
            MediaRow(
                title = stringResource(R.string.music_row_most_played),
                items = home.mostPlayed,
                key = { it.id },
                onFocusItem = { backdrop.show(music.backdropCover(it.coverArt)) },
                onClick = {},
                spacing = 16.dp,
            ) { t, i, onFocus, _ ->
                TrackChip(
                    coverUrl = music.coverUrl(t),
                    title = t.title,
                    subtitle = t.artist,
                    onClick = { deps.musicPlayback.play(home.mostPlayed, i) },
                    onFocus = onFocus,
                    modifier = rf.item("most:${t.id}"),
                )
            }
        }
        if (home.playlists.isNotEmpty()) item("playlists") {
            MediaRow(
                title = stringResource(R.string.music_row_playlists),
                items = home.playlists,
                key = { it.id },
                onClick = onPlaylist,
            ) { p, _, onFocus, onClick ->
                AlbumTile(
                    imageUrl = music.coverUrl(p),
                    title = p.name,
                    subtitle = pluralStringResource(R.plurals.music_songs_count, p.songCount.toInt(), p.songCount.toInt()),
                    onClick = onClick,
                    onFocus = { onFocus(); backdrop.show(music.backdropCover(p.coverArt)) },
                    modifier = rf.item("pl:${p.id}"),
                )
            }
        }
        if (home.genres.isNotEmpty()) item("genres") {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                MusicRowHeader(stringResource(R.string.music_row_genres))
                LazyRow(
                    Modifier.fillMaxWidth().focusRestorer(),
                    contentPadding = PaddingValues(horizontal = MixaiFocus.overscan, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(home.genres, key = { it.name }) { gc ->
                        PillButton(gc.name, onClick = { onGenre(gc.name) }, modifier = rf.item("genre:${gc.name}"))
                    }
                }
            }
        }
        if (home.randomAlbums.isNotEmpty()) item("random") {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                MusicRowHeader(stringResource(R.string.music_row_random)) {
                    PillButton(
                        stringResource(R.string.music_shuffle_all),
                        icon = MixaiIcons.Shuffle,
                        compact = true,
                        modifier = rf.item("mix"),
                        onClick = {
                            scope.launch {
                                val tracks = runCatching { MusicSubsonic.randomSongs(deps.api, 100) }.getOrDefault(emptyList())
                                if (tracks.isNotEmpty()) deps.musicPlayback.play(tracks, 0)
                            }
                        },
                    )
                }
                AlbumRow("", "random", home.randomAlbums, emptySet(), deps, rf, onAlbum, onFocusAlbum)
            }
        }
    }
}

@Composable
private fun AlbumRow(
    title: String,
    rowKey: String,
    albums: List<AlbumCard>,
    sharedIds: Set<String>,
    deps: ScreenDeps,
    rf: RestorableFocus,
    onAlbum: (AlbumCard) -> Unit,
    onFocusAlbum: (AlbumCard) -> Unit,
) {
    MediaRow(title = title, items = albums, key = { it.id }, onFocusItem = onFocusAlbum, onClick = onAlbum) { a, _, onFocus, onClick ->
        AlbumTile(
            imageUrl = deps.music.coverUrl(a),
            title = a.name,
            subtitle = a.artist,
            onClick = onClick,
            onFocus = onFocus,
            sharedKey = if (a.id in sharedIds) albumSharedKey(a.id) else null,
            modifier = rf.item("$rowKey:${a.id}"),
        )
    }
}

// ─── Grids ──────────────────────────────────────────────────────────────────

private const val PAGE = 60

/** Infinite-scroll helper: calls [loadMore] when the last visible item nears the end. */
@Composable
private fun LoadMoreEffect(state: LazyGridState, count: Int, canLoad: Boolean, loadMore: () -> Unit) {
    LaunchedEffect(state, count, canLoad) {
        if (!canLoad) return@LaunchedEffect
        snapshotFlow { state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last -> if (count > 0 && last >= count - 12) loadMore() }
    }
}

@Composable
private fun ArtistsGrid(deps: ScreenDeps, nav: Navigator) {
    var letter by rememberSaveable { mutableStateOf("") }
    val items = remember(letter) { mutableStateListOf<ArtistCard>() }
    var total by remember(letter) { mutableStateOf(-1L) }
    var loading by remember(letter) { mutableStateOf(false) }
    var error by remember(letter) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val backdrop = LocalBackdrop.current
    val grid = rememberLazyGridState()
    val errText = stringResource(R.string.music_load_error)

    fun loadMore() {
        if (loading || (total >= 0 && items.size >= total)) return
        loading = true
        val forLetter = letter
        scope.launch {
            try {
                val page = deps.music.artists(forLetter.ifBlank { null }, items.size, PAGE)
                if (forLetter == letter) { total = page.total; items.addAll(page.items); error = null }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: errText
            } finally {
                loading = false
            }
        }
    }
    LaunchedEffect(letter) { if (items.isEmpty()) loadMore() }
    LoadMoreEffect(grid, items.size, total < 0 || items.size < total) { loadMore() }

    Column(Modifier.fillMaxSize()) {
        LetterBar(letter) { letter = it }
        when {
            error != null && items.isEmpty() -> ErrorState(error!!, onRetry = { error = null; loadMore() })
            total < 0 && items.isEmpty() -> SkeletonPosterRow(count = 6, width = ARTIST_TILE, aspect = 1f)
            items.isEmpty() -> EmptyState(MixaiIcons.MusicNote, stringResource(R.string.music_no_artists), focusAction = false)
            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(ARTIST_TILE + 24.dp),
                state = grid,
                modifier = Modifier.fillMaxSize().focusRestorer(),
                contentPadding = PaddingValues(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = 12.dp, bottom = 64.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
                horizontalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                itemsIndexed(items, key = { _, a -> a.id }) { _, a ->
                    ArtistTile(
                        imageUrl = deps.music.coverUrl(a),
                        name = a.name,
                        subtitle = pluralStringResource(R.plurals.music_albums_count, a.albumCount.toInt(), a.albumCount.toInt()),
                        onClick = { nav.push(Route.Artist(a.id)) },
                        onFocus = { backdrop.show(deps.music.backdropCover(a.coverArt)) },
                    )
                }
            }
        }
    }
}

@Composable
private fun LetterBar(selected: String, onPick: (String) -> Unit) {
    LazyRow(
        Modifier.fillMaxWidth().focusRestorer(),
        contentPadding = PaddingValues(horizontal = MixaiFocus.overscan, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(LETTERS, key = { it.ifBlank { "*" } }) { l ->
            PillButton(if (l.isBlank()) stringResource(R.string.music_all) else l, onClick = { onPick(l) }, selected = l == selected, compact = true)
        }
    }
}

@Composable
private fun AlbumsGrid(deps: ScreenDeps, onAlbum: (AlbumCard) -> Unit, onFocusAlbum: (AlbumCard) -> Unit) {
    val items = remember { mutableStateListOf<AlbumCard>() }
    var done by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val grid = rememberLazyGridState()
    val errText = stringResource(R.string.music_load_error)

    fun loadMore() {
        if (loading || done) return
        loading = true
        scope.launch {
            try {
                val page = MusicSubsonic.albums(deps.api, items.size, PAGE)
                val known = items.mapTo(HashSet()) { it.id }
                items.addAll(page.filter { it.id !in known })
                if (page.size < PAGE) done = true
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: errText
            } finally {
                loading = false
            }
        }
    }
    LaunchedEffect(Unit) { if (items.isEmpty()) loadMore() }
    LoadMoreEffect(grid, items.size, !done) { loadMore() }

    when {
        error != null && items.isEmpty() -> ErrorState(error!!, onRetry = { error = null; loadMore() })
        items.isEmpty() && !done -> SkeletonPosterRow(count = 6, width = ALBUM_TILE, aspect = 1f)
        items.isEmpty() -> EmptyState(MixaiIcons.MusicNote, stringResource(R.string.music_no_albums), focusAction = false)
        else -> LazyVerticalGrid(
            columns = GridCells.Adaptive(ALBUM_TILE + 24.dp),
            state = grid,
            modifier = Modifier.fillMaxSize().focusRestorer(),
            contentPadding = PaddingValues(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = 12.dp, bottom = 64.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
            horizontalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            itemsIndexed(items, key = { _, a -> a.id }) { _, a ->
                AlbumTile(
                    imageUrl = deps.music.coverUrl(a),
                    title = a.name,
                    subtitle = a.artist,
                    onClick = { onAlbum(a) },
                    onFocus = { onFocusAlbum(a) },
                    sharedKey = albumSharedKey(a.id),
                )
            }
        }
    }
}

@Composable
private fun GenreGrid(deps: ScreenDeps, genre: String, onAlbum: (AlbumCard) -> Unit, onFocusAlbum: (AlbumCard) -> Unit) {
    var state by remember(genre) { mutableStateOf<Load<List<AlbumCard>>>(Load.Loading) }
    var retry by remember { mutableIntStateOf(0) }
    val errText = stringResource(R.string.music_load_error)
    val first = remember { FocusRequester() }
    LaunchedEffect(genre, retry) {
        state = Load.Loading
        state = try {
            Load.Ok(deps.music.genre(genre, 0, 200).items)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Load.Err(e.message ?: errText)
        }
    }
    Column(Modifier.fillMaxSize()) {
        MusicRowHeader(genre)
        when (val s = state) {
            Load.Loading -> SkeletonPosterRow(count = 6, width = ALBUM_TILE, aspect = 1f)
            is Load.Err -> ErrorState(s.message, onRetry = { retry++ })
            is Load.Ok -> if (s.value.isEmpty()) {
                EmptyState(MixaiIcons.MusicNote, stringResource(R.string.music_no_albums), focusAction = false)
            } else {
                LaunchedEffect(Unit) { delay(80); runCatching { first.requestFocus() } }
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(ALBUM_TILE + 24.dp),
                    modifier = Modifier.fillMaxSize().focusRestorer(first),
                    contentPadding = PaddingValues(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = 12.dp, bottom = 64.dp),
                    verticalArrangement = Arrangement.spacedBy(24.dp),
                    horizontalArrangement = Arrangement.spacedBy(24.dp),
                ) {
                    itemsIndexed(s.value, key = { _, a -> a.id }) { i, a ->
                        AlbumTile(
                            imageUrl = deps.music.coverUrl(a),
                            title = a.name,
                            subtitle = a.artist,
                            onClick = { onAlbum(a) },
                            onFocus = { onFocusAlbum(a) },
                            modifier = if (i == 0) Modifier.focusRequester(first) else Modifier,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PlaylistsGrid(deps: ScreenDeps, playlists: List<PlaylistCard>, onPlaylist: (PlaylistCard) -> Unit) {
    if (playlists.isEmpty()) {
        EmptyState(MixaiIcons.Queue, stringResource(R.string.music_no_playlists), focusAction = false)
        return
    }
    val backdrop = LocalBackdrop.current
    LazyVerticalGrid(
        columns = GridCells.Adaptive(ALBUM_TILE + 24.dp),
        modifier = Modifier.fillMaxSize().focusRestorer(),
        contentPadding = PaddingValues(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = 12.dp, bottom = 64.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
        horizontalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        itemsIndexed(playlists, key = { _, p -> p.id }) { _, p ->
            AlbumTile(
                imageUrl = deps.music.coverUrl(p),
                title = p.name,
                subtitle = pluralStringResource(R.plurals.music_songs_count, p.songCount.toInt(), p.songCount.toInt()),
                onClick = { onPlaylist(p) },
                onFocus = { backdrop.show(deps.music.backdropCover(p.coverArt)) },
            )
        }
    }
}

// ─── Search ─────────────────────────────────────────────────────────────────

@Composable
private fun MusicSearchPane(deps: ScreenDeps, nav: Navigator) {
    var query by rememberSaveable { mutableStateOf("") }
    var result by remember { mutableStateOf<Load<MusicSearch>?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    val errText = stringResource(R.string.music_load_error)
    LaunchedEffect(query, retry) {
        val q = query.trim()
        if (q.isEmpty()) { result = null; return@LaunchedEffect }
        delay(300)
        if (result == null) result = Load.Loading
        result = try {
            Load.Ok(deps.music.search(q))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Load.Err(e.message ?: errText)
        }
    }
    val backdrop = LocalBackdrop.current
    Row(Modifier.fillMaxSize().padding(start = MixaiFocus.overscan, top = 8.dp), horizontalArrangement = Arrangement.spacedBy(32.dp)) {
        Column(Modifier.width(440.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(
                query.ifEmpty { stringResource(R.string.music_search_hint) },
                style = if (query.isEmpty()) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.headlineSmall,
                color = if (query.isEmpty()) Tokens.mutedForeground else Tokens.foreground,
                maxLines = 2,
            )
            TvKeyboard(text = query, onTextChange = { query = it }, requestInitialFocus = true)
        }
        Box(Modifier.weight(1f).fillMaxSize()) {
            when (val r = result) {
                null -> Unit
                Load.Loading -> SkeletonPosterRow(count = 4, width = ALBUM_TILE, aspect = 1f)
                is Load.Err -> ErrorState(r.message, onRetry = { retry++ })
                is Load.Ok -> {
                    val s = r.value
                    if (s.artists.isEmpty() && s.albums.isEmpty() && s.tracks.isEmpty()) {
                        EmptyState(Icons.Filled.Search, stringResource(R.string.music_search_empty, query.trim()), focusAction = false)
                    } else {
                        LazyColumn(
                            Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(bottom = 64.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            if (s.tracks.isNotEmpty()) {
                                item("th") { Text(stringResource(R.string.music_search_tracks), style = MaterialTheme.typography.titleLarge, color = Tokens.foreground) }
                                itemsIndexed(s.tracks.take(8), key = { _, t -> "t:${t.id}" }) { i, t ->
                                    TrackListItem(
                                        number = "${i + 1}",
                                        title = t.title,
                                        subtitle = listOfNotNull(t.artist, t.album).joinToString(" · "),
                                        duration = formatDuration(t.durationSec),
                                        coverUrl = deps.music.coverUrl(t),
                                        hasLyrics = t.hasLyrics,
                                        onClick = { deps.musicPlayback.play(s.tracks, i); nav.push(Route.NowPlaying) },
                                        onFocus = { backdrop.show(deps.music.backdropCover(t.coverArt)) },
                                        modifier = Modifier.padding(end = MixaiFocus.overscan),
                                    )
                                }
                            }
                            if (s.albums.isNotEmpty()) item("al") {
                                SearchRow(stringResource(R.string.music_search_albums), s.albums, { it.id }) { a ->
                                    AlbumTile(deps.music.coverUrl(a), a.name, a.artist, onClick = { nav.push(Route.Album(a.id)) }, width = 170.dp)
                                }
                            }
                            if (s.artists.isNotEmpty()) item("ar") {
                                SearchRow(stringResource(R.string.music_search_artists), s.artists, { it.id }) { a ->
                                    ArtistTile(deps.music.coverUrl(a), a.name, null, onClick = { nav.push(Route.Artist(a.id)) }, width = 150.dp)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun <T> SearchRow(title: String, items: List<T>, key: (T) -> Any, content: @Composable (T) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge, color = Tokens.foreground)
        LazyRow(
            Modifier.fillMaxWidth().focusRestorer(),
            contentPadding = PaddingValues(end = MixaiFocus.overscan, top = 8.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            items(items, key = key) { content(it) }
        }
    }
}
