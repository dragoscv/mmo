package ro.mixai.music.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.RepeatOne
import androidx.compose.material.icons.outlined.Shuffle
import androidx.compose.material.icons.outlined.SkipNext
import androidx.compose.material.icons.outlined.SkipPrevious
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import ro.mixai.music.ui.R
import ro.mixai.tv.data.MusicState
import ro.mixai.tv.data.RepeatMode
import ro.mixai.tv.data.generated.LyricLine
import ro.mixai.tv.data.generated.Lyrics

@Composable
fun NowPlayingScreen(deps: MusicDeps, nav: MusicNav) {
    val state by deps.musicPlayback.state.collectAsState()
    var panel by rememberSaveable { mutableIntStateOf(0) } // 0 lyrics, 1 queue

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { nav.back() }) {
                    Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = stringResource(R.string.music_action_close))
                }
                Text(
                    stringResource(R.string.music_now_playing), style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f), textAlign = TextAlign.Center,
                )
                Spacer(Modifier.size(48.dp))
            }
            val track = state.track
            if (track == null) {
                EmptyState(Icons.Outlined.MusicNote, stringResource(R.string.music_nothing_playing), stringResource(R.string.music_nothing_playing_hint))
                return@Column
            }
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val wide = maxWidth > 720.dp && maxWidth > maxHeight
                if (wide) {
                    Row(Modifier.fillMaxSize()) {
                        Column(Modifier.weight(1f).fillMaxHeight().padding(24.dp), verticalArrangement = Arrangement.Center) {
                            PlayerHeader(deps, nav, state)
                            PlayerControls(deps, state)
                        }
                        Column(Modifier.weight(1f).fillMaxHeight()) {
                            PanelSwitch(panel) { panel = it }
                            PanelContent(deps, state, panel, Modifier.weight(1f))
                        }
                    }
                } else {
                    Column(Modifier.fillMaxSize()) {
                        Column(Modifier.padding(horizontal = 24.dp)) {
                            PlayerHeader(deps, nav, state, compact = true)
                            PlayerControls(deps, state)
                        }
                        PanelSwitch(panel) { panel = it }
                        PanelContent(deps, state, panel, Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun PlayerHeader(deps: MusicDeps, nav: MusicNav, state: MusicState, compact: Boolean = false) {
    val t = state.track ?: return
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        val coverMod = if (compact) Modifier.size(120.dp) else Modifier.weight(1f).widthIn(max = 360.dp).aspectRatio(1f)
        Cover(deps.music.coverUrl(t), coverMod, icon = Icons.Outlined.MusicNote)
        if (compact) TrackInfo(nav, state, Modifier.weight(1f))
    }
    if (!compact) TrackInfo(nav, state, Modifier.fillMaxWidth().padding(top = 16.dp))
}

@Composable
private fun TrackInfo(nav: MusicNav, state: MusicState, modifier: Modifier) {
    val t = state.track ?: return
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(t.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
        t.artist?.let { a ->
            Text(
                a, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clickable(enabled = !t.artistId.isNullOrBlank()) { t.artistId?.let { nav.openArtist(it) } },
            )
        }
        t.album?.let { al ->
            Text(
                al, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clickable(enabled = t.albumId.isNotBlank()) { nav.openAlbum(t.albumId) },
            )
        }
    }
}

@Composable
private fun PlayerControls(deps: MusicDeps, state: MusicState) {
    val pb = deps.musicPlayback
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableFloatStateOf(0f) }
    val dur = state.durationMs.coerceAtLeast(1L).toFloat()
    val pos = if (dragging) dragValue else state.positionMs.toFloat().coerceIn(0f, dur)
    Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
        Slider(
            value = pos,
            onValueChange = { dragging = true; dragValue = it },
            onValueChangeFinished = { pb.seek(dragValue.toLong()); dragging = false },
            valueRange = 0f..dur,
            enabled = state.durationMs > 0,
        )
        Row(Modifier.fillMaxWidth()) {
            Text(fmtDuration(pos.toLong()), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            Text(fmtDuration(state.durationMs), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceEvenly) {
            IconToggleButton(checked = state.shuffle, onCheckedChange = { pb.setShuffle(it) }) {
                Icon(
                    Icons.Outlined.Shuffle, contentDescription = stringResource(R.string.music_shuffle),
                    tint = if (state.shuffle) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { pb.prev() }) {
                Icon(Icons.Outlined.SkipPrevious, contentDescription = stringResource(R.string.music_previous), modifier = Modifier.size(32.dp))
            }
            FilledIconButton(onClick = { pb.toggle() }, modifier = Modifier.size(72.dp)) {
                if (state.buffering && !state.playing) {
                    CircularProgressIndicator(Modifier.size(28.dp), color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 3.dp)
                } else {
                    Icon(
                        if (state.playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                        contentDescription = stringResource(if (state.playing) R.string.music_pause else R.string.music_play),
                        modifier = Modifier.size(40.dp),
                    )
                }
            }
            IconButton(onClick = { pb.next() }) {
                Icon(Icons.Outlined.SkipNext, contentDescription = stringResource(R.string.music_next), modifier = Modifier.size(32.dp))
            }
            val nextMode = when (state.repeat) { RepeatMode.Off -> RepeatMode.All; RepeatMode.All -> RepeatMode.One; RepeatMode.One -> RepeatMode.Off }
            IconButton(onClick = { pb.setRepeat(nextMode) }) {
                Icon(
                    if (state.repeat == RepeatMode.One) Icons.Outlined.RepeatOne else Icons.Outlined.Repeat,
                    contentDescription = stringResource(
                        when (state.repeat) { RepeatMode.Off -> R.string.music_repeat_off; RepeatMode.All -> R.string.music_repeat_all; RepeatMode.One -> R.string.music_repeat_one },
                    ),
                    tint = if (state.repeat == RepeatMode.Off) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PanelSwitch(panel: Int, onSelect: (Int) -> Unit) {
    val labels = listOf(R.string.music_lyrics, R.string.music_queue)
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp)) {
        labels.forEachIndexed { i, l ->
            SegmentedButton(
                selected = panel == i,
                onClick = { onSelect(i) },
                shape = SegmentedButtonDefaults.itemShape(index = i, count = labels.size),
            ) { Text(stringResource(l)) }
        }
    }
}

@Composable
private fun PanelContent(deps: MusicDeps, state: MusicState, panel: Int, modifier: Modifier) {
    Box(modifier.fillMaxWidth()) {
        if (panel == 0) LyricsPanel(deps, state) else QueuePanel(deps, state)
    }
}

@Composable
private fun LyricsPanel(deps: MusicDeps, state: MusicState) {
    val track = state.track ?: return
    var lyrics by remember(track.id) { mutableStateOf<Lyrics?>(null) }
    var loaded by remember(track.id) { mutableStateOf(false) }
    var failed by remember(track.id) { mutableStateOf(false) }
    LaunchedEffect(track.id) {
        try { lyrics = deps.music.lyrics(track.id) } catch (e: CancellationException) { throw e } catch (e: Exception) { failed = true }
        loaded = true
    }
    val l = lyrics
    val synced = l?.synced.orEmpty()
    when {
        !loaded -> CenteredSpinner()
        synced.isNotEmpty() -> SyncedLyrics(synced, state.positionMs, onSeek = { deps.musicPlayback.seek(it) })
        !l?.plain.isNullOrBlank() -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(24.dp)) {
            item { Text(l?.plain.orEmpty(), style = MaterialTheme.typography.bodyLarge) }
        }
        else -> Text(
            stringResource(if (failed) R.string.music_lyrics_error else R.string.music_no_lyrics),
            Modifier.fillMaxWidth().padding(32.dp), textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SyncedLyrics(lines: List<LyricLine>, positionMs: Long, onSeek: (Long) -> Unit) {
    val listState: LazyListState = rememberLazyListState()
    val active = remember(lines, positionMs) { lines.indexOfLast { it.timeMs <= positionMs }.coerceAtLeast(0) }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        // Top padding = a third of the viewport, so scrolling the active line to index 0 parks it there.
        LaunchedEffect(active) { listState.animateScrollToItem(active) }
        LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(start = 24.dp, end = 24.dp, top = maxHeight / 3, bottom = maxHeight / 2)) {
            itemsIndexed(lines, key = { i, _ -> i }) { i, line ->
                val isActive = i == active
                val plain = remember(line.text) { Karaoke.plainText(line.text) }
                val style = if (isActive) MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleMedium
                val weight = if (isActive) FontWeight.Bold else FontWeight.Normal
                val rowModifier = Modifier.fillMaxWidth().clickable { onSeek(line.timeMs) }.padding(vertical = 8.dp)
                if (isActive && Karaoke.hasWordTiming(line.text)) {
                    val nextStart = lines.getOrNull(i + 1)?.timeMs
                    val words = remember(line.text, line.timeMs, nextStart) { Karaoke.parse(line.text, line.timeMs, nextStart) }
                    val sung = MaterialTheme.colorScheme.primary
                    val pending = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                    val annotated = buildAnnotatedString {
                        words.forEach { w -> withStyle(SpanStyle(color = if (w.startMs <= positionMs) sung else pending)) { append(w.text) } }
                    }
                    Text(annotated, style = style, fontWeight = weight, modifier = rowModifier)
                    return@itemsIndexed
                }
                Text(
                    plain.ifBlank { " " },
                    style = style,
                    fontWeight = weight,
                    color = if (isActive) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    modifier = rowModifier,
                )
            }
        }
    }
}

@Composable
private fun QueuePanel(deps: MusicDeps, state: MusicState) {
    if (state.queue.isEmpty()) {
        Text(stringResource(R.string.music_queue_empty), Modifier.fillMaxWidth().padding(32.dp), textAlign = TextAlign.Center)
        return
    }
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = state.index.coerceAtLeast(0))
    LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(bottom = 16.dp)) {
        itemsIndexed(state.queue, key = { i, t -> "$i-${t.id}" }) { i, t ->
            val current = i == state.index
            Box(if (current) Modifier.background(MaterialTheme.colorScheme.primary.copy(alpha = 0.10f)) else Modifier) {
                TrackRow(t, onClick = { deps.musicPlayback.skipTo(i) }, cover = deps.music.coverUrl(t), current = current)
            }
        }
    }
}

/** Compact bar above the bottom navigation while music is active. */
@Composable
fun MiniPlayer(deps: MusicDeps, nav: MusicNav) {
    val state by deps.musicPlayback.state.collectAsState()
    val t = state.track ?: return
    val openLabel = stringResource(R.string.music_open_now_playing)
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().height(64.dp)) {
            val progress = if (state.durationMs > 0) (state.positionMs.toFloat() / state.durationMs).coerceIn(0f, 1f) else 0f
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier.fillMaxWidth().height(2.dp),
                trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                drawStopIndicator = {},
                gapSize = 0.dp,
            )
            Row(
                Modifier.fillMaxSize().clickable(onClickLabel = openLabel) { nav.openNowPlaying() }.padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Cover(deps.music.coverUrl(t), Modifier.size(44.dp), icon = Icons.Outlined.MusicNote)
                Column(Modifier.weight(1f)) {
                    Text(t.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    t.artist?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                IconButton(onClick = { deps.musicPlayback.toggle() }) {
                    Icon(
                        if (state.playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                        contentDescription = stringResource(if (state.playing) R.string.music_pause else R.string.music_play),
                    )
                }
                IconButton(onClick = { deps.musicPlayback.next() }) {
                    Icon(Icons.Outlined.SkipNext, contentDescription = stringResource(R.string.music_next))
                }
            }
        }
    }
}
