package ro.mixai.tv.player

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.ui.components.IconActionButton
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.theme.Tokens
import kotlin.math.roundToInt

// Custom Compose OSD for the video player (WP16-21): glass panels from tokens, scrub bar with
// buffered range / chapter ticks / intro + credits markers, sprite preview, skip pill, Up Next.

internal val GlassShape = RoundedCornerShape(16.dp)

internal fun Modifier.glass(): Modifier = this
    .clip(GlassShape)
    .background(Tokens.popover.copy(alpha = 0.78f))
    .border(1.dp, Tokens.border, GlassShape)

/**
 * The player suspends the global ultrawide squeeze (SurfaceView ignores layer transforms), so
 * Compose overlays drawn over the video re-apply it themselves: laid out [k]× wider, scaled 1/[k].
 */
internal fun Modifier.squeezed(k: Float): Modifier = if (k == 1f) this else layout { measurable, constraints ->
    val w = constraints.maxWidth
    val h = constraints.maxHeight
    val placeable = measurable.measure(Constraints.fixed((w * k).roundToInt(), h))
    layout(w, h) {
        placeable.placeWithLayer(0, 0) {
            scaleX = 1f / k
            transformOrigin = TransformOrigin(0f, 0f)
        }
    }
}

/** `1:02:03` / `43:10`. */
internal fun formatTime(ms: Long): String {
    val total = (ms.coerceAtLeast(0) / 1000)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/** Bottom + top scrims under the OSD text. */
@Composable
internal fun OsdScrims(visible: Boolean) {
    AnimatedVisibility(visible, enter = fadeIn(), exit = fadeOut()) {
        Box(Modifier.fillMaxSize()) {
            Box(
                Modifier.fillMaxWidth().fillMaxHeight(0.25f).align(Alignment.TopCenter)
                    .background(Brush.verticalGradient(listOf(Tokens.background.copy(alpha = 0.75f), Color.Transparent))),
            )
            Box(
                Modifier.fillMaxWidth().fillMaxHeight(0.45f).align(Alignment.BottomCenter)
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Tokens.background.copy(alpha = 0.9f)))),
            )
        }
    }
}

/**
 * Focusable scrub bar. [targetMs] (non-null while scrubbing) moves the thumb ahead of playback.
 * [onKey] receives the bar's key events (Left/Right scrub, Center commit/toggle).
 */
@Composable
internal fun ScrubBar(
    posMs: Long,
    durMs: Long,
    bufMs: Long,
    targetMs: Long?,
    markers: Markers,
    focusRequester: FocusRequester,
    onKey: (KeyEvent) -> Boolean,
    modifier: Modifier = Modifier,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val track = Tokens.foreground.copy(alpha = 0.18f)
    val buffered = Tokens.foreground.copy(alpha = 0.38f)
    val played = Tokens.primary
    val marker = Tokens.warning.copy(alpha = 0.85f)
    val tick = Tokens.foreground.copy(alpha = 0.85f)
    val thumb = Tokens.foreground
    Canvas(
        modifier
            .fillMaxWidth()
            .height(28.dp)
            .focusRequester(focusRequester)
            .onKeyEvent(onKey)
            .focusable(interactionSource = interaction),
    ) {
        if (durMs <= 0) return@Canvas
        val h = if (focused) 10.dp.toPx() else 6.dp.toPx()
        val y = (size.height - h) / 2
        val r = CornerRadius(h / 2, h / 2)
        fun x(ms: Long) = (ms.toFloat() / durMs).coerceIn(0f, 1f) * size.width
        drawRoundRect(track, Offset(0f, y), Size(size.width, h), r)
        drawRoundRect(buffered, Offset(0f, y), Size(x(bufMs), h), r)
        drawRoundRect(played, Offset(0f, y), Size(x(posMs), h), r)
        markers.intro?.let { drawRect(marker, Offset(x(it.startMs), y), Size((x(it.endMs) - x(it.startMs)).coerceAtLeast(2f), h)) }
        markers.recap?.let { drawRect(marker, Offset(x(it.startMs), y), Size((x(it.endMs) - x(it.startMs)).coerceAtLeast(2f), h)) }
        markers.creditsMs?.let { drawRect(marker, Offset(x(it), y), Size((size.width - x(it)).coerceAtLeast(2f), h)) }
        val tw = 2.dp.toPx()
        markers.chapters.forEach { c -> if (c.startMs > 0) drawRect(tick, Offset(x(c.startMs) - tw / 2, y - 3.dp.toPx()), Size(tw, h + 6.dp.toPx())) }
        if (focused || targetMs != null) {
            val tx = x(targetMs ?: posMs)
            drawCircle(thumb, radius = if (targetMs != null) 11.dp.toPx() else 9.dp.toPx(), center = Offset(tx, size.height / 2))
        }
    }
}

