package ro.mixai.tv.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import ro.mixai.tv.ui.theme.Tokens

/** Pulsing placeholder block (alpha 0.35 ↔ 0.8) on the muted token colour. */
@Composable
fun ShimmerBox(modifier: Modifier = Modifier, radius: Dp = 12.dp) {
    val transition = rememberInfiniteTransition(label = "shimmer")
    val alpha by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 0.8f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "shimmerAlpha",
    )
    androidx.compose.foundation.layout.Box(
        modifier.alpha(alpha).clip(RoundedCornerShape(radius)).background(Tokens.muted),
    )
}

/** A horizontal row of `count` card-sized shimmer placeholders (Home rows while loading). */
@Composable
fun SkeletonRow(count: Int, width: Dp, height: Dp, modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(horizontal = 56.dp)) {
    Row(modifier.padding(padding), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        repeat(count) { ShimmerBox(Modifier.size(width, height)) }
    }
}
