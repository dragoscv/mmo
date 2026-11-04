package ro.mixai.tv.ui.music

import android.os.SystemClock
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.MusicState
import ro.mixai.tv.data.RepeatMode
import ro.mixai.tv.data.generated.LyricLine
import ro.mixai.tv.data.generated.Lyrics
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.IconActionButton
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens
import java.util.Date

private const val AMBIENT_AFTER_MS = 60_000L
private const val SEEK_STEP_MS = 10_000L

/**
 * Now Playing (full screen, no rail): blurred artwork backdrop; left = artwork, metadata, progress,
 * transport controls; right = Lyrics (synced, auto-scrolled) or Queue. After 60 s without input it
 * fades into an ambient view (artwork + current lyric line + clock); any key restores the UI.
 */
@Composable
fun NowPlayingScreen(deps: ScreenDeps, nav: Navigator) {
    val playback = deps.musicPlayback
    val s by playback.state.collectAsState()
    val track = s.track

    // play() is async (controller connect): give it a moment before showing "nothing playing".
    var grace by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) { delay(1_500); grace = false }

    val cover = track?.let { deps.music.coverUrl(it.coverArt.ifBlank { it.id }, 400) }
    val backdropCover = track?.let { deps.music.backdropCover(it.coverArt.ifBlank { it.id }) }

    var lastInput by remember { mutableLongStateOf(SystemClock.uptimeMillis()) }
    var ambient by remember { mutableStateOf(false) }
    val hasTrack = track != null
    LaunchedEffect(lastInput, ambient, hasTrack) {
        if (ambient || !hasTrack) return@LaunchedEffect
        delay(AMBIENT_AFTER_MS)
        ambient = true
    }

    val position = rememberSmoothPosition(s)
    val lyrics = rememberLyrics(deps, track?.id)

    Box(
        Modifier
            .fillMaxSize()
            .onPreviewKeyEvent { e ->
                lastInput = SystemClock.uptimeMillis()
                if (ambient) {
                    // Any key wakes the UI; navigation keys are swallowed, media keys still reach the session.
                    if (e.type == KeyEventType.KeyUp) ambient = false
                    !isMediaKey(e.key)
                } else {
                    false
                }
            },
    ) {
        BlurredArtwork(backdropCover)
        val uiAlpha by animateFloatAsState(if (ambient) 0f else 1f, tween(800), label = "npUi")
        Box(Modifier.fillMaxSize().graphicsLayer { alpha = uiAlpha }) {
            when {
                track != null -> NowPlayingContent(deps, s, position, cover, lyrics)
                !grace -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    EmptyState(
                        icon = MixaiIcons.MusicNote,
                        title = stringResource(R.string.music_nothing_playing),
                        message = stringResource(R.string.music_nothing_playing_message),
                        action = { m ->
                            PrimaryButton(stringResource(R.string.music_browse), onClick = {
                                if (!nav.popTo { it is Route.Music }) nav.replace(Route.Music)
                            }, modifier = m)
                        },
                    )
                }
            }
        }
        AnimatedVisibility(ambient && track != null, enter = fadeIn(tween(800)), exit = fadeOut(tween(300))) {
            AmbientView(cover, track?.title.orEmpty(), track?.artist, currentLine(lyrics, position))
        }
    }
}

// ─── position / lyrics state ────────────────────────────────────────────────

private fun isMediaKey(k: Key): Boolean =
    k == Key.MediaPlayPause || k == Key.MediaPlay || k == Key.MediaPause || k == Key.MediaNext ||
        k == Key.MediaPrevious || k == Key.MediaStop || k == Key.MediaFastForward || k == Key.MediaRewind

/** Interpolates the 2 Hz position from [MusicState] at ~10 Hz so lyric highlighting is precise. */
@Composable
private fun rememberSmoothPosition(s: MusicState): Long {
    var pos by remember { mutableLongStateOf(s.positionMs) }
    LaunchedEffect(s.positionMs, s.playing, s.track?.id) {
        val base = s.positionMs
        val t0 = SystemClock.uptimeMillis()
        pos = base
        while (s.playing) {
            delay(100)
            val p = base + (SystemClock.uptimeMillis() - t0)
            pos = if (s.durationMs > 0) p.coerceAtMost(s.durationMs) else p
        }
    }
    return pos
}

