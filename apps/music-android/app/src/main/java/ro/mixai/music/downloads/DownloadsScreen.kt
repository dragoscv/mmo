package ro.mixai.music.downloads

import androidx.annotation.OptIn
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.media3.common.util.UnstableApi
import ro.mixai.mobile.ui.EmptyState
import ro.mixai.music.MusicGraph
import ro.mixai.music.R
import ro.mixai.music.ui.TrackRow
import ro.mixai.music.ui.rememberNotificationPermissionRequester

/** Formats bytes as "1.2 GB" / "340 MB". */
internal fun formatBytes(b: Long): String = when {
    b >= 1L shl 30 -> "%.1f GB".format(b / (1L shl 30).toDouble())
    b >= 1L shl 20 -> "%d MB".format(b / (1L shl 20))
    else -> "%d KB".format((b / 1024).coerceAtLeast(if (b > 0) 1 else 0))
}

/** Downloaded tracks: play all offline, remove one, remove all; used space vs limit. */
@OptIn(UnstableApi::class)
@Composable
fun DownloadsScreen(graph: MusicGraph, capGb: Int) {
    val items by MusicDownloads.items.collectAsState()
    val states by MusicDownloads.states.collectAsState()
    val askNotif = rememberNotificationPermissionRequester()
    var confirmClear by remember { mutableStateOf(false) }
    val done = items.filter { it.offline == ro.mixai.music.ui.OfflineState.Done }.map { it.track }

    Column(Modifier.fillMaxSize()) {
        Text(
            stringResource(R.string.downloads_title), style = MaterialTheme.typography.headlineLarge,
            modifier = Modifier.statusBarsPadding().padding(start = 20.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
        )
        val used = formatBytes(MusicDownloads.usedBytes())
        Text(
            if (capGb > 0) stringResource(R.string.downloads_usage_cap, used, capGb) else stringResource(R.string.downloads_usage, used),
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        if (items.isEmpty()) {
            EmptyState(Icons.Outlined.DownloadForOffline, stringResource(R.string.downloads_empty), stringResource(R.string.downloads_empty_hint))
            return@Column
        }
        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(enabled = done.isNotEmpty(), onClick = { askNotif(); graph.musicPlayback.play(done, 0) }) { Text(stringResource(R.string.downloads_play_all)) }
            FilledTonalButton(onClick = { confirmClear = true }) { Text(stringResource(R.string.downloads_remove_all)) }
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            itemsIndexed(items, key = { _, d -> d.track.id }) { _, d ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TrackRow(
                        d.track,
                        onClick = { val i = done.indexOfFirst { it.id == d.track.id }; if (i >= 0) { askNotif(); graph.musicPlayback.play(done, i) } },
                        modifier = Modifier.weight(1f),
                        cover = graph.music.coverUrl(d.track),
                        offline = states[d.track.id],
                    )
                    IconButton(onClick = { MusicDownloads.remove(listOf(d.track.id)) }) {
                        Icon(Icons.Outlined.DeleteOutline, contentDescription = stringResource(R.string.downloads_remove))
                    }
                }
            }
        }
    }
    if (confirmClear) AlertDialog(
        onDismissRequest = { confirmClear = false },
        title = { Text(stringResource(R.string.downloads_remove_all)) },
        text = { Text(stringResource(R.string.downloads_remove_all_confirm)) },
        confirmButton = { TextButton(onClick = { MusicDownloads.removeAll(); confirmClear = false }) { Text(stringResource(R.string.downloads_remove_all)) } },
        dismissButton = { TextButton(onClick = { confirmClear = false }) { Text(stringResource(ro.mixai.mobile.R.string.common_action_cancel)) } },
    )
}
