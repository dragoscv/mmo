package ro.mixai.tv.ui.music

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.data.generated.AlbumDetail
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.LocalBackdrop
import ro.mixai.tv.ui.components.MetaChip
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.components.SkeletonBlock
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.RestoreFocusOnReturn
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.nav.rememberRestorableFocus
import ro.mixai.tv.ui.nav.sharedPoster
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

private val COVER = 380.dp

/**
 * Album page: large cover (shared element with the album tiles), title, artist (→ artist page),
 * year / genre / duration chips, Play · Shuffle · Add to queue and the track list. Selecting a
 * track plays the album from it and opens Now Playing.
 */
@Composable
fun MusicAlbumScreen(deps: ScreenDeps, nav: Navigator, albumId: String) {
    var state by remember(albumId) { mutableStateOf<Load<AlbumDetail>>(Load.Loading) }
    var retry by remember { mutableIntStateOf(0) }
    val errText = stringResource(R.string.music_load_error)
    LaunchedEffect(albumId, retry) {
        state = Load.Loading
        state = try {
            Load.Ok(deps.music.album(albumId))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Load.Err(e.message ?: errText)
        }
    }
    val backdrop = LocalBackdrop.current
    LaunchedEffect(albumId) { backdrop.show(deps.music.coverUrl(albumId, 64)) }

    Row(
        Modifier.fillMaxSize().padding(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = MixaiFocus.overscanTop + 12.dp),
        horizontalArrangement = Arrangement.spacedBy(48.dp),
    ) {
        // Cover renders immediately (same URL as the tile → Coil memory hit) so the shared element can fly in.
        Column(Modifier.width(COVER), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            ArtworkOrPlaceholder(
                deps.api.albumCoverUrl(albumId),
                null,
                Modifier.size(COVER).sharedPoster(albumSharedKey(albumId)).clip(MixaiFocus.cardShape),
            )
        }
        Box(Modifier.weight(1f).fillMaxHeight()) {
            when (val s = state) {
                Load.Loading -> Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    SkeletonBlock(Modifier.width(420.dp).size(420.dp, 48.dp), radius = 8.dp)
                    SkeletonBlock(Modifier.size(240.dp, 24.dp), radius = 6.dp)
                    repeat(6) { SkeletonBlock(Modifier.size(640.dp, 52.dp), radius = 10.dp) }
                }
                is Load.Err -> ErrorState(s.message, onRetry = { retry++ })
                is Load.Ok -> AlbumDetailPane(deps, nav, albumId, s.value)
            }
        }
    }
}

@Composable
private fun AlbumDetailPane(deps: ScreenDeps, nav: Navigator, albumId: String, d: AlbumDetail) {
    val rf = rememberRestorableFocus("album-$albumId")
    RestoreFocusOnReturn(rf)
    val playback = deps.musicPlayback
    val ps by playback.state.collectAsState()
    val a = d.album
    var added by remember { mutableStateOf(false) }
    LaunchedEffect(added) { if (added) { delay(2_000); added = false } }

    fun playFrom(i: Int) {
        if (d.tracks.isEmpty()) return
        playback.play(d.tracks, i)
        nav.push(Route.NowPlaying)
    }

    LazyColumn(
        Modifier.fillMaxSize().focusRestorer(rf.requester),
        contentPadding = PaddingValues(bottom = 64.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        item("head") {
            Column(Modifier.padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(a.name, style = MaterialTheme.typography.displaySmall, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val artist = a.artist?.takeIf { it.isNotBlank() } ?: stringResource(R.string.music_unknown_artist)
                val artistId = a.artistId
                if (artistId != null) {
                    PillButton(artist, onClick = { nav.push(Route.Artist(artistId)) }, compact = true, modifier = rf.item("artist"))
                } else {
                    Text(artist, style = MaterialTheme.typography.titleMedium, color = Tokens.mutedForeground)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    a.year?.takeIf { it > 0 }?.let { MetaChip(it.toString()) }
                    a.genre?.takeIf { it.isNotBlank() }?.let { MetaChip(it) }
                    MetaChip(pluralStringResource(R.plurals.music_songs_count, d.tracks.size, d.tracks.size))
                    if (a.durationSec > 0) MetaChip(formatDuration(a.durationSec))
                }
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    PrimaryButton(
                        stringResource(R.string.music_play),
                        onClick = { playback.setShuffle(false); playFrom(0) },
                        icon = Icons.Filled.PlayArrow,
                        enabled = d.tracks.isNotEmpty(),
                        modifier = Modifier.focusRequester(rf.requester).then(rf.item("play")),
                    )
                    SecondaryButton(
                        stringResource(R.string.music_shuffle),
                        onClick = {
                            if (d.tracks.isNotEmpty()) {
                                playback.play(d.tracks.shuffled(), 0)
                                nav.push(Route.NowPlaying)
                            }
                        },
                        icon = MixaiIcons.Shuffle,
                        enabled = d.tracks.isNotEmpty(),
                        modifier = rf.item("shuffle"),
                    )
                    SecondaryButton(
                        stringResource(R.string.music_add_queue),
                        onClick = { playback.enqueue(d.tracks); added = true },
                        icon = Icons.Filled.Add,
                        enabled = d.tracks.isNotEmpty(),
                        modifier = rf.item("queue"),
                    )
                    if (added) Text(stringResource(R.string.music_added_queue), style = MaterialTheme.typography.bodyMedium, color = Tokens.success)
                }
            }
        }
        val multiDisc = d.tracks.mapNotNull { it.disc }.distinct().size > 1
        itemsIndexed(d.tracks, key = { _, t -> t.id }) { i, t ->
            val num = (t.track?.toString() ?: "${i + 1}").let { if (multiDisc && t.disc != null) "${t.disc}.$it" else it }
            TrackListItem(
                number = num,
                title = t.title,
                subtitle = t.artist?.takeIf { it != a.artist },
                duration = formatDuration(t.durationSec),
                hasLyrics = t.hasLyrics,
                active = ps.track?.id == t.id,
                onClick = { playFrom(i) },
                modifier = rf.item("t:${t.id}"),
            )
        }
    }
}
