package ro.mixai.app.ui.music

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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.QueueMusic
import androidx.compose.material.icons.outlined.LibraryMusic
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Shuffle
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.app.ui.components.EmptyState
import ro.mixai.app.ui.components.ErrorState
import ro.mixai.app.ui.components.LoadingSkeleton
import ro.mixai.app.ui.components.TabHeader
import ro.mixai.app.ui.components.errorText
import ro.mixai.tv.data.generated.AlbumCard
import ro.mixai.tv.data.generated.ArtistCard
import ro.mixai.tv.data.generated.MusicHome
import ro.mixai.tv.data.generated.PlaylistCard
import ro.mixai.tv.data.generated.TrackCard

private enum class MusicTab(val label: Int) {
    Home(R.string.music_tab_home), Artists(R.string.music_tab_artists), Albums(R.string.music_tab_albums), Playlists(R.string.music_tab_playlists)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MusicScreen(deps: AppDeps, nav: Navigator) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var home by remember { mutableStateOf(PhoneMusicCache.home) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var emptyLibrary by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var openPlaylist by remember { mutableStateOf<PlaylistCard?>(null) }
    var openGenre by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(reload) {
        error = null
        try {
            val h = deps.music.home()
            PhoneMusicCache.home = h
            home = h
            emptyLibrary = h.isEmptyLibrary && deps.music.artists(offset = 0, limit = 1).total == 0L
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (home == null) error = e
        }
    }

    Column(Modifier.fillMaxSize()) {
        TabHeader(stringResource(R.string.tab_music), deps, nav)
        val h = home
        when {
            error != null -> ErrorState(error, onRetry = { reload++ })
            h == null -> LoadingSkeleton(hero = false, rows = 3, cardWidth = 140.dp)
            emptyLibrary -> EmptyState(
                icon = Icons.Outlined.LibraryMusic,
                title = stringResource(R.string.music_empty_title),
                hint = stringResource(R.string.music_empty_hint),
            ) { Button(onClick = { reload++ }) { Text(stringResource(R.string.action_retry)) } }
            else -> {
                PrimaryScrollableTabRow(selectedTabIndex = tab, edgePadding = 16.dp) {
                    MusicTab.entries.forEachIndexed { i, t ->
                        Tab(selected = tab == i, onClick = { tab = i }, text = { Text(stringResource(t.label)) })
                    }
                }
                when (MusicTab.entries[tab]) {
                    MusicTab.Home -> MusicHomeTab(deps, nav, h, onPlaylist = { openPlaylist = it }, onGenre = { openGenre = it })
                    MusicTab.Artists -> ArtistsTab(deps, nav)
                    MusicTab.Albums -> AlbumsTab(deps, nav)
                    MusicTab.Playlists -> PlaylistsTab(deps, h.playlists, onPlaylist = { openPlaylist = it })
                }
            }
        }
    }

    openPlaylist?.let { pl -> PlaylistSheet(deps, pl, onDismiss = { openPlaylist = null }) }
    openGenre?.let { g -> GenreSheet(deps, nav, g, onDismiss = { openGenre = null }) }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 8.dp))
}

@Composable
private fun AlbumRow(deps: AppDeps, nav: Navigator, title: String, albums: List<AlbumCard>) {
    if (albums.isEmpty()) return
    Column {
        SectionTitle(title)
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(albums.distinctBy { it.id }, key = { it.id }) { a ->
                AlbumTile(deps.music.coverUrl(a), a, onClick = { nav.push(Dest.Album(a.id)) })
            }
        }
    }
}