@Composable
private fun rememberLyrics(deps: ScreenDeps, trackId: String?): Load<Lyrics?> {
    var state by remember(trackId) { mutableStateOf<Load<Lyrics?>>(Load.Loading) }
    LaunchedEffect(trackId) {
        if (trackId == null) { state = Load.Ok(null); return@LaunchedEffect }
        state = try {
            Load.Ok(deps.music.lyrics(trackId))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Load.Err(e.message ?: "")
        }
    }
    return state
}

private fun Lyrics.syncedLines(): List<LyricLine> = synced.orEmpty().filter { it.text.isNotBlank() }

/** Index of the active synced line (-1 before the first). */
private fun activeIndex(lines: List<LyricLine>, posMs: Long): Int {
    var lo = 0
    var hi = lines.lastIndex
    var ans = -1
    while (lo <= hi) {
        val mid = (lo + hi) ushr 1
        if (lines[mid].timeMs <= posMs) { ans = mid; lo = mid + 1 } else hi = mid - 1
    }
    return ans
}

private fun currentLine(lyrics: Load<Lyrics?>, posMs: Long): String? {
    val l = (lyrics as? Load.Ok)?.value ?: return null
    val lines = l.syncedLines()
    if (lines.isEmpty()) return null
    return lines.getOrNull(activeIndex(lines, posMs))?.text
}

// ─── main layout ────────────────────────────────────────────────────────────

private enum class Panel { Lyrics, Queue }

@Composable
private fun NowPlayingContent(deps: ScreenDeps, s: MusicState, position: Long, cover: String?, lyrics: Load<Lyrics?>) {
    val track = s.track ?: return
    var panelName by rememberSaveable { mutableStateOf(Panel.Lyrics.name) }
    val panel = Panel.valueOf(panelName)
    val playFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { playFocus.requestFocus() } }

    Row(
        Modifier.fillMaxSize().padding(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = MixaiFocus.overscanTop + 8.dp, bottom = MixaiFocus.overscanTop),
        horizontalArrangement = Arrangement.spacedBy(56.dp),
    ) {
        // ── left: artwork + meta + progress + controls ──
        Column(Modifier.width(520.dp).fillMaxHeight(), verticalArrangement = Arrangement.Center) {
            ArtworkOrPlaceholder(cover, track.album, Modifier.size(400.dp).clip(RoundedCornerShape(16.dp)))
            Spacer(Modifier.height(24.dp))
            Text(track.title, style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(track.artist ?: stringResource(R.string.music_unknown_artist), style = MaterialTheme.typography.titleMedium, color = Tokens.foreground.copy(alpha = 0.85f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            val album = track.album
            if (!album.isNullOrBlank()) {
                Text(album, style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(20.dp))
            SeekBar(position, s.durationMs, onSeek = { deps.musicPlayback.seek(it) })
            Spacer(Modifier.height(18.dp))
            Controls(deps, s, playFocus)
        }

        // ── right: lyrics | queue ──
        Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillButton(stringResource(R.string.music_lyrics), onClick = { panelName = Panel.Lyrics.name }, selected = panel == Panel.Lyrics, icon = MixaiIcons.Lyrics, compact = true)
                PillButton(stringResource(R.string.music_queue), onClick = { panelName = Panel.Queue.name }, selected = panel == Panel.Queue, icon = MixaiIcons.Queue, compact = true)
            }
            Box(Modifier.fillMaxSize()) {
                when (panel) {
                    Panel.Lyrics -> LyricsPanel(lyrics, position, onSeek = { deps.musicPlayback.seek(it) })
                    Panel.Queue -> QueuePanel(deps, s)
                }
            }
        }
    }
}

@Composable
private fun SeekBar(position: Long, duration: Long, onSeek: (Long) -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val frac = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
    Column(
        Modifier
            .fillMaxWidth()
            .onFocusChanged { focused = it.isFocused }
            .onPreviewKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown || duration <= 0) return@onPreviewKeyEvent false
                when (e.key) {
                    Key.DirectionLeft -> { onSeek((position - SEEK_STEP_MS).coerceAtLeast(0)); true }
                    Key.DirectionRight -> { onSeek((position + SEEK_STEP_MS).coerceAtMost(duration - 1_000)); true }
                    else -> false
                }
            }
            .focusable(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val h = if (focused) 8.dp else 4.dp
        Box(Modifier.fillMaxWidth().height(h).clip(RoundedCornerShape(4.dp)).background(Tokens.foreground.copy(alpha = 0.22f))) {
            Box(Modifier.fillMaxWidth(frac).height(h).background(if (focused) Tokens.primary else Tokens.foreground))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatMs(position), style = MaterialTheme.typography.labelMedium, color = Tokens.mutedForeground)
            if (focused) Text(stringResource(R.string.music_seek_hint), style = MaterialTheme.typography.labelMedium, color = Tokens.foreground)
            Text(if (duration > 0) "-" + formatMs(duration - position) else "", style = MaterialTheme.typography.labelMedium, color = Tokens.mutedForeground)
        }
    }
}