/**
 * Sprite thumbnail + target time, positioned above the bar at [fraction] of its width.
 * Draws the right 160×90 tile of `sprite.jpg` with `drawImage(srcOffset, srcSize)`.
 */
@Composable
internal fun ScrubPreview(sprite: ImageBitmap?, grid: SpriteGrid?, targetMs: Long, fraction: Float, chapter: String?) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val boxW = 256.dp
        val x = (maxWidth * fraction - boxW / 2).coerceIn(0.dp, (maxWidth - boxW).coerceAtLeast(0.dp))
        Column(Modifier.offset(x = x).width(boxW), horizontalAlignment = Alignment.CenterHorizontally) {
            if (sprite != null && grid != null) {
                val tile = spriteTile(grid, targetMs / 1000.0)
                val col = tile % SPRITE_GRID
                val row = tile / SPRITE_GRID
                Canvas(Modifier.size(boxW, 144.dp).clip(RoundedCornerShape(10.dp)).border(2.dp, Tokens.foreground, RoundedCornerShape(10.dp))) {
                    drawImage(
                        image = sprite,
                        srcOffset = IntOffset(col * 160, row * 90),
                        srcSize = IntSize(160, 90),
                        dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()),
                    )
                }
                Spacer(Modifier.height(6.dp))
            }
            Text(
                formatTime(targetMs),
                style = MaterialTheme.typography.titleMedium,
                color = Tokens.foreground,
                modifier = Modifier.glass().padding(horizontal = 12.dp, vertical = 4.dp),
            )
            if (!chapter.isNullOrBlank()) {
                Text(chapter, style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** One OSD control: round icon button; the label is shown under the row for the focused one. */
@Composable
internal fun OsdButton(icon: ImageVector, label: String, onClick: () -> Unit, focusRequester: FocusRequester, onFocused: () -> Unit, selected: Boolean = false) {
    IconActionButton(
        icon = icon, label = label, onClick = onClick, selected = selected,
        modifier = Modifier.onFocusChanged { if (it.isFocused) onFocused() }.focusRequester(focusRequester),
    )
}

/** Skip intro / recap pill (bottom-right, focused automatically). */
@Composable
internal fun SkipPill(label: String, onClick: () -> Unit, focusRequester: FocusRequester, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        modifier = modifier.focusRequester(focusRequester),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(28.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Tokens.popover.copy(alpha = 0.85f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
    ) {
        Text(label, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 28.dp, vertical = 14.dp))
    }
}

/** Ring around the remaining seconds. */
@Composable
internal fun CountdownRing(fraction: Float, secondsLeft: Int, size: Dp = 56.dp) {
    val ringBg = Tokens.foreground.copy(alpha = 0.2f)
    val ring = Tokens.primary
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = 4.dp.toPx()
            drawArc(ringBg, 0f, 360f, false, style = Stroke(stroke), topLeft = Offset(stroke / 2, stroke / 2), size = Size(this.size.width - stroke, this.size.height - stroke))
            drawArc(ring, -90f, 360f * fraction.coerceIn(0f, 1f), false, style = Stroke(stroke), topLeft = Offset(stroke / 2, stroke / 2), size = Size(this.size.width - stroke, this.size.height - stroke))
        }
        Text(secondsLeft.toString(), style = MaterialTheme.typography.titleMedium, color = Tokens.foreground)
    }
}

/**
 * Up Next card (bottom-right). With [countdownSec] > 0 it counts down and calls [onPlay];
 * 0 = no countdown (autoplay off).
 */
