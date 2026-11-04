package ro.mixai.tv.ui.music

import android.os.Build
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Border
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import ro.mixai.tv.R
import ro.mixai.tv.data.MusicRepository
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.nav.sharedPoster
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens
import ro.mixai.tv.ui.theme.mixaiCardBorder
import ro.mixai.tv.ui.theme.mixaiCardScale

// Shared building blocks of the music screens (WP16 music): square album tiles, round artist
// tiles, track rows, pills and the blurred-artwork backdrop. Token colours only.

internal val ALBUM_TILE: Dp = 196.dp
internal val ARTIST_TILE: Dp = 168.dp

/** Async load result used by every music screen. */
@Immutable
internal sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Ok<T>(val value: T) : Load<T>
    data class Err(val message: String) : Load<Nothing>
}

/** Shared-element key of an album cover (card ↔ album page). */
internal fun albumSharedKey(albumId: String): String = "album-$albumId"

/** Low-res cover (64 px) for backdrops: cheap to decode, upscaling softens it like a blur. */
internal fun MusicRepository.backdropCover(coverArt: String?): String? = coverUrl(coverArt, 64)

/** Seconds → `m:ss` / `h:mm:ss`. */
internal fun formatDuration(sec: Double): String = formatMs((sec * 1000).toLong())

internal fun formatMs(ms: Long): String {
    val total = (ms.coerceAtLeast(0) / 1000)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/**
 * Full-screen artwork backdrop: the cover blurred with a RenderEffect on API 31+, otherwise just
 * the (low-res, upscaled) cover under a stronger scrim.
 */
@Composable
internal fun BlurredArtwork(url: String?, modifier: Modifier = Modifier, dim: Float = 0.55f) {
    val blur = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    Box(modifier.fillMaxSize().background(Tokens.background)) {
        Crossfade(targetState = url, animationSpec = tween(500), label = "musicBackdrop") { u ->
            if (u != null) {
                AsyncImage(
                    model = u,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    alpha = 0.9f,
                    modifier = Modifier.fillMaxSize().graphicsLayer {
                        if (blur) renderEffect = BlurEffect(56f, 56f, TileMode.Clamp)
                    },
                )
            }
        }
        Box(Modifier.fillMaxSize().background(Tokens.background.copy(alpha = if (blur) dim else (dim + 0.2f).coerceAtMost(0.9f))))
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(0f to Color.Transparent, 0.7f to Tokens.background.copy(alpha = 0.35f), 1f to Tokens.background.copy(alpha = 0.85f)),
            ),
        )
    }
}

@Composable
private fun cardGlow() = CardDefaults.glow(focusedGlow = Glow(MixaiFocus.glowColor, MixaiFocus.glowElevation))

