package ro.mixai.tv.ui

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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.Card
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import ro.mixai.tv.R
import ro.mixai.tv.data.Album
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Progress
import ro.mixai.tv.data.Show
import ro.mixai.tv.data.VideoFile
import ro.mixai.tv.data.episodeCode
import ro.mixai.tv.ui.theme.Tokens
import ro.mixai.tv.ui.theme.mixaiCardBorder
import ro.mixai.tv.ui.theme.mixaiCardColors
import ro.mixai.tv.ui.theme.mixaiCardScale

private data class HomeData(
    val movies: List<VideoFile>,
    val shows: List<Show>,
    val albums: List<Album>,
    val all: Map<String, VideoFile>,
    val videoError: String?,
    val albumError: String?,
)

private val STILL_W = 320.dp
private val STILL_H = 180.dp

@Composable
fun HomeScreen(
    api: MmoApi,
    progress: Map<String, Progress>,
    userName: String? = null,
    onMovie: (VideoFile) -> Unit,
    onShow: (Show) -> Unit,
    onAlbum: (Album) -> Unit,
    onSettings: () -> Unit,
) {
    var data by remember { mutableStateOf<HomeData?>(null) }
    val firstFocus = remember { FocusRequester() }

    LaunchedEffect(api) {
        var files: List<VideoFile> = emptyList(); var albums: List<Album> = emptyList()
        var ve: String? = null; var ae: String? = null
        try { albums = api.newestAlbums() } catch (e: Exception) { ae = e.message }
        try { files = api.scanAll() } catch (e: Exception) { ve = e.message }
        val movies = files.filter { it.parsed.season == null }.sortedBy { it.title.lowercase() }
        data = HomeData(movies, Show.group(files), albums, files.associateBy { it.fileId }, ve, ae)
    }

    val d = data
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 40.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 56.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.home_title), style = MaterialTheme.typography.headlineLarge, color = Tokens.foreground)
            Spacer(Modifier.width(24.dp))
            Text(api.baseUrl.removePrefix("http://"), color = Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.weight(1f))
            if (userName != null) {
                Text("👤 $userName", color = Tokens.foreground, style = MaterialTheme.typography.bodyLarge)
                Spacer(Modifier.width(20.dp))
            }
            OutlinedButton(onClick = onSettings) { Text("⚙  " + stringResource(R.string.home_settings)) }
        }
        Spacer(Modifier.height(32.dp))

        if (d == null) {
            RowHeader(stringResource(R.string.home_movies), null, null)
            SkeletonRow(count = 5, width = STILL_W, height = STILL_H)
            Spacer(Modifier.height(36.dp))
            RowHeader(stringResource(R.string.home_shows), null, null)
            SkeletonRow(count = 5, width = STILL_W, height = STILL_H)
            Spacer(Modifier.height(36.dp))
            RowHeader(stringResource(R.string.home_albums), null, null)
            SkeletonRow(count = 6, width = 220.dp, height = 220.dp)
            return@Column
        }

        // Continue watching: files with saved progress, most recent first.
        val continueList = remember(d, progress) {
            progress.entries.sortedByDescending { it.value.at }.mapNotNull { (id, p) -> d.all[id]?.let { it to p } }
        }
        val firstId = continueList.firstOrNull()?.first?.fileId ?: d.movies.firstOrNull()?.fileId
            ?: d.shows.firstOrNull()?.key ?: d.albums.firstOrNull()?.id
        LaunchedEffect(firstId) { if (firstId != null) runCatching { firstFocus.requestFocus() } }

        if (continueList.isNotEmpty()) {
            RowHeader(stringResource(R.string.home_continue), continueList.size, null)
            LazyRow(contentPadding = PaddingValues(horizontal = 56.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                items(continueList, key = { "cw-" + it.first.fileId }) { (f, p) ->
                    val mod = if (f.fileId == firstId) Modifier.focusRequester(firstFocus) else Modifier
                    val code = f.episodeCode()
                    StillCard(
                        title = if (code.isBlank()) f.title else "${f.parsed.title.trim()} · $code",
                        subtitle = remainingLabel(p),
                        imageUrl = api.spriteUrl(f.fileId), progress = p.fraction, modifier = mod,
                        onClick = { onMovie(f) },
                    )
                }
            }
            Spacer(Modifier.height(36.dp))
        }

        RowHeader(stringResource(R.string.home_movies), d.movies.size, d.videoError)
        when {
            d.videoError != null -> EmptyState("⚠", stringResource(R.string.home_load_failed), d.videoError, tone = EmptyTone.Error)
            d.movies.isEmpty() -> EmptyState("🎬", stringResource(R.string.home_movies_empty), stringResource(R.string.home_movies_empty_hint))
            else -> LazyRow(contentPadding = PaddingValues(horizontal = 56.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                items(d.movies, key = { it.fileId }) { f ->
                    val mod = if (continueList.isEmpty() && f.fileId == firstId) Modifier.focusRequester(firstFocus) else Modifier
                    StillCard(
                        title = f.title,
                        subtitle = listOfNotNull(f.parsed.year?.toString(), f.height?.let { "${it}p" }).joinToString(" · "),
                        imageUrl = api.spriteUrl(f.fileId), progress = progress[f.fileId]?.fraction, modifier = mod,
                        onClick = { onMovie(f) },
                    )
                }
            }
        }

        Spacer(Modifier.height(36.dp))
        RowHeader(stringResource(R.string.home_shows), d.shows.size, d.videoError)
        when {
            d.videoError != null -> {}
            d.shows.isEmpty() -> EmptyState("📺", stringResource(R.string.home_shows_empty), stringResource(R.string.home_shows_empty_hint))
            else -> LazyRow(contentPadding = PaddingValues(horizontal = 56.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                items(d.shows, key = { it.key }) { s ->
                    val mod = if (continueList.isEmpty() && d.movies.isEmpty() && s.key == firstId) Modifier.focusRequester(firstFocus) else Modifier
                    val inProgress = s.episodes.mapNotNull { progress[it.fileId] }.maxByOrNull { it.at }
                    StillCard(
                        title = s.title,
                        subtitle = stringResource(R.string.home_episodes, s.episodes.size) + " · " + stringResource(R.string.home_seasons, s.seasons),
                        imageUrl = api.spriteUrl(s.episodes.first().fileId), progress = inProgress?.fraction, modifier = mod,
                        onClick = { onShow(s) },
                    )
                }
            }
        }

        Spacer(Modifier.height(36.dp))
        RowHeader(stringResource(R.string.home_albums), d.albums.size, d.albumError)
        when {
            d.albumError != null -> EmptyState("⚠", stringResource(R.string.home_load_failed), d.albumError, tone = EmptyTone.Error)
            d.albums.isEmpty() -> EmptyState("💿", stringResource(R.string.home_albums_empty), stringResource(R.string.home_albums_empty_hint))
            else -> LazyRow(contentPadding = PaddingValues(horizontal = 56.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                items(d.albums, key = { it.id }) { a ->
                    val mod = if (continueList.isEmpty() && d.movies.isEmpty() && d.shows.isEmpty() && a.id == firstId) Modifier.focusRequester(firstFocus) else Modifier
                    PosterCard(title = a.name, subtitle = a.artist ?: "", imageUrl = api.coverArtUrl(a.coverArt ?: a.id),
                        width = 220.dp, height = 220.dp, modifier = mod, onClick = { onAlbum(a) })
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun remainingLabel(p: Progress): String {
    val left = ((p.dur - p.pos) / 1000).coerceAtLeast(0)
    return "%d:%02d".format(left / 60, left % 60)
}

@Composable
private fun RowHeader(title: String, count: Int?, error: String?) {
    Row(Modifier.padding(horizontal = 56.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleLarge, color = Tokens.foreground)
        Spacer(Modifier.width(12.dp))
        if (count != null || error != null) Text(
            when {
                error != null -> stringResource(R.string.common_row_error, error)
                count == 0 -> stringResource(R.string.common_nothing_yet)
                else -> "$count"
            },
            color = if (error != null) Tokens.destructive else Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium,
        )
    }
}

/** Thin resume bar under a card image (6 dp; track = muted, fill = brand cyan). */
@Composable
fun ProgressBar(fraction: Float, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(6.dp).background(Tokens.muted)) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(fraction.coerceIn(0f, 1f)).background(Tokens.brandCyanDark))
    }
}

/** 16:9 card with a `SpriteStill` (scrubber-sprite tile) as artwork; title placeholder on error. */
@Composable
fun StillCard(
    title: String, subtitle: String, imageUrl: String, progress: Float?,
    modifier: Modifier = Modifier, onClick: () -> Unit,
) {
    Column(modifier.width(STILL_W)) {
        Card(
            onClick = onClick, modifier = Modifier.size(STILL_W, STILL_H),
            colors = mixaiCardColors(), border = mixaiCardBorder(), scale = mixaiCardScale(),
        ) {
            Box(Modifier.fillMaxSize()) {
                SpriteStill(url = imageUrl, title = title, modifier = Modifier.fillMaxSize())
                if (progress != null && progress > 0f) ProgressBar(progress, Modifier.align(Alignment.BottomCenter))
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(title, color = Tokens.foreground, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (subtitle.isNotBlank()) Text(subtitle, color = Tokens.mutedForeground, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun PosterCard(
    title: String, subtitle: String, imageUrl: String?,
    width: Dp, height: Dp,
    modifier: Modifier = Modifier, onClick: () -> Unit,
) {
    Column(modifier.width(width)) {
        Card(
            onClick = onClick, modifier = Modifier.size(width, height),
            colors = mixaiCardColors(), border = mixaiCardBorder(), scale = mixaiCardScale(),
        ) {
            Box(Modifier.fillMaxSize()) {
                if (imageUrl != null) {
                    AsyncImage(model = imageUrl, contentDescription = title, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                } else {
                    Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.BottomStart) {
                        Text(title, color = Tokens.foreground, style = MaterialTheme.typography.titleMedium, maxLines = 4, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(title, color = Tokens.foreground, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (subtitle.isNotBlank()) Text(subtitle, color = Tokens.mutedForeground, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
