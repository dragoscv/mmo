package ro.mixai.app.ui.music

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Shuffle
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.app.ui.components.ErrorState
import ro.mixai.tv.data.generated.AlbumDetail
import ro.mixai.tv.data.generated.ArtistDetail

@Composable
internal fun BackBar(nav: Navigator) {
    Box(Modifier.fillMaxWidth().statusBarsPadding().padding(4.dp)) {
        IconButton(onClick = { nav.pop() }) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.action_back))
        }
    }
}

@Composable
internal fun PlayShuffleButtons(onPlay: () -> Unit, onShuffle: () -> Unit, enabled: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Button(onClick = onPlay, enabled = enabled) {
            Icon(Icons.Outlined.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
            Text(stringResource(R.string.music_play))
        }
        FilledTonalButton(onClick = onShuffle, enabled = enabled) {
            Icon(Icons.Outlined.Shuffle, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
            Text(stringResource(R.string.music_shuffle))
        }
    }
}

@Composable
fun AlbumScreen(deps: AppDeps, nav: Navigator, id: String) {
    var detail by remember(id) { mutableStateOf<AlbumDetail?>(null) }
    var error by remember(id) { mutableStateOf<Throwable?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    val askNotif = rememberNotificationPermissionRequester()
    LaunchedEffect(id, attempt) {
        error = null
        try { detail = deps.music.album(id) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e }
    }

    Column(Modifier.fillMaxSize()) {
        BackBar(nav)
        val d = detail
        when {
            error != null -> ErrorState(error, onRetry = { attempt++ })
            d == null -> CenteredSpinner()
            else -> {
                val tracks = d.tracks
                val totalSec = tracks.sumOf { it.durationSec }.takeIf { it > 0 } ?: d.album.durationSec
                fun playFrom(i: Int, shuffle: Boolean = false) {
                    if (tracks.isEmpty()) return
                    askNotif()
                    if (shuffle) deps.musicPlayback.play(tracks.shuffled(), 0) else deps.musicPlayback.play(tracks, i)
                }
                val multiDisc = tracks.mapNotNull { it.disc }.distinct().size > 1
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    item {
                        Column(
                            Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Cover(deps.music.coverUrl(d.album), Modifier.fillMaxWidth(0.7f).widthIn(max = 320.dp).aspectRatio(1f))
                            Text(d.album.name, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
                            val artist = d.album.artist
                            if (!artist.isNullOrBlank()) {
                                Text(
                                    artist, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.clickable(enabled = !d.album.artistId.isNullOrBlank()) {
                                        d.album.artistId?.let { nav.push(Dest.Artist(it)) }
                                    },
                                )
                            }
                            val meta = listOfNotNull(
                                d.album.year?.toString(),
                                stringResource(R.string.music_tracks_count, tracks.size.takeIf { it > 0 } ?: d.album.songCount.toInt()),
                                fmtSec(totalSec).takeIf { totalSec > 0 },
                            ).joinToString(" · ")
                            Text(meta, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.size(4.dp))
                            PlayShuffleButtons(onPlay = { playFrom(0) }, onShuffle = { playFrom(0, shuffle = true) }, enabled = tracks.isNotEmpty())
                            Spacer(Modifier.size(8.dp))
                        }
                    }
                    if (tracks.isEmpty()) {
                        item {
                            Text(
                                stringResource(R.string.music_album_no_tracks), Modifier.fillMaxWidth().padding(24.dp),
                                textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    itemsIndexed(tracks, key = { i, t -> "$i-${t.id}" }) { i, t ->
                        val n = t.track?.let { if (multiDisc && t.disc != null) "${t.disc}.$it" else "$it" } ?: "${i + 1}"
                        TrackRow(t, onClick = { playFrom(i) }, number = n)
                    }
                }
            }
        }
    }
}

@Composable
fun ArtistScreen(deps: AppDeps, nav: Navigator, id: String) {
    var detail by remember(id) { mutableStateOf<ArtistDetail?>(null) }
    var error by remember(id) { mutableStateOf<Throwable?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    val askNotif = rememberNotificationPermissionRequester()
    LaunchedEffect(id, attempt) {
        error = null
        try { detail = deps.music.artist(id) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e }
    }

    Column(Modifier.fillMaxSize()) {
        BackBar(nav)
        val d = detail
        when {
            error != null -> ErrorState(error, onRetry = { attempt++ })
            d == null -> CenteredSpinner()
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        ArtistAvatar(deps.music.coverUrl(d.artist), 160.dp)
                        Text(d.artist.name, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
                        Text(
                            stringResource(R.string.music_artist_meta, d.artist.albumCount.toInt(), d.artist.songCount.toInt()),
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        val top = d.topTracks
                        PlayShuffleButtons(
                            onPlay = { askNotif(); deps.musicPlayback.play(top, 0) },
                            onShuffle = { askNotif(); deps.musicPlayback.play(top.shuffled(), 0) },
                            enabled = top.isNotEmpty(),
                        )
                    }
                }
                if (d.topTracks.isNotEmpty()) {
                    item { ArtistSection(stringResource(R.string.music_top_tracks)) }
                    val top = d.topTracks.take(10)
                    itemsIndexed(top, key = { i, t -> "top-$i-${t.id}" }) { i, t ->
                        TrackRow(t, onClick = { askNotif(); deps.musicPlayback.play(top, i) }, cover = deps.music.coverUrl(t))
                    }
                }
                if (d.albums.isNotEmpty()) {
                    item { ArtistSection(stringResource(R.string.music_albums)) }
                    // Adaptive two-to-many columns rendered as rows of tiles (nested grids are not allowed in a LazyColumn).
                    val rows = d.albums.chunked(2)
                    items(rows.size) { r ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            rows[r].forEach { a ->
                                Box(Modifier.weight(1f)) {
                                    AlbumTile(deps.music.coverUrl(a), a, onClick = { nav.push(Dest.Album(a.id)) }, width = null)
                                }
                            }
                            if (rows[r].size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                }
                if (d.similar.isNotEmpty()) {
                    item { Column {
                        ArtistSection(stringResource(R.string.music_similar_artists))
                        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            items(d.similar.distinctBy { it.id }, key = { it.id }) { s ->
                                Column(
                                    Modifier.widthIn(max = 96.dp).clickable { nav.push(Dest.Artist(s.id)) },
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    ArtistAvatar(deps.music.coverUrl(s), 88.dp)
                                    Text(
                                        s.name, style = MaterialTheme.typography.bodySmall, maxLines = 2,
                                        overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
                                    )
                                }
                            }
                        }
                    } }
                }
            }
        }
    }
}

@Composable
private fun ArtistSection(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 8.dp))
}