@Composable
internal fun UpNextCard(
    title: String,
    subtitle: String,
    stillUrl: String?,
    countdownSec: Int,
    onPlay: () -> Unit,
    onCancel: () -> Unit,
    playFocus: FocusRequester,
    modifier: Modifier = Modifier,
) {
    var left by remember { mutableIntStateOf(countdownSec * 10) }
    LaunchedEffect(countdownSec) {
        if (countdownSec <= 0) return@LaunchedEffect
        left = countdownSec * 10
        while (left > 0) { delay(100); left-- }
        onPlay()
    }
    BackHandler(onBack = onCancel)
    Row(modifier.widthIn(max = 720.dp).glass().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(20.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(224.dp, 126.dp).clip(RoundedCornerShape(10.dp)).background(Tokens.card)) {
            if (stillUrl != null) AsyncImage(model = stillUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Column(Modifier.widthIn(max = 380.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (countdownSec > 0) CountdownRing(left / (countdownSec * 10f), (left + 9) / 10)
                Column {
                    Text(title, style = MaterialTheme.typography.labelLarge, color = Tokens.mutedForeground)
                    Text(subtitle, style = MaterialTheme.typography.titleMedium, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PrimaryButton(stringResource(R.string.player_play_now), onPlay, Modifier.focusRequester(playFocus))
                SecondaryButton(stringResource(R.string.wp16_cancel), onCancel)
            }
        }
    }
}

/** "More like this" teaser at movie credits. */
@Composable
internal fun MoreLikeThisCard(onBackToTitle: () -> Unit, onDismiss: () -> Unit, focus: FocusRequester, modifier: Modifier = Modifier) {
    BackHandler(onBack = onDismiss)
    Column(modifier.widthIn(max = 520.dp).glass().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.player_more_like_this), style = MaterialTheme.typography.titleLarge, color = Tokens.foreground)
        Text(stringResource(R.string.player_more_like_this_hint), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            PrimaryButton(stringResource(R.string.player_back_to_title), onBackToTitle, Modifier.focusRequester(focus))
            SecondaryButton(stringResource(R.string.player_keep_watching), onDismiss)
        }
    }
}

/** Read-only side panel (Info). Back closes it. */
@Composable
internal fun InfoPanel(title: String, rows: List<Pair<String, String>>, onDismiss: () -> Unit) {
    BackHandler(onBack = onDismiss)
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { focus.requestFocus() } }
    Box(Modifier.fillMaxSize().background(Tokens.background.copy(alpha = 0.55f))) {
        Column(
            Modifier.align(Alignment.CenterEnd).width(520.dp).fillMaxHeight().background(Tokens.popover).padding(32.dp).focusGroup(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(title, style = MaterialTheme.typography.headlineSmall, color = Tokens.popoverForeground)
            rows.forEach { (k, v) ->
                Row(Modifier.fillMaxWidth()) {
                    Text(k, style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground, modifier = Modifier.width(170.dp))
                    Text(v, style = MaterialTheme.typography.bodyMedium, color = Tokens.popoverForeground)
                }
            }
            Spacer(Modifier.height(12.dp))
            SecondaryButton(stringResource(R.string.player_close), onDismiss, Modifier.focusRequester(focus))
        }
    }
}

internal data class Bubble(val id: Long, val text: String, val lane: Int)

/** Floating reactions (Watch Together) — emoji here is user content. */
@Composable
internal fun ReactionsLayer(bubbles: List<Bubble>, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize()) {
        bubbles.forEach { b ->
            Text(
                b.text,
                style = MaterialTheme.typography.headlineMedium,
                color = Tokens.foreground,
                modifier = Modifier.align(Alignment.BottomEnd).padding(end = (48 + b.lane * 64).dp, bottom = 220.dp)
                    .glass().padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }
    }
}

/** Chat / status toasts (top-right). */
@Composable
internal fun ToastLayer(toasts: List<Bubble>, modifier: Modifier = Modifier) {
    LazyColumn(modifier.widthIn(max = 520.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(toasts, key = { it.id }) { t ->
            Text(
                t.text, style = MaterialTheme.typography.bodyMedium, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.glass().padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }
}
