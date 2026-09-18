package ro.mixai.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Progress
import ro.mixai.tv.data.Show
import ro.mixai.tv.data.VideoFile
import ro.mixai.tv.data.episodeCode
import ro.mixai.tv.player.PlayRequest
import ro.mixai.tv.ui.theme.Tokens

/** One series: episodes sorted by season/episode with resume progress; click plays. */
@Composable
fun ShowScreen(api: MmoApi, show: Show, progress: Map<String, Progress>, onPlay: (PlayRequest) -> Unit, onBack: () -> Unit) {
    val firstFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(50); runCatching { firstFocus.requestFocus() } }

    // Resume on the most recently watched episode, else the first one.
    val resumeIndex = remember(show, progress) {
        show.episodes.withIndex().filter { progress[it.value.fileId] != null }
            .maxByOrNull { progress[it.value.fileId]!!.at }?.index ?: 0
    }

    Row(Modifier.fillMaxSize().padding(56.dp), horizontalArrangement = Arrangement.spacedBy(40.dp)) {
        Column(Modifier.width(400.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            SpriteStill(url = api.spriteUrl(show.episodes.first().fileId), title = show.title, modifier = Modifier.size(400.dp, 225.dp).clip(RoundedCornerShape(12.dp)))
            Text(show.title, style = MaterialTheme.typography.headlineSmall, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                stringResource(R.string.show_episodes, show.episodes.size) + " · " + stringResource(R.string.home_seasons, show.seasons),
                color = Tokens.mutedForeground,
            )
            OutlinedButton(onClick = onBack) { Text(stringResource(R.string.action_back)) }
        }
        Column(Modifier.fillMaxSize()) {
            if (show.episodes.isEmpty()) {
                EmptyState("📺", stringResource(R.string.show_empty))
            } else LazyColumn(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                itemsIndexed(show.episodes, key = { _, e -> e.fileId }) { i, e ->
                    val p = progress[e.fileId]
                    EpisodeRow(
                        e, p,
                        modifier = if (i == resumeIndex) Modifier.focusRequester(firstFocus) else Modifier,
                        onClick = { onPlay(PlayRequest.Video(e, hls = !e.directPlayable)) },
                    )
                }
            }
        }
    }
}

@Composable
private fun EpisodeRow(e: VideoFile, p: Progress?, modifier: Modifier, onClick: () -> Unit) {
    val code = e.episodeCode()
    val dur = e.durationSec?.let { clock((it * 1000).toLong()) } ?: ""
    val title = e.path.substringAfterLast('/').substringAfterLast('\\').substringBeforeLast('.')
        .let { if (it.isBlank()) stringResource(R.string.show_episode_fallback, e.parsed.episode ?: 0) else it }
    ListItem(
        selected = false,
        onClick = onClick,
        modifier = modifier,
        headlineContent = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Column {
                Text(
                    listOfNotNull(e.height?.let { "${it}p" }, e.videoCodec?.uppercase()).joinToString(" · "),
                    maxLines = 1, overflow = TextOverflow.Ellipsis, color = Tokens.mutedForeground,
                )
                if (p != null && p.fraction > 0f) { Spacer(Modifier.height(6.dp)); Box(Modifier.width(240.dp)) { ProgressBar(p.fraction) } }
            }
        },
        leadingContent = { Text(code.ifBlank { "—" }, color = Tokens.brandCyanDark, style = MaterialTheme.typography.titleMedium) },
        trailingContent = { Text(if (p != null) "${clock(p.pos)} / $dur" else dur, color = Tokens.mutedForeground) },
    )
}
