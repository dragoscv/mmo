package ro.mixai.tv.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import ro.mixai.tv.ui.nav.sharedPoster
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens
import ro.mixai.tv.ui.theme.mixaiCardBorder
import ro.mixai.tv.ui.theme.mixaiCardScale

/** Default poster width (2:3) on the 1080p canvas. */
val POSTER_WIDTH: Dp = 180.dp
/** Default landscape card width (16:9). */
val LANDSCAPE_WIDTH: Dp = 320.dp

/** Small badge on a card / hero (`4K`, `HDR`, `DV`, age rating, "In library"). */
enum class BadgeTone { Neutral, Accent, Success, Warning }

data class CardBadge(val text: String, val tone: BadgeTone = BadgeTone.Neutral)

@Composable
fun BadgePill(badge: CardBadge, modifier: Modifier = Modifier) {
    val (bg, fg) = when (badge.tone) {
        BadgeTone.Neutral -> Tokens.background.copy(alpha = 0.72f) to Tokens.foreground
        BadgeTone.Accent -> Tokens.primary to Tokens.primaryForeground
        BadgeTone.Success -> Tokens.success to Tokens.background
        BadgeTone.Warning -> Tokens.warning to Tokens.background
    }
    Text(
        badge.text,
        style = MaterialTheme.typography.labelSmall,
        color = fg,
        maxLines = 1,
        modifier = modifier.clip(RoundedCornerShape(6.dp)).background(bg).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

/** Thin progress bar (0..1) on the token palette. */
@Composable
fun CardProgress(fraction: Float, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(Tokens.foreground.copy(alpha = 0.25f))) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(4.dp).background(Tokens.primary))
    }
}

@Composable
private fun cardGlow() = if (PerfFlags.noGlow || LocalReducedMotion.current) CardDefaults.glow() else CardDefaults.glow(focusedGlow = Glow(MixaiFocus.glowColor, MixaiFocus.glowElevation))

/**
 * Placeholder art when there is no TMDB poster (WP16 critic P2-9): the file's still frame (if
 * [stillUrl]) cropped to the card, a soft accent wash, a bottom scrim, and the guessed title as a
 * lockup in the heading face. Without a still it is a two-stop accent/card gradient.
 */
@Composable
fun PlaceholderArt(title: String, stillUrl: String?, modifier: Modifier = Modifier) {
    Box(modifier.background(Brush.verticalGradient(listOf(Tokens.accent, Tokens.card)))) {
        if (stillUrl != null) {
            AsyncImage(model = stillUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            Box(Modifier.fillMaxSize().background(Tokens.primary.copy(alpha = 0.18f)))
        }
        Box(
            Modifier.align(Alignment.BottomStart).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Tokens.background.copy(alpha = 0.92f))))
                .padding(start = 12.dp, end = 12.dp, top = 36.dp, bottom = 12.dp),
        ) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                color = Tokens.foreground,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * 2:3 poster card with the MixAI focus treatment (scale + ring + accent glow). Title shows under the
 * card while focused (or always with [alwaysShowTitle]). [sharedKey] enables the shared poster
 * transition into the detail page (use the same key there with `Modifier.sharedPoster`).
 */
@Composable
fun PosterCard(
    imageUrl: String?,
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = POSTER_WIDTH,
    subtitle: String? = null,
    progress: Float? = null,
    badges: List<CardBadge> = emptyList(),
    sharedKey: String? = null,
    alwaysShowTitle: Boolean = false,
    onLongClick: (() -> Unit)? = null,
    onFocus: () -> Unit = {},
    placeholderStill: String? = null,
) {
    var focused by remember { mutableStateOf(false) }
    Column(modifier.width(width), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Card(
            onClick = onClick,
            onLongClick = onLongClick,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(2f / 3f)
                .onFocusChanged { if (it.isFocused != focused) { focused = it.isFocused; if (it.isFocused) onFocus() } },
            shape = CardDefaults.shape(MixaiFocus.cardShape),
            colors = CardDefaults.colors(containerColor = Tokens.card, focusedContainerColor = Tokens.card),
            scale = mixaiCardScale(),
            border = mixaiCardBorder(),
            glow = cardGlow(),
        ) {
            Box(Modifier.fillMaxSize()) {
                val imgMod = Modifier.fillMaxSize().let { m -> if (sharedKey != null) m.sharedPoster(sharedKey) else m }
                if (imageUrl != null) {
                    AsyncImage(model = imageUrl, contentDescription = title, contentScale = ContentScale.Crop, modifier = imgMod)
                } else {
                    PlaceholderArt(title, placeholderStill, imgMod)
                }
                if (badges.isNotEmpty()) {
                    Row(Modifier.align(Alignment.TopStart).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        badges.take(3).forEach { BadgePill(it) }
                    }
                }
                if (progress != null && progress > 0f) {
                    Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Tokens.background.copy(alpha = 0.8f)))).padding(8.dp)) {
                        CardProgress(progress)
                    }
                }
            }
        }
        if (focused || alwaysShowTitle) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground, maxLines = 1, overflow = TextOverflow.Ellipsis)
        } else {
            // Keep row height stable so focus moves don't jump the layout.
            Spacer(Modifier.height(if (subtitle.isNullOrBlank()) 20.dp else 40.dp))
        }
    }
}

/**
 * 16:9 card for episodes / continue watching: still or backdrop, progress, a caption like
 * "S1·E4 · 12 min left" ([caption]) and a [title] line under the image.
 */
@Composable
fun LandscapeCard(
    imageUrl: String?,
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = LANDSCAPE_WIDTH,
    caption: String? = null,
    progress: Float? = null,
    badges: List<CardBadge> = emptyList(),
    sharedKey: String? = null,
    onLongClick: (() -> Unit)? = null,
    onFocus: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    Column(modifier.width(width), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Card(
            onClick = onClick,
            onLongClick = onLongClick,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .onFocusChanged { if (it.isFocused != focused) { focused = it.isFocused; if (it.isFocused) onFocus() } },
            shape = CardDefaults.shape(MixaiFocus.cardShape),
            colors = CardDefaults.colors(containerColor = Tokens.card, focusedContainerColor = Tokens.card),
            scale = mixaiCardScale(),
            border = mixaiCardBorder(),
            glow = cardGlow(),
        ) {
            Box(Modifier.fillMaxSize()) {
                val imgMod = Modifier.fillMaxSize().let { m -> if (sharedKey != null) m.sharedPoster(sharedKey) else m }
                if (imageUrl != null) AsyncImage(model = imageUrl, contentDescription = title, contentScale = ContentScale.Crop, modifier = imgMod)
                else Box(imgMod.background(Brush.linearGradient(listOf(Tokens.accent, Tokens.card))))
                if (badges.isNotEmpty()) {
                    Row(Modifier.align(Alignment.TopStart).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) { badges.take(3).forEach { BadgePill(it) } }
                }
                Column(
                    Modifier.align(Alignment.BottomStart).fillMaxWidth()
                        .background(Brush.verticalGradient(listOf(Color.Transparent, Tokens.background.copy(alpha = 0.85f))))
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (!caption.isNullOrBlank()) Text(caption, style = MaterialTheme.typography.labelMedium, color = Tokens.foreground, maxLines = 1)
                    if (progress != null && progress > 0f) CardProgress(progress)
                }
            }
        }
        Text(
            title,
            style = MaterialTheme.typography.titleSmall,
            color = if (focused) Tokens.foreground else Tokens.mutedForeground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
