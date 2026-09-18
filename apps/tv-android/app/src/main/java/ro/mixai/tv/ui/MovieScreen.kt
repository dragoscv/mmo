package ro.mixai.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Progress
import ro.mixai.tv.data.VideoFile
import ro.mixai.tv.data.episodeCode
import ro.mixai.tv.player.PlayRequest
import ro.mixai.tv.ui.theme.Tokens

@Composable
fun MovieScreen(api: MmoApi, file: VideoFile, progress: Progress?, onPlay: (PlayRequest) -> Unit, onBack: () -> Unit) {
    val playFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(50); runCatching { playFocus.requestFocus() } }

    val dur = file.durationSec?.let { s -> stringResource(R.string.movie_duration, (s / 3600).toInt(), ((s % 3600) / 60).toInt()) }
    val tech = listOfNotNull(
        file.width?.let { w -> file.height?.let { h -> "${w}×$h" } },
        file.videoCodec?.uppercase(), file.audioCodec?.uppercase(),
        file.hdr?.takeIf { it != "sdr" }?.uppercase(), file.container?.split(",")?.first()?.uppercase(),
    ).joinToString(" · ")
    val code = file.episodeCode()
    val resumeAt = progress?.takeIf { it.pos > 0 }

    Row(Modifier.fillMaxSize().padding(horizontal = 64.dp, vertical = 56.dp), horizontalArrangement = Arrangement.spacedBy(48.dp)) {
        Column(Modifier.width(480.dp)) {
            SpriteStill(url = api.spriteUrl(file.fileId), title = file.title, modifier = Modifier.size(480.dp, 270.dp).clip(RoundedCornerShape(12.dp)))
            if (resumeAt != null) { Spacer(Modifier.height(8.dp)); ProgressBar(resumeAt.fraction) }
        }
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(if (code.isBlank()) file.title else "${file.parsed.title.trim()} · $code", style = MaterialTheme.typography.displaySmall, color = Tokens.foreground)
            Text(listOfNotNull(file.parsed.year?.toString(), dur).joinToString(" · "), color = Tokens.mutedForeground, style = MaterialTheme.typography.titleMedium)
            Text(tech, color = Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium)
            if (file.subtitleTracks.isNotEmpty()) Text(
                stringResource(R.string.movie_subtitles, file.subtitleTracks.joinToString { it.lang ?: it.title ?: "#${it.index}" }),
                color = Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(24.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                if (resumeAt != null) {
                    Button(onClick = { onPlay(PlayRequest.Video(file, hls = !file.directPlayable)) }, modifier = Modifier.focusRequester(playFocus)) {
                        Text(stringResource(R.string.movie_resume, clock(resumeAt.pos)))
                    }
                    OutlinedButton(onClick = { onPlay(PlayRequest.Video(file, hls = !file.directPlayable, fromStart = true)) }) {
                        Text(stringResource(R.string.movie_start_over))
                    }
                } else {
                    Button(onClick = { onPlay(PlayRequest.Video(file, hls = !file.directPlayable)) }, modifier = Modifier.focusRequester(playFocus)) {
                        Text(stringResource(if (file.directPlayable) R.string.movie_play_direct else R.string.movie_play_transcode))
                    }
                }
                if (file.directPlayable) OutlinedButton(onClick = { onPlay(PlayRequest.Video(file, hls = true)) }) { Text(stringResource(R.string.movie_play_hls)) }
                OutlinedButton(onClick = onBack) { Text(stringResource(R.string.action_back)) }
            }
            Spacer(Modifier.height(24.dp))
            Text(file.path, color = Tokens.mutedForeground, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** `h:mm:ss` / `m:ss` for a millisecond position. */
fun clock(ms: Long): String {
    val s = ms / 1000
    val h = s / 3600; val m = (s % 3600) / 60; val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}
