package ro.mixai.tv.ui.music

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.generated.ArtistDetail
import ro.mixai.tv.data.generated.TrackCard
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.LocalBackdrop
import ro.mixai.tv.ui.components.MediaRow
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.RestoreFocusOnReturn
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.nav.rememberRestorableFocus
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

/** Artist page: header (image, name, counts, Play / Shuffle), top tracks, albums by year, similar artists. */
@Composable
fun ArtistScreen(deps: ScreenDeps, nav: Navigator, artistId: String) {
    var state by remember(artistId) { mutableStateOf<Load<ArtistDetail>>(Load.Loading) }
    var retry by remember { mutableIntStateOf(0) }
    val errText = stringResource(R.string.music_load_error)
    LaunchedEffect(artistId, retry) {
        state = Load.Loading
        state = try {
            Load.Ok(deps.music.artist(artistId))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Load.Err(e.message ?: errText)
        }
    }
    when (val s = state) {
        Load.Loading -> LoadingState(rows = 2)
        is Load.Err -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { ErrorState(s.message, onRetry = { retry++ }) }
        is Load.Ok -> ArtistContent(deps, nav, artistId, s.value)
    }
}

@Composable
private fun ArtistContent(deps: ScreenDeps, nav: Navigator, artistId: String, d: ArtistDetail) {
    val rf = rememberRestorableFocus("artist-$artistId")
    RestoreFocusOnReturn(rf)
    val backdrop = LocalBackdrop.current
    val music = deps.music
    val a = d.artist
    LaunchedEffect(a.id) { backdrop.show(music.backdropCover(a.coverArt)) }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }

    /** Plays every album track of the artist (albums by year), optionally shuffled; falls back to top tracks. */
    fun playAll(shuffle: Boolean) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                val fromAlbums = d.albums.take(40).flatMap { al -> runCatching { music.album(al.id).tracks }.getOrDefault(emptyList()) }
                val tracks = fromAlbums.ifEmpty { d.topTracks }
                if (tracks.isNotEmpty()) {
                    deps.musicPlayback.play(if (shuffle) tracks.shuffled() else tracks, 0)
                    nav.push(Route.NowPlaying)
                }
            } finally {
                busy = false
            }
        }
    }
    val canPlay = d.topTracks.isNotEmpty() || d.albums.isNotEmpty()

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = MixaiFocus.overscanTop, bottom = 64.dp),
        verticalArrangement = Arrangement.spacedBy(28.dp),
    ) {
        item("header") {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = MixaiFocus.overscan),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(36.dp),
            ) {
                ArtworkOrPlaceholder(music.coverUrl(a), a.name, Modifier.size(220.dp).clip(CircleShape))
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(a.name.ifBlank { stringResource(R.string.music_unknown_artist) }, style = MaterialTheme.typography.displaySmall, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(
                        pluralStringResource(R.plurals.music_albums_count, a.albumCount.toInt(), a.albumCount.toInt()) + " · " +
                            pluralStringResource(R.plurals.music_songs_count, a.songCount.toInt(), a.songCount.toInt()),
                        style = MaterialTheme.typography.bodyLarge,
                        color = Tokens.mutedForeground,
                    )
                    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        PrimaryButton(
                            stringResource(R.string.music_play),
                            onClick = { playAll(false) },
                            icon = Icons.Filled.PlayArrow,
                            enabled = canPlay,
                            modifier = Modifier.focusRequester(rf.requester).then(rf.item("play")),
                        )
                        SecondaryButton(
                            stringResource(R.string.music_shuffle),
                            onClick = { playAll(true) },
                            icon = MixaiIcons.Shuffle,
                            enabled = canPlay,
                            modifier = rf.item("shuffle"),
                        )
                    }
                }
            }
        }
        if (d.topTracks.isNotEmpty()) {
            item("topTitle") { MusicRowHeader(stringResource(R.string.music_top_tracks)) }
            itemsIndexed(d.topTracks, key = { _, t -> "t:${t.id}" }) { i, t ->
                TopTrackRow(deps, nav, d.topTracks, i, t, Modifier.padding(horizontal = MixaiFocus.overscan).then(rf.item("t:${t.id}")))
            }
        }
        if (d.albums.isNotEmpty()) item("albums") {
            MediaRow(
                title = stringResource(R.string.music_albums),
                items = d.albums,
                key = { it.id },
                onFocusItem = { backdrop.show(music.backdropCover(it.coverArt)) },
                onClick = { nav.push(Route.Album(it.id)) },
            ) { al, _, onFocus, onClick ->
                AlbumTile(
                    imageUrl = music.coverUrl(al),
                    title = al.name,
                    subtitle = al.year?.toString(),
                    onClick = onClick,
                    onFocus = onFocus,
                    sharedKey = albumSharedKey(al.id),
                    modifier = rf.item("al:${al.id}"),
                )
            }
        }
        if (d.similar.isNotEmpty()) item("similar") {
            MediaRow(
                title = stringResource(R.string.music_similar),
                items = d.similar,
                key = { it.id },
                onClick = { nav.push(Route.Artist(it.id)) },
            ) { s, _, onFocus, onClick ->
                ArtistTile(
                    imageUrl = music.coverUrl(s),
                    name = s.name,
                    subtitle = null,
                    onClick = onClick,
                    onFocus = onFocus,
                    width = 150.dp,
                    modifier = rf.item("sim:${s.id}"),
                )
            }
        }
    }
}

@Composable
private fun TopTrackRow(deps: ScreenDeps, nav: Navigator, all: List<TrackCard>, index: Int, t: TrackCard, modifier: Modifier) {
    val playing by deps.musicPlayback.state.collectAsState()
    TrackListItem(
        number = "${index + 1}",
        title = t.title,
        subtitle = t.album,
        duration = formatDuration(t.durationSec),
        coverUrl = deps.music.coverUrl(t),
        hasLyrics = t.hasLyrics,
        active = playing.track?.id == t.id,
        onClick = { deps.musicPlayback.play(all, index); nav.push(Route.NowPlaying) },
        modifier = modifier,
    )
}
