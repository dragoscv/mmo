package ro.mixai.tv.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

/** Moving-highlight skeleton block. */
@Composable
fun SkeletonBlock(modifier: Modifier = Modifier, radius: Dp = 12.dp) {
    val t = rememberInfiniteTransition(label = "skeleton")
    val x by t.animateFloat(-1f, 2f, infiniteRepeatable(tween(1400, easing = LinearEasing), RepeatMode.Restart), label = "skeletonX")
    val base = Tokens.muted
    val hi = Tokens.foreground.copy(alpha = 0.10f)
    Box(
        modifier.clip(RoundedCornerShape(radius)).background(base).background(
            Brush.linearGradient(
                colors = listOf(base.copy(alpha = 0f), hi, base.copy(alpha = 0f)),
                start = Offset(x * 600f, 0f),
                end = Offset(x * 600f + 400f, 400f),
            ),
        ),
    )
}

/**
 * Full-screen loading skeleton: a hero block + [rows] rows of poster placeholders.
 * Use per-row skeletons ([SkeletonPosterRow]) inside already-rendered screens.
 */
@Composable
fun LoadingState(modifier: Modifier = Modifier, rows: Int = 2, hero: Boolean = true) {
    Column(modifier.fillMaxSize().padding(top = MixaiFocus.overscanTop), verticalArrangement = Arrangement.spacedBy(32.dp)) {
        if (hero) {
            Column(Modifier.padding(horizontal = MixaiFocus.overscan), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                SkeletonBlock(Modifier.width(420.dp).height(48.dp), radius = 8.dp)
                SkeletonBlock(Modifier.width(260.dp).height(20.dp), radius = 6.dp)
                SkeletonBlock(Modifier.width(560.dp).height(64.dp), radius = 6.dp)
            }
        }
        repeat(rows) { SkeletonPosterRow() }
    }
}

/** One row of poster-sized skeletons. */
@Composable
fun SkeletonPosterRow(count: Int = 7, width: Dp = POSTER_WIDTH, aspect: Float = 2f / 3f, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SkeletonBlock(Modifier.padding(horizontal = MixaiFocus.overscan).width(200.dp).height(22.dp), radius = 6.dp)
        Row(Modifier.padding(horizontal = MixaiFocus.overscan), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            repeat(count) { SkeletonBlock(Modifier.size(width, width / aspect)) }
        }
    }
}

/**
 * Empty placeholder: vector icon, title, message, optional action (e.g. a [PrimaryButton]).
 * Centered in the available space; the action gets focus automatically when [focusAction].
 */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    message: String? = null,
    modifier: Modifier = Modifier,
    focusAction: Boolean = true,
    action: (@Composable (Modifier) -> Unit)? = null,
) {
    StateBox(icon, Tokens.mutedForeground, title, Tokens.foreground, message, modifier, focusAction, action)
}

/** Error placeholder with a Retry button (focused automatically). */
@Composable
fun ErrorState(message: String, onRetry: (() -> Unit)?, modifier: Modifier = Modifier, title: String = stringResource(R.string.wp16_error_title)) {
    StateBox(
        Icons.Filled.Warning, Tokens.destructive, title, Tokens.foreground, message, modifier, true,
        if (onRetry != null) ({ m -> PrimaryButton(stringResource(R.string.action_retry), onRetry, m) }) else null,
    )
}

@Composable
private fun StateBox(
    icon: ImageVector,
    iconTint: androidx.compose.ui.graphics.Color,
    title: String,
    titleColor: androidx.compose.ui.graphics.Color,
    message: String?,
    modifier: Modifier,
    focusAction: Boolean,
    action: (@Composable (Modifier) -> Unit)?,
) {
    val focus = remember { FocusRequester() }
    if (action != null && focusAction) LaunchedEffect(Unit) { delay(50); runCatching { focus.requestFocus() } }
    Box(modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 640.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(56.dp))
            Text(title, style = MaterialTheme.typography.headlineSmall, color = titleColor, textAlign = TextAlign.Center)
            if (!message.isNullOrBlank()) Text(message, style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground, textAlign = TextAlign.Center)
            if (action != null) Box(Modifier.padding(top = 8.dp)) { action(Modifier.focusRequester(focus)) }
        }
    }
}
