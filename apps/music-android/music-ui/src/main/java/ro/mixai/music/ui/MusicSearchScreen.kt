package ro.mixai.music.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import ro.mixai.mobile.ui.EmptyState
import ro.mixai.mobile.ui.ErrorState
import ro.mixai.tv.data.generated.MusicSearch

/** Minimum characters before the server is asked (single letters match half the library). */
internal const val MIN_QUERY = 2

/** Debounced `/media/music/search`: artists row, albums row, tracks list. */
@Composable
fun MusicSearchScreen(deps: MusicDeps, nav: MusicNav, header: @Composable () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var result by remember { mutableStateOf<MusicSearch?>(null) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var loading by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    val keyboard = LocalSoftwareKeyboardController.current
    val askNotif = rememberNotificationPermissionRequester()

    LaunchedEffect(query, attempt) {
        val q = query.trim()
        if (q.length < MIN_QUERY) { result = null; error = null; loading = false; return@LaunchedEffect }
        delay(300)
        loading = true
        try { result = deps.music.search(q); error = null } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e } finally { loading = false }
    }

    Column(Modifier.fillMaxSize()) {
        header()
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            placeholder = { Text(stringResource(R.string.music_search_hint)) },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            trailingIcon = {
                if (query.isNotEmpty()) IconButton(onClick = { query = "" }) {
                    Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.music_search_clear))
                }
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
        )
        val r = result
        when {
            query.trim().length < MIN_QUERY -> EmptyState(Icons.Outlined.Search, stringResource(R.string.music_search_title), stringResource(R.string.music_search_prompt))
            error != null -> ErrorState(error, onRetry = { attempt++ })
            r == null || loading && r.query != query.trim() -> CenteredSpinner()
            r.artists.isEmpty() && r.albums.isEmpty() && r.tracks.isEmpty() ->
                EmptyState(Icons.Outlined.Search, stringResource(R.string.music_search_none, query.trim()))
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                if (r.artists.isNotEmpty()) {
                    item { SearchSection(stringResource(R.string.music_tab_artists)) }
                    item {
                        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            items(r.artists.distinctBy { it.id }, key = { it.id }) { a ->
                                Column(Modifier.clickable { nav.openArtist(a.id) }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    ArtistAvatar(deps.music.coverUrl(a), 88.dp)
                                    Text(a.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                                }
                            }
                        }
                    }
                }
                if (r.albums.isNotEmpty()) {
                    item { SearchSection(stringResource(R.string.music_tab_albums)) }
                    item {
                        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            items(r.albums.distinctBy { it.id }, key = { it.id }) { a ->
                                AlbumTile(deps.music.coverUrl(a), a, onClick = { nav.openAlbum(a.id) })
                            }
                        }
                    }
                }
                if (r.tracks.isNotEmpty()) {
                    item { SearchSection(stringResource(R.string.music_search_tracks)) }
                    val tracks = r.tracks.distinctBy { it.id }
                    itemsIndexed(tracks, key = { _, t -> "t-" + t.id }) { i, t ->
                        TrackRow(t, onClick = { askNotif(); deps.musicPlayback.play(tracks, i) }, cover = deps.music.coverUrl(t))
                    }
                }
            }
        }
    }
}

@Composable
private fun SearchSection(text: String) {
    Box(Modifier.fillMaxWidth()) {
        ListItem(
            headlineContent = { Text(text, style = MaterialTheme.typography.titleMedium) },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        )
    }
}
