package ro.mixai.music.wear

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.FilledIconButton
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.IconButton
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import kotlinx.coroutines.launch
import ro.mixai.tv.data.MusicPlayback
import ro.mixai.tv.data.ProfileRepository
import ro.mixai.tv.data.UnlockResult

/** Now playing: progress ring, title / artist, previous / play-pause / next. Volume via the crown (system). */
@Composable
fun NowPlayingScreen(playback: MusicPlayback) {
    val s by playback.state.collectAsState()
    val t = s.track
    ScreenScaffold {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            val progress = if (s.durationMs > 0) (s.positionMs.toFloat() / s.durationMs).coerceIn(0f, 1f) else 0f
            CircularProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxSize().padding(2.dp), strokeWidth = 4.dp)
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(horizontal = 26.dp)) {
                Text(
                    t?.title ?: stringResource(R.string.nothing_playing), style = MaterialTheme.typography.titleMedium,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
                )
                if (t?.artist != null) {
                    Text(t.artist!!, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { playback.prev() }, enabled = t != null) {
                        Icon(Icons.Filled.SkipPrevious, contentDescription = stringResource(R.string.action_previous))
                    }
                    FilledIconButton(onClick = { playback.toggle() }, enabled = t != null, modifier = Modifier.size(56.dp)) {
                        Icon(if (s.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                            contentDescription = stringResource(if (s.playing) R.string.action_pause else R.string.action_play), modifier = Modifier.size(30.dp))
                    }
                    IconButton(onClick = { playback.next() }, enabled = t != null) {
                        Icon(Icons.Filled.SkipNext, contentDescription = stringResource(R.string.action_next))
                    }
                }
            }
        }
    }
}

/** Profile picker; profiles with a PIN are entered on the phone/web (no PIN pad on the watch in v1). */
@Composable
fun ProfilesScreen(profiles: ProfileRepository, onSelected: () -> Unit) {
    val state = rememberTransformingLazyColumnState()
    val list by profiles.profiles.collectAsState()
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { profiles.refresh() } }
    val pinNeeded = stringResource(R.string.profiles_pin_on_phone)
    ScreenScaffold(scrollState = state) { padding ->
        TransformingLazyColumn(state = state, contentPadding = padding) {
            item { ListHeader { Text(stringResource(R.string.profiles_title)) } }
            if (list.isEmpty()) item { CircularProgressIndicator() }
            list.forEach { p ->
                item(key = p.id) {
                    FilledTonalButton(
                        onClick = {
                            scope.launch {
                                if (!p.hasPin) { profiles.select(p); onSelected(); return@launch }
                                when (profiles.unlock(p, null)) {
                                    is UnlockResult.Ok -> onSelected()
                                    else -> message = pinNeeded
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        icon = if (p.hasPin) { { Icon(Icons.Outlined.Lock, contentDescription = null) } } else null,
                        label = { Text(p.name, maxLines = 1) },
                    )
                }
            }
            message?.let { m -> item { Text(m, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) } }
        }
    }
}
