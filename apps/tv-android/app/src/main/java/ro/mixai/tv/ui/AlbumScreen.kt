package ro.mixai.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.ListItem
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.data.Album
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Song
import ro.mixai.tv.ui.theme.Tokens

@Composable
fun AlbumScreen(api: MmoApi, album: Album, onPlay: (List<Song>, Int) -> Unit, onBack: () -> Unit) {
    var songs by remember { mutableStateOf<List<Song>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val playAll = remember { FocusRequester() }

    LaunchedEffect(album.id) {
        try { songs = api.album(album.id).song } catch (e: Exception) { error = e.message; songs = emptyList() }
    }
    LaunchedEffect(songs) { if (!songs.isNullOrEmpty()) { delay(50); runCatching { playAll.requestFocus() } } }

    Row(Modifier.fillMaxSize().padding(56.dp), horizontalArrangement = Arrangement.spacedBy(40.dp)) {
        Column(Modifier.width(320.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            AsyncImage(model = api.coverArtUrl(album.coverArt ?: album.id), contentDescription = album.name, modifier = Modifier.size(320.dp))
            Text(album.name, style = MaterialTheme.typography.headlineSmall, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(album.artist, album.year?.toString(), stringResource(R.string.album_tracks, album.songCount)).joinToString(" · "),
                color = Tokens.mutedForeground,
            )
            val s = songs
            Button(onClick = { if (!s.isNullOrEmpty()) onPlay(s, 0) }, enabled = !s.isNullOrEmpty(), modifier = Modifier.focusRequester(playAll)) {
                Text(stringResource(R.string.album_play_all))
            }
            OutlinedButton(onClick = onBack) { Text(stringResource(R.string.action_back)) }
        }
        Column(Modifier.fillMaxSize()) {
            val s = songs
            when {
                s == null -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    repeat(8) { ShimmerBox(Modifier.fillMaxWidth().height(56.dp), radius = 8.dp) }
                }
                error != null -> EmptyState("⚠", stringResource(R.string.album_load_failed), error, tone = EmptyTone.Error, modifier = Modifier.padding(0.dp))
                s.isEmpty() -> EmptyState("💿", stringResource(R.string.album_empty), modifier = Modifier.padding(0.dp))
                else -> LazyColumn(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    itemsIndexed(s, key = { _, t -> t.id }) { i, t ->
                        ListItem(
                            selected = false,
                            onClick = { onPlay(s, i) },
                            headlineContent = { Text(t.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            supportingContent = { Text(t.artist ?: album.artist ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            leadingContent = { Text("%2d".format(i + 1), color = Tokens.mutedForeground) },
                            trailingContent = { Text(fmt(t.duration), color = Tokens.mutedForeground) },
                        )
                    }
                }
            }
        }
    }
}

private fun fmt(sec: Int?): String = if (sec == null) "" else "%d:%02d".format(sec / 60, sec % 60)