@Composable
private fun Controls(deps: ScreenDeps, s: MusicState, playFocus: FocusRequester) {
    val p = deps.musicPlayback
    Row(Modifier.focusRestorer(playFocus), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
        IconActionButton(MixaiIcons.Shuffle, stringResource(R.string.music_shuffle), onClick = { p.setShuffle(!s.shuffle) }, selected = s.shuffle)
        IconActionButton(MixaiIcons.SkipPrevious, stringResource(R.string.music_prev), onClick = { p.prev() })
        IconActionButton(
            if (s.playing) MixaiIcons.Pause else Icons.Filled.PlayArrow,
            stringResource(if (s.playing) R.string.music_pause else R.string.music_resume),
            onClick = { p.toggle() },
            modifier = Modifier.focusRequester(playFocus).size(64.dp),
            selected = true,
        )
        IconActionButton(MixaiIcons.SkipNext, stringResource(R.string.music_next), onClick = { p.next() }, enabled = s.index < s.queue.lastIndex || s.repeat == RepeatMode.All)
        val (icon, label) = when (s.repeat) {
            RepeatMode.Off -> MixaiIcons.Repeat to R.string.music_repeat_off
            RepeatMode.All -> MixaiIcons.Repeat to R.string.music_repeat_all
            RepeatMode.One -> MixaiIcons.RepeatOne to R.string.music_repeat_one
        }
        IconActionButton(
            icon, stringResource(label),
            onClick = { p.setRepeat(when (s.repeat) { RepeatMode.Off -> RepeatMode.All; RepeatMode.All -> RepeatMode.One; RepeatMode.One -> RepeatMode.Off }) },
            selected = s.repeat != RepeatMode.Off,
        )
    }
}

// ─── lyrics ─────────────────────────────────────────────────────────────────

@Composable
private fun LyricsPanel(lyrics: Load<Lyrics?>, position: Long, onSeek: (Long) -> Unit) {
    when (lyrics) {
        Load.Loading -> Unit
        is Load.Err -> PanelMessage(stringResource(R.string.music_lyrics_error))
        is Load.Ok -> {
            val l = lyrics.value
            val lines = l?.syncedLines().orEmpty()
            val plain = l?.plain
            when {
                lines.isNotEmpty() -> SyncedLyrics(lines, position, onSeek)
                !plain.isNullOrBlank() -> PlainLyrics(plain)
                else -> PanelMessage(stringResource(R.string.music_no_lyrics))
            }
        }
    }
}

@Composable
private fun PanelMessage(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.titleMedium, color = Tokens.mutedForeground, textAlign = TextAlign.Center)
    }
}