@Composable
private fun MusicHomeTab(deps: AppDeps, nav: Navigator, home: MusicHome, onPlaylist: (PlaylistCard) -> Unit, onGenre: (String) -> Unit) {
    val askNotif = rememberNotificationPermissionRequester()
    val scope = rememberCoroutineScope()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = {
                    scope.launch {
                        val songs = runCatching { PhoneSubsonic.randomSongs(deps.api) }.getOrDefault(emptyList())
                        if (songs.isNotEmpty()) { askNotif(); deps.musicPlayback.play(songs, 0) }
                    }
                }) {
                    Icon(Icons.Outlined.Shuffle, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text(stringResource(R.string.music_shuffle_all))
                }
            }
        }
        item { AlbumRow(deps, nav, stringResource(R.string.music_row_recent), home.recent) }
        item { AlbumRow(deps, nav, stringResource(R.string.music_row_newest), home.newest) }
        if (home.mostPlayed.isNotEmpty()) {
            item { SectionTitle(stringResource(R.string.music_row_most_played)) }
            val top = home.mostPlayed.take(10)
            itemsIndexed(top, key = { _, t -> "mp_" + t.id }) { i, t ->
                TrackRow(t, onClick = { askNotif(); deps.musicPlayback.play(top, i) }, cover = deps.music.coverUrl(t))
            }
        }
        if (home.playlists.isNotEmpty()) {
            item { Column {
                SectionTitle(stringResource(R.string.music_row_playlists))
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(home.playlists.distinctBy { it.id }, key = { it.id }) { p ->
                        Column(Modifier.size(width = 148.dp, height = 200.dp).clickable { onPlaylist(p) }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Cover(deps.music.coverUrl(p), Modifier.size(148.dp), icon = Icons.AutoMirrored.Outlined.QueueMusic)
                            Text(p.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                stringResource(R.string.music_tracks_count, p.songCount.toInt()),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            } }
        }
        if (home.genres.isNotEmpty()) {
            item { Column {
                SectionTitle(stringResource(R.string.music_row_genres))
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(home.genres.distinctBy { it.name }, key = { it.name }) { g ->
                        AssistChip(onClick = { onGenre(g.name) }, label = { Text(g.name) })
                    }
                }
            } }
        }
        item { AlbumRow(deps, nav, stringResource(R.string.music_row_random), home.randomAlbums) }
    }
}

@Composable
private fun ArtistsTab(deps: AppDeps, nav: Navigator) {
    val loaded = remember { mutableStateListOf<ArtistCard>() }
    var total by remember { mutableStateOf(-1L) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    val listState = rememberLazyListState()
    val pageSize = 100

    suspend fun loadMore() {
        if (loading || (total >= 0 && loaded.size >= total)) return
        loading = true
        try {
            val page = deps.music.artists(offset = loaded.size, limit = pageSize)
            total = page.total
            loaded.addAll(page.items.filter { n -> loaded.none { it.id == n.id } })
            if (page.items.isEmpty()) total = loaded.size.toLong()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e
        } finally {
            loading = false
        }
    }

    LaunchedEffect(attempt) { if (loaded.isEmpty()) loadMore() }
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last -> if (last >= loaded.size - 20 && loaded.isNotEmpty() && error == null) loadMore() }
    }

    when {
        loaded.isEmpty() && error != null -> ErrorState(error, onRetry = { error = null; attempt++ })
        loaded.isEmpty() && (loading || total < 0) -> CenteredSpinner()
        loaded.isEmpty() -> EmptyState(Icons.Outlined.LibraryMusic, stringResource(R.string.music_no_artists))
        else -> LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(vertical = 8.dp)) {
            items(loaded.distinctBy { it.id }, key = { it.id }) { a ->
                ListItem(
                    headlineContent = { Text(a.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(stringResource(R.string.music_albums_count, a.albumCount.toInt())) },
                    leadingContent = { ArtistAvatar(deps.music.coverUrl(a), 48.dp) },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                    modifier = Modifier.clickable { nav.push(Dest.Artist(a.id)) },
                )
            }
            if (loading) item { CenteredSpinner(Modifier.fillMaxWidth().height(64.dp)) }
            if (error != null) item {
                Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(errorText(error), Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                    Button(onClick = { error = null; attempt++ }) { Text(stringResource(R.string.action_retry)) }
                }
            }
        }
    }
}

@Composable
private fun AlbumsTab(deps: AppDeps, nav: Navigator) {
    val loaded = remember { mutableStateListOf<AlbumCard>() }
    var done by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    val gridState = rememberLazyGridState()
    val pageSize = 60

    suspend fun loadMore() {
        if (loading || done) return
        loading = true
        try {
            val page = PhoneSubsonic.albums(deps.api, loaded.size, pageSize)
            loaded.addAll(page.filter { n -> loaded.none { it.id == n.id } })
            if (page.size < pageSize) done = true
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e
        } finally {
            loading = false
        }
    }

    LaunchedEffect(attempt) { if (loaded.isEmpty()) loadMore() }
    LaunchedEffect(gridState) {
        snapshotFlow { gridState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last -> if (last >= loaded.size - 12 && loaded.isNotEmpty() && error == null) loadMore() }
    }

    when {
        loaded.isEmpty() && error != null -> ErrorState(error, onRetry = { error = null; attempt++ })
        loaded.isEmpty() && !done -> CenteredSpinner()
        loaded.isEmpty() -> EmptyState(Icons.Outlined.LibraryMusic, stringResource(R.string.music_no_albums))
        else -> LazyVerticalGrid(
            columns = GridCells.Adaptive(144.dp),
            state = gridState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            items(loaded.distinctBy { it.id }, key = { it.id }) { a ->
                AlbumTile(deps.music.coverUrl(a), a, onClick = { nav.push(Dest.Album(a.id)) }, width = null)
            }
        }
    }
}

