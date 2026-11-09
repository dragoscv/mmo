package ro.mixai.keybpm.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import ro.mixai.keybpm.ListenUi
import ro.mixai.keybpm.R
import ro.mixai.keybpm.SongIdUi
import ro.mixai.keybpm.songid.SongLinks
import ro.mixai.mobile.theme.Mixai

/** Song ID (WP18-06): Identify button, tracklist-mode switch, result with library badge + links. */
@Composable
fun SongIdCard(ui: ListenUi, onIdentify: () -> Unit, onTracklist: (Boolean) -> Unit, onAddToQueue: () -> Unit, modifier: Modifier = Modifier) {
    if (!ui.songIdAvailable) return
    val ctx = LocalContext.current
    fun open(url: String) = runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainer, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.songid_title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                val busy = ui.songId is SongIdUi.Collecting || ui.songId is SongIdUi.Matching
                FilledTonalButton(onClick = onIdentify, enabled = !busy) { Text(stringResource(R.string.songid_identify)) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.songid_tracklist), style = MaterialTheme.typography.bodyMedium)
                    Text(stringResource(R.string.songid_tracklist_hint), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted)
                }
                val on = stringResource(R.string.state_on)
                val off = stringResource(R.string.state_off)
                Switch(
                    checked = ui.tracklistMode,
                    onCheckedChange = onTracklist,
                    modifier = Modifier.semantics { stateDescription = if (ui.tracklistMode) on else off },
                )
            }
            Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                when (val s = ui.songId) {
                    SongIdUi.Idle -> if (!ui.listening) Text(stringResource(R.string.songid_need_listen), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted)
                    SongIdUi.Collecting -> Busy(stringResource(R.string.songid_collecting))
                    SongIdUi.Matching -> Busy(stringResource(R.string.songid_matching))
                    SongIdUi.NoMatch -> Text(stringResource(R.string.songid_no_match), color = Mixai.colors.muted)
                    SongIdUi.Offline -> Text(stringResource(R.string.songid_offline), color = Mixai.colors.warning)
                    is SongIdUi.Error -> Text(stringResource(R.string.songid_error, s.reason), color = MaterialTheme.colorScheme.error)
                    is SongIdUi.Found -> Found(s, ui, ::open, onAddToQueue)
                }
                if (ui.pendingIds > 0) {
                    Text(stringResource(R.string.songid_pending, ui.pendingIds), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted)
                }
            }
            Text(stringResource(R.string.songid_privacy), style = MaterialTheme.typography.labelSmall, color = Mixai.colors.muted)
        }
    }
}

@Composable
private fun Busy(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(8.dp))
        Text(text, color = Mixai.colors.muted)
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun Found(s: SongIdUi.Found, ui: ListenUi, open: (String) -> Unit, onAddToQueue: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        s.song.artworkUrl?.let {
            AsyncImage(model = it, contentDescription = null, modifier = Modifier.size(64.dp).clip(RoundedCornerShape(8.dp)))
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(s.song.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            s.song.artist?.let { Text(it, color = Mixai.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            if (s.libraryTrackId != null) {
                Text(stringResource(R.string.songid_in_library), color = Mixai.colors.success, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
    // Detected vs library analysis: shows when the library has a key/BPM for the matched track.
    if (s.libraryCamelot != null || s.libraryBpm != null) {
        val live = listOfNotNull(ui.snapshot?.key?.key?.camelot, ui.bpm?.let { "%.1f".format(it) }).joinToString(" · ")
        val lib = listOfNotNull(s.libraryCamelot, s.libraryBpm?.let { "%.1f".format(it) }).joinToString(" · ")
        Text(stringResource(R.string.songid_compare, live.ifBlank { "—" }, lib), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted)
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        s.song.appleMusicUrl?.let { url -> AssistChip(onClick = { open(url) }, label = { Text(stringResource(R.string.songid_apple_music)) }) }
        AssistChip(onClick = { open(SongLinks.spotify(s.song)) }, label = { Text(stringResource(R.string.songid_spotify)) })
        AssistChip(onClick = { open(SongLinks.youtubeMusic(s.song)) }, label = { Text(stringResource(R.string.songid_youtube_music)) })
        if (s.libraryTrackId != null) {
            AssistChip(
                onClick = onAddToQueue,
                enabled = !s.queued,
                label = { Text(stringResource(if (s.queued) R.string.songid_queued else R.string.songid_add_queue)) },
            )
        }
    }
}