/** Square album / playlist tile with title + subtitle always visible (Apple Music style). */
@Composable
internal fun AlbumTile(
    imageUrl: String?,
    title: String,
    subtitle: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = ALBUM_TILE,
    sharedKey: String? = null,
    onFocus: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    Column(modifier.width(width), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Card(
            onClick = onClick,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .onFocusChanged { if (it.isFocused != focused) { focused = it.isFocused; if (it.isFocused) onFocus() } },
            shape = CardDefaults.shape(MixaiFocus.cardShape),
            colors = CardDefaults.colors(containerColor = Tokens.card, focusedContainerColor = Tokens.card),
            scale = mixaiCardScale(),
            border = mixaiCardBorder(),
            glow = cardGlow(),
        ) {
            val imgMod = Modifier.fillMaxSize().let { if (sharedKey != null) it.sharedPoster(sharedKey) else it }
            ArtworkOrPlaceholder(imageUrl, title, imgMod)
        }
        Spacer(Modifier.height(4.dp))
        Text(title, style = MaterialTheme.typography.titleSmall, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (!subtitle.isNullOrBlank()) {
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Cover image or a token gradient with a music glyph. */
@Composable
internal fun ArtworkOrPlaceholder(imageUrl: String?, description: String?, modifier: Modifier, icon: ImageVector = MixaiIcons.MusicNote) {
    if (imageUrl != null) {
        AsyncImage(model = imageUrl, contentDescription = description, contentScale = ContentScale.Crop, modifier = modifier)
    } else {
        Box(modifier.background(Brush.verticalGradient(listOf(Tokens.accent, Tokens.card))), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = Tokens.mutedForeground, modifier = Modifier.size(48.dp))
        }
    }
}

/** Round artist avatar tile. */
@Composable
internal fun ArtistTile(
    imageUrl: String?,
    name: String,
    subtitle: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = ARTIST_TILE,
    onFocus: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    Column(modifier.width(width), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Card(
            onClick = onClick,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .onFocusChanged { if (it.isFocused != focused) { focused = it.isFocused; if (it.isFocused) onFocus() } },
            shape = CardDefaults.shape(CircleShape),
            colors = CardDefaults.colors(containerColor = Tokens.card, focusedContainerColor = Tokens.card),
            scale = mixaiCardScale(),
            border = CardDefaults.border(focusedBorder = Border(BorderStroke(MixaiFocus.ringWidth, Tokens.ring), shape = CircleShape)),
            glow = cardGlow(),
        ) {
            ArtworkOrPlaceholder(imageUrl, name, Modifier.fillMaxSize().clip(CircleShape))
        }
        Spacer(Modifier.height(4.dp))
        Text(name, style = MaterialTheme.typography.titleSmall, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (!subtitle.isNullOrBlank()) {
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Pill button: top tabs, genre chips, letter bar, panel toggles. */
@Composable
internal fun PillButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    icon: ImageVector? = null,
    compact: Boolean = false,
) {
    Surface(
        onClick = onClick,
        modifier = modifier.height(if (compact) 36.dp else 44.dp),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(22.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) Tokens.foreground.copy(alpha = 0.18f) else Tokens.foreground.copy(alpha = 0.05f),
            contentColor = if (selected) Tokens.foreground else Tokens.mutedForeground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
            pressedContainerColor = Tokens.foreground,
            pressedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
    ) {
        Row(
            Modifier.fillMaxHeight().padding(horizontal = if (compact) 14.dp else 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
            Text(label, style = if (compact) MaterialTheme.typography.labelLarge else MaterialTheme.typography.titleSmall, maxLines = 1)
        }
    }
}

/** One row of a track list (album, artist top tracks, queue, search results). */
@Composable
internal fun TrackListItem(
    number: String,
    title: String,
    subtitle: String?,
    duration: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    hasLyrics: Boolean = false,
    coverUrl: String? = null,
    onFocus: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    Surface(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .height(60.dp)
            .onFocusChanged { if (it.isFocused != focused) { focused = it.isFocused; if (it.isFocused) onFocus() } },
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(10.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (active) Tokens.primary.copy(alpha = 0.18f) else Color.Transparent,
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
            pressedContainerColor = Tokens.foreground,
            pressedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.02f),
    ) {
        Row(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (coverUrl != null) {
                AsyncImage(coverUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(42.dp).clip(RoundedCornerShape(6.dp)))
            } else if (active && !focused) {
                Icon(MixaiIcons.Audiotrack, contentDescription = null, tint = Tokens.primary, modifier = Modifier.width(32.dp).size(20.dp))
            } else {
                Text(number, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(32.dp).alpha(0.7f), maxLines = 1)
            }
            Column(Modifier.weight(1f)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall,
                    color = if (active && !focused) Tokens.primary else androidx.compose.ui.graphics.Color.Unspecified,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (!subtitle.isNullOrBlank()) {
                    Text(subtitle, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.alpha(0.7f))
                }
            }
            if (hasLyrics) Icon(MixaiIcons.Lyrics, contentDescription = stringResource(R.string.music_has_lyrics), modifier = Modifier.size(18.dp).alpha(0.7f))
            Text(duration, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.alpha(0.8f), maxLines = 1)
        }
    }
}

/** Compact track card (cover + title + artist) for horizontal rows such as Most played. */
@Composable
internal fun TrackChip(
    coverUrl: String?,
    title: String,
    subtitle: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onFocus: () -> Unit = {},
) {
    Surface(
        onClick = onClick,
        modifier = modifier.width(320.dp).height(76.dp).onFocusChanged { if (it.isFocused) onFocus() },
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(12.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Tokens.card.copy(alpha = 0.85f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
            pressedContainerColor = Tokens.foreground,
            pressedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.05f),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(MixaiFocus.glowColor, 12.dp)),
    ) {
        Row(Modifier.fillMaxSize().padding(8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ArtworkOrPlaceholder(coverUrl, null, Modifier.size(60.dp).clip(RoundedCornerShape(8.dp)))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.alpha(0.7f))
            }
        }
    }
}

/** Row header with an optional trailing action (e.g. "Shuffle all"). */
@Composable
internal fun MusicRowHeader(title: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().padding(horizontal = MixaiFocus.overscan),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge, color = Tokens.foreground)
        action?.invoke()
    }
}
