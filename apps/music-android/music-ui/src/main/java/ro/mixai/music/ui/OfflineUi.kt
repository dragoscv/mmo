package ro.mixai.music.ui

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudDone
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import android.widget.Toast
import ro.mixai.tv.data.generated.TrackCard

/** Aggregate offline state of a list: all done, some in progress, none. */
internal enum class ListOffline { None, Partial, Busy, Done }

internal fun listOffline(ids: List<String>, states: Map<String, OfflineState>): ListOffline {
    if (ids.isEmpty()) return ListOffline.None
    val s = ids.map { states[it] }
    return when {
        s.all { it == OfflineState.Done } -> ListOffline.Done
        s.any { it == OfflineState.Queued || it == OfflineState.Downloading } -> ListOffline.Busy
        s.any { it != null } -> ListOffline.Partial
        else -> ListOffline.None
    }
}

/** Download / remove a whole album or playlist. Hidden when the host has no downloads. */
@Composable
fun DownloadListButton(deps: MusicDeps, tracks: List<TrackCard>) {
    val offline = deps.offline ?: return
    val states by offline.states.collectAsState()
    val context = LocalContext.current
    val full = stringResource(R.string.music_download_full)
    when (listOffline(tracks.map { it.id }, states)) {
        ListOffline.Done -> IconButton(onClick = { offline.remove(tracks.map { it.id }) }) {
            Icon(Icons.Outlined.CloudDone, contentDescription = stringResource(R.string.music_download_remove), tint = MaterialTheme.colorScheme.primary)
        }
        ListOffline.Busy -> IconButton(onClick = { offline.remove(tracks.map { it.id }) }) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        }
        ListOffline.None, ListOffline.Partial -> IconButton(
            enabled = tracks.isNotEmpty(),
            onClick = { if (!offline.download(tracks)) Toast.makeText(context, full, Toast.LENGTH_LONG).show() },
        ) {
            Icon(Icons.Outlined.Download, contentDescription = stringResource(R.string.music_download))
        }
    }
}

/** Small per-track badge (downloaded / downloading / failed); nothing when not downloaded. */
@Composable
internal fun OfflineBadge(state: OfflineState?) {
    when (state) {
        OfflineState.Done -> Icon(
            Icons.Outlined.DownloadForOffline, contentDescription = stringResource(R.string.music_downloaded),
            tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp),
        )
        OfflineState.Queued, OfflineState.Downloading, OfflineState.Waiting -> CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
        OfflineState.Failed -> Icon(
            Icons.Outlined.ErrorOutline, contentDescription = stringResource(R.string.music_download_failed),
            tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp),
        )
        null -> Unit
    }
}