@Composable
private fun SyncedLyrics(lines: List<LyricLine>, position: Long, onSeek: (Long) -> Unit) {
    val active = activeIndex(lines, position)
    val list = rememberLazyListState()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        // Top padding = 40 % of the panel → scrolling to index i puts line i at ~40 % height.
        val top = maxHeight * 0.4f
        LaunchedEffect(active) { if (active >= 0) list.animateScrollToItem(active) else list.scrollToItem(0) }
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxSize(),
            userScrollEnabled = false,
            contentPadding = PaddingValues(top = top, bottom = maxHeight * 0.55f),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            itemsIndexed(lines, key = { i, _ -> i }) { i, line ->
                val a by animateFloatAsState(
                    when {
                        i == active -> 1f
                        i > active -> 0.5f
                        else -> 0.32f
                    },
                    tween(250), label = "lyricAlpha",
                )
                Text(
                    line.text,
                    style = if (i == active) MaterialTheme.typography.headlineMedium else MaterialTheme.typography.headlineSmall,
                    color = Tokens.foreground,
                    modifier = Modifier.alpha(a),
                )
            }
        }
    }
}

@Composable
private fun PlainLyrics(text: String) {
    val scroll = rememberScrollState()
    val scope = rememberCoroutineScope()
    var focused by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxSize()
            .onFocusChanged { focused = it.isFocused }
            .onPreviewKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (e.key) {
                    Key.DirectionDown -> if (scroll.value < scroll.maxValue) { scope.launch { scroll.animateScrollBy(240f) }; true } else false
                    Key.DirectionUp -> if (scroll.value > 0) { scope.launch { scroll.animateScrollBy(-240f) }; true } else false
                    else -> false
                }
            }
            .focusable()
            .clip(RoundedCornerShape(12.dp))
            .background(if (focused) Tokens.foreground.copy(alpha = 0.06f) else Tokens.background.copy(alpha = 0f))
            .verticalScroll(scroll)
            .padding(16.dp),
    ) {
        Text(text, style = MaterialTheme.typography.titleLarge, color = Tokens.foreground.copy(alpha = 0.9f))
    }
}

private suspend fun androidx.compose.foundation.ScrollState.animateScrollBy(px: Float) {
    animateScrollTo((value + px).toInt().coerceIn(0, maxValue))
}

// ─── queue ──────────────────────────────────────────────────────────────────

@Composable
private fun QueuePanel(deps: ScreenDeps, s: MusicState) {
    if (s.queue.isEmpty()) { PanelMessage(stringResource(R.string.music_nothing_playing)); return }
    val list = rememberLazyListState(initialFirstVisibleItemIndex = (s.index - 2).coerceAtLeast(0))
    val current = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { current.requestFocus() } }
    LazyColumn(
        state = list,
        modifier = Modifier.fillMaxSize().focusRestorer(current),
        contentPadding = PaddingValues(bottom = 48.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        itemsIndexed(s.queue, key = { i, t -> "$i:${t.id}" }) { i, t ->
            TrackListItem(
                number = "${i + 1}",
                title = t.title,
                subtitle = t.artist,
                duration = formatDuration(t.durationSec),
                coverUrl = deps.music.coverUrl(t),
                active = i == s.index,
                onClick = { deps.musicPlayback.skipTo(i) },
                modifier = if (i == s.index) Modifier.focusRequester(current) else Modifier,
            )
        }
    }
}

// ─── ambient ────────────────────────────────────────────────────────────────

@Composable
private fun AmbientView(cover: String?, title: String, artist: String?, line: String?) {
    val context = LocalContext.current
    val timeFormat = remember(context) { android.text.format.DateFormat.getTimeFormat(context) }
    var now by remember { mutableStateOf(timeFormat.format(Date())) }
    LaunchedEffect(Unit) { while (true) { now = timeFormat.format(Date()); delay(1_000) } }
    Box(Modifier.fillMaxSize().background(Tokens.background.copy(alpha = 0.35f))) {
        Text(
            now,
            style = MaterialTheme.typography.displaySmall,
            color = Tokens.foreground.copy(alpha = 0.85f),
            modifier = Modifier.align(Alignment.TopEnd).padding(horizontal = MixaiFocus.overscan, vertical = MixaiFocus.overscanTop),
        )
        Column(
            Modifier.align(Alignment.Center).padding(horizontal = MixaiFocus.overscan),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            ArtworkOrPlaceholder(cover, null, Modifier.size(440.dp).clip(RoundedCornerShape(20.dp)))
            Text(
                line ?: listOfNotNull(title, artist).joinToString(" · "),
                style = MaterialTheme.typography.headlineMedium,
                color = Tokens.foreground,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
