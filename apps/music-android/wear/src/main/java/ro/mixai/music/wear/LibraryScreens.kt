package ro.mixai.music.wear

import android.app.RemoteInput
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cast
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.DownloadDone
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material.icons.outlined.LibraryMusic
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.QueueMusic
import androidx.compose.material.icons.outlined.Shuffle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.media3.common.util.UnstableApi
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import ro.mixai.tv.data.generated.TrackCard

/** One list destination: what to load and how to label it. */
sealed interface ListSource {
    data class Album(val id: String, val title: String) : ListSource
    data class Playlist(val id: String, val title: String) : ListSource
    data class Search(val query: String) : ListSource
    data object Downloads : ListSource
}

@Composable
private fun RowButton(icon: ImageVector, label: String, secondary: String? = null, primary: Boolean = false, onClick: () -> Unit) {
    val iconContent: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit = { Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp)) }
    if (primary) {
        Button(onClick = onClick, modifier = Modifier.fillMaxWidth(), icon = iconContent, label = { Text(label, maxLines = 2) },
            secondaryLabel = secondary?.let { { Text(it, maxLines = 1) } })
    } else {
        FilledTonalButton(onClick = onClick, modifier = Modifier.fillMaxWidth(), icon = iconContent, label = { Text(label, maxLines = 2) },
            secondaryLabel = secondary?.let { { Text(it, maxLines = 1) } })
    }
}

/** Home: mix, voice search, downloads, recent albums, playlists, profile. */
@Composable
fun HomeScreen(
    graph: WearGraph,
    profileName: String?,
    nowPlaying: TrackCard?,
    onNowPlaying: () -> Unit,
    onOpen: (ListSource) -> Unit,
    onProfiles: () -> Unit,
    onDisconnect: () -> Unit,
    phoneOutput: ro.mixai.tv.data.WearHandoff.Output? = null,
    onPhoneLocal: () -> Unit = {},
) {
    val state = rememberTransformingLazyColumnState()
    var home by remember { mutableStateOf<ro.mixai.tv.data.generated.MusicHome?>(null) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(graph) {
        failed = false
        home = runCatching { graph.music.home() }.onFailure { failed = true }.getOrNull()
    }
    val voice = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val q = r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            ?: r.data?.let { RemoteInput.getResultsFromIntent(it)?.getCharSequence("q")?.toString() }
        if (!q.isNullOrBlank()) onOpen(ListSource.Search(q.trim()))
    }
    val context = LocalContext.current
    ScreenScaffold(scrollState = state) { padding ->
        TransformingLazyColumn(state = state, contentPadding = padding) {
            item { ListHeader { Text(stringResource(R.string.app_name)) } }
            if (phoneOutput?.isRemote == true) {
                item {
                    RowButton(Icons.Outlined.Cast, stringResource(R.string.output_phone_on, phoneOutput.name), stringResource(R.string.output_back_to_phone), onClick = onPhoneLocal)
                }
            }
            if (nowPlaying != null) {
                item { RowButton(Icons.Outlined.PlayArrow, nowPlaying.title, nowPlaying.artist, primary = true, onClick = onNowPlaying) }
            }
            item {
                RowButton(Icons.Outlined.Shuffle, stringResource(R.string.home_mix), primary = nowPlaying == null) {
                    graph.playback.playFromSearch("")
                    onNowPlaying()
                }
            }
            item {
                RowButton(Icons.Outlined.Mic, stringResource(R.string.home_search)) {
                    val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        .putExtra(RecognizerIntent.EXTRA_PROMPT, context.getString(R.string.home_search_prompt))
                    runCatching { voice.launch(i) }
                }
            }
            item { RowButton(Icons.Outlined.DownloadForOffline, stringResource(R.string.home_downloads)) { onOpen(ListSource.Downloads) } }
            val h = home
            when {
                h == null && !failed -> item { CircularProgressIndicator() }
                h == null -> item { Text(stringResource(R.string.state_offline), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
                else -> {
                    if (h.recent.isNotEmpty()) {
                        item { ListHeader { Text(stringResource(R.string.home_recent)) } }
                        h.recent.distinctBy { it.id }.take(8).forEach { a ->
                            item(key = "a" + a.id) { RowButton(Icons.Outlined.LibraryMusic, a.name, a.artist) { onOpen(ListSource.Album(a.id, a.name)) } }
                        }
                    }
                    if (h.playlists.isNotEmpty()) {
                        item { ListHeader { Text(stringResource(R.string.home_playlists)) } }
                        h.playlists.distinctBy { it.id }.forEach { p ->
                            item(key = "p" + p.id) {
                                RowButton(Icons.Outlined.QueueMusic, p.name, stringResource(R.string.tracks_count, p.songCount.toInt())) { onOpen(ListSource.Playlist(p.id, p.name)) }
                            }
                        }
                    }
                }
            }
            item { RowButton(Icons.Outlined.Person, profileName ?: stringResource(R.string.profiles_title), stringResource(R.string.profiles_switch), onClick = onProfiles) }
            item {
                FilledTonalButton(onClick = onDisconnect, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.disconnect)) })
            }
        }
    }
}

