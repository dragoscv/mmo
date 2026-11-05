package ro.mixai.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import ro.mixai.app.ui.media.cardKey
import ro.mixai.app.ui.media.posterKey
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.TitleCard

/** 2:3 poster with title under it; optional progress bar. Shared-element key = posterKey(kind, id). */
@Composable
fun PosterCard(
    api: MmoApi,
    card: TitleCard,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = 120.dp,
    showTitle: Boolean = true,
    sharedKey: String? = posterKey(card.kind, card.tmdbId),
) {
    Column(modifier.width(width).clip(MaterialTheme.shapes.small).clickable(onClick = onClick)) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(2f / 3f)
                .then(if (sharedKey != null) Modifier.sharedPoster(sharedKey) else Modifier)
                .clip(MaterialTheme.shapes.small)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh),
        ) {
            val url = api.tmdbImageUrl(TmdbSize.poster(342), card.posterPath)
            if (url != null) AsyncImage(url, contentDescription = card.title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            else Text(card.title, Modifier.align(Alignment.Center).padding(8.dp), style = MaterialTheme.typography.labelMedium, maxLines = 4)
            val p = card.progress
            if (p != null && p > 0.0) LinearProgressIndicator(
                progress = { p.toFloat().coerceIn(0f, 1f) },
                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(3.dp),
            )
        }
        if (showTitle) {
            Spacer(Modifier.height(6.dp))
            Text(card.title, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** 16:9 still/backdrop card (continue watching). */
@Composable
fun LandscapeCard(api: MmoApi, card: TitleCard, subtitle: String?, onClick: () -> Unit, modifier: Modifier = Modifier, width: Dp = 240.dp) {
    Column(modifier.width(width).clip(MaterialTheme.shapes.small).clickable(onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
            val url = api.tmdbImageUrl(TmdbSize.backdrop(780), card.backdropPath ?: card.posterPath)
            if (url != null) AsyncImage(url, contentDescription = card.title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            val p = card.progress
            if (p != null && p > 0.0) LinearProgressIndicator(
                progress = { p.toFloat().coerceIn(0f, 1f) },
                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(3.dp),
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(card.title, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
}

/** Section title + horizontally scrolling cards. */
@Composable
fun CardRow(title: String, cards: List<TitleCard>, modifier: Modifier = Modifier, item: @Composable (TitleCard) -> Unit) {
    // Server rows can repeat a title (e.g. two files of one film); LazyRow keys must be unique.
    val unique = androidx.compose.runtime.remember(cards) { cards.distinctBy { cardKey(it) } }
    Column(modifier.fillMaxWidth()) {
        Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 10.dp))
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            items(unique, key = { cardKey(it) }) { item(it) }
        }
    }
}

/** Small rounded label (year, age, 4K…). */
@Composable
fun Chip(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.clip(MaterialTheme.shapes.extraSmall).background(MaterialTheme.colorScheme.surfaceContainerHighest.copy(alpha = 0.8f)).padding(horizontal = 8.dp, vertical = 3.dp),
        style = MaterialTheme.typography.labelSmall,
    )
}

/** Wrapping-free chip row. */
@Composable
fun ChipRow(items: List<String>, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { items.forEach { Chip(it) } }
}