@Composable
private fun PlaylistsTab(deps: AppDeps, playlists: List<PlaylistCard>, onPlaylist: (PlaylistCard) -> Unit) {
    if (playlists.isEmpty()) {
        EmptyState(Icons.AutoMirrored.Outlined.QueueMusic, stringResource(R.string.music_no_playlists), stringResource(R.string.music_no_playlists_hint))
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
        items(playlists.distinctBy { it.id }, key = { it.id }) { p ->
            ListItem(
                headlineContent = { Text(p.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                supportingContent = { Text(stringResource(R.string.music_tracks_duration, p.songCount.toInt(), fmtSec(p.durationSec))) },
                leadingContent = { Cover(deps.music.coverUrl(p), Modifier.size(56.dp), icon = Icons.AutoMirrored.Outlined.QueueMusic) },
                colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                modifier = Modifier.clickable { onPlaylist(p) },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlaylistSheet(deps: AppDeps, playlist: PlaylistCard, onDismiss: () -> Unit) {
    val askNotif = rememberNotificationPermissionRequester()
    var tracks by remember(playlist.id) { mutableStateOf<List<TrackCard>?>(null) }
    var error by remember(playlist.id) { mutableStateOf<Throwable?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(playlist.id, attempt) {
        error = null
        try { tracks = PhoneSubsonic.playlistTracks(deps.api, playlist.id) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e }
    }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(playlist.name, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(
                        stringResource(R.string.music_tracks_duration, playlist.songCount.toInt(), fmtSec(playlist.durationSec)),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                val list = tracks.orEmpty()
                IconButton(enabled = list.isNotEmpty(), onClick = { askNotif(); deps.musicPlayback.play(list.shuffled(), 0) }) {
                    Icon(Icons.Outlined.Shuffle, contentDescription = stringResource(R.string.music_shuffle))
                }
                IconButton(enabled = list.isNotEmpty(), onClick = { askNotif(); deps.musicPlayback.play(list, 0) }) {
                    Icon(Icons.Outlined.PlayArrow, contentDescription = stringResource(R.string.music_play))
                }
            }
            Spacer(Modifier.height(8.dp))
            val t = tracks
            when {
                error != null -> Box(Modifier.fillMaxWidth().height(280.dp)) { ErrorState(error, onRetry = { attempt++ }) }
                t == null -> CenteredSpinner(Modifier.fillMaxWidth().height(200.dp))
                t.isEmpty() -> Box(Modifier.fillMaxWidth().height(240.dp)) {
                    EmptyState(Icons.AutoMirrored.Outlined.QueueMusic, stringResource(R.string.music_playlist_empty))
                }
                else -> LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(bottom = 16.dp)) {
                    itemsIndexed(t, key = { i, tr -> "$i-${tr.id}" }) { i, tr ->
                        TrackRow(tr, onClick = { askNotif(); deps.musicPlayback.play(t, i) }, cover = deps.music.coverUrl(tr))
                    }
                }
            }
        }
    }
}

@Composable
internal fun CenteredSpinner(modifier: Modifier = Modifier.fillMaxSize()) {
    Box(modifier, contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GenreSheet(deps: AppDeps, nav: Navigator, genre: String, onDismiss: () -> Unit) {
    var albums by remember(genre) { mutableStateOf<List<AlbumCard>?>(null) }
    var error by remember(genre) { mutableStateOf<Throwable?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(genre, attempt) {
        error = null
        try { albums = deps.music.genre(genre, 0, 100).items } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e }
    }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Text(genre, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 16.dp))
            val list = albums
            when {
                error != null -> Box(Modifier.fillMaxWidth().height(280.dp)) { ErrorState(error, onRetry = { attempt++ }) }
                list == null -> CenteredSpinner(Modifier.fillMaxWidth().height(200.dp))
                list.isEmpty() -> Box(Modifier.fillMaxWidth().height(240.dp)) {
                    EmptyState(Icons.Outlined.LibraryMusic, stringResource(R.string.music_no_albums))
                }
                else -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(132.dp),
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    items(list.distinctBy { it.id }, key = { it.id }) { a ->
                        AlbumTile(deps.music.coverUrl(a), a, onClick = { onDismiss(); nav.push(Dest.Album(a.id)) }, width = null)
                    }
                }
            }
        }
    }
}