/** Tracks of an album / playlist / search / downloads: play all, download all, play from a row. */
@OptIn(UnstableApi::class)
@Composable
fun TrackListScreen(graph: WearGraph, source: ListSource, onPlaying: () -> Unit) {
    val state = rememberTransformingLazyColumnState()
    val downloads = WearMusicApp.downloads
    val items by downloads.items.collectAsState()
    var tracks by remember(source) { mutableStateOf<List<TrackCard>?>(null) }
    var failed by remember(source) { mutableStateOf(false) }
    var full by remember { mutableStateOf(false) }
    LaunchedEffect(source, items.size) {
        if (source is ListSource.Downloads) { tracks = downloads.completedTracks(); return@LaunchedEffect }
        if (tracks != null) return@LaunchedEffect
        tracks = runCatching {
            when (source) {
                is ListSource.Album -> graph.music.album(source.id).tracks
                is ListSource.Playlist -> graph.music.playlistTracks(source.id)
                is ListSource.Search -> graph.music.search(source.query).tracks
                ListSource.Downloads -> downloads.completedTracks()
            }.distinctBy { it.id }
        }.onFailure { failed = true }.getOrNull()
    }
    val title = when (source) {
        is ListSource.Album -> source.title
        is ListSource.Playlist -> source.title
        is ListSource.Search -> "“${source.query}”"
        ListSource.Downloads -> stringResource(R.string.home_downloads)
    }
    val stateById = items.associateBy { it.track.id }
    ScreenScaffold(scrollState = state) { padding ->
        TransformingLazyColumn(state = state, contentPadding = padding) {
            item { ListHeader { Text(title, maxLines = 2, textAlign = TextAlign.Center) } }
            val list = tracks
            when {
                list == null && !failed -> item { CircularProgressIndicator() }
                list == null -> item { Text(stringResource(R.string.state_offline), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
                list.isEmpty() -> item {
                    Text(
                        stringResource(if (source is ListSource.Downloads) R.string.downloads_empty else R.string.state_empty),
                        style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
                    )
                }
                else -> {
                    item { RowButton(Icons.Outlined.PlayArrow, stringResource(R.string.play_all), primary = true) { graph.playback.play(list, 0); onPlaying() } }
                    if (source is ListSource.Downloads) {
                        item {
                            RowButton(Icons.Outlined.DeleteOutline, stringResource(R.string.downloads_remove_all), formatBytes(downloads.usedBytes())) { downloads.removeAll() }
                        }
                    } else {
                        val allDone = list.all { stateById[it.id]?.done == true }
                        item {
                            RowButton(
                                if (allDone) Icons.Outlined.DownloadDone else Icons.Outlined.CloudDownload,
                                stringResource(if (allDone) R.string.downloaded else if (full) R.string.download_full else R.string.download_all),
                            ) { if (!allDone) full = !downloads.download(list) }
                        }
                    }
                    list.forEachIndexed { i, t ->
                        item(key = t.id) {
                            val d = stateById[t.id]
                            val badge = when {
                                d == null -> null
                                d.done -> stringResource(R.string.downloaded)
                                else -> stringResource(R.string.downloading, d.percent.toInt())
                            }
                            FilledTonalButton(
                                onClick = { graph.playback.play(list, i); onPlaying() },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(t.title, maxLines = 2) },
                                secondaryLabel = { Text(listOfNotNull(t.artist, badge).joinToString(" · "), maxLines = 1) },
                            )
                        }
                    }
                }
            }
        }
    }
}

internal fun formatBytes(b: Long): String = when {
    b >= 1L shl 30 -> "%.1f GB".format(b / (1L shl 30).toDouble())
    b >= 1L shl 20 -> "%d MB".format(b / (1L shl 20))
    else -> "%d KB".format((b / 1024).coerceAtLeast(if (b > 0) 1 else 0))
}
