package ro.mixai.tv.ui

import androidx.compose.animation.Crossfade
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.Card
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.generated.HomeRow
import ro.mixai.tv.data.generated.TitleCard
import ro.mixai.tv.data.titleFor
import ro.mixai.tv.ui.theme.Tokens
import ro.mixai.tv.ui.theme.mixaiCardBorder
import ro.mixai.tv.ui.theme.mixaiCardColors
import ro.mixai.tv.ui.theme.mixaiCardScale

// Media Home building blocks (WP12-01): hero billboard + poster rows fed by `/media/home`.

val POSTER_W = 180.dp
val POSTER_H = 270.dp // 2:3
private const val HERO_ROTATE_MS = 12_000L

fun TitleCard.yearLabel(): String? = releaseDate?.take(4)?.takeIf { it.length == 4 }

fun TitleCard.metaLine(kindLabel: String): String = listOfNotNull(
    yearLabel(), kindLabel,
    voteAverage?.takeIf { it > 0 }?.let { "★ %.1f".format(it) },
).joinToString(" · ")

/** Full-bleed hero with the row's first items rotating every 12 s; CTA = "Play" (in library) or "Where to watch". */
@Composable
fun HeroBillboard(
    api: MmoApi,
    items: List<TitleCard>,
    onOpen: (TitleCard) -> Unit,
    modifier: Modifier = Modifier,
    firstFocus: Modifier = Modifier,
) {
    if (items.isEmpty()) return
    var index by remember(items) { mutableIntStateOf(0) }
    LaunchedEffect(items) {
        while (items.size > 1) { delay(HERO_ROTATE_MS); index = (index + 1) % items.size }
    }
    val card = items[index]
    Box(modifier.fillMaxWidth().height(440.dp)) {
        Crossfade(targetState = card, label = "hero") { c ->
            AsyncImage(
                model = api.tmdbImageUrl("w1280", c.backdropPath ?: c.posterPath),
                contentDescription = null, contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Tokens.background, Tokens.background.copy(alpha = 0.55f), Tokens.background.copy(alpha = 0f)))))
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Tokens.background.copy(alpha = 0f), 1f to Tokens.background)))
        Column(Modifier.align(Alignment.BottomStart).padding(horizontal = 56.dp, vertical = 32.dp).width(720.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(card.title, style = MaterialTheme.typography.displaySmall, color = Tokens.foreground, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                card.metaLine(stringResource(if (card.kind == "tv") R.string.media_kind_tv else R.string.media_kind_movie)),
                color = Tokens.mutedForeground, style = MaterialTheme.typography.titleMedium,
            )
            card.overview?.takeIf { it.isNotBlank() }?.let {
                Text(it, color = Tokens.foreground.copy(alpha = 0.85f), style = MaterialTheme.typography.bodyLarge, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = { onOpen(card) }, modifier = firstFocus) {
                    Text(stringResource(if (card.inLibrary == true) R.string.media_cta_play else R.string.media_cta_where))
                }
                if (items.size > 1) OutlinedButton(onClick = { index = (index + 1) % items.size }) { Text(stringResource(R.string.media_hero_next)) }
            }
        }
        if (items.size > 1) Row(Modifier.align(Alignment.BottomEnd).padding(horizontal = 56.dp, vertical = 40.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items.indices.forEach { i ->
                Box(Modifier.size(if (i == index) 18.dp else 8.dp, 8.dp).clip(RoundedCornerShape(4.dp)).background(if (i == index) Tokens.primary else Tokens.muted))
            }
        }
    }
}

/** One `HomeRow` as a header + focus-restoring `LazyRow` of 2:3 posters. */
@Composable
fun MediaRowView(
    api: MmoApi,
    row: HomeRow,
    lang: String,
    onOpen: (TitleCard) -> Unit,
    firstItemModifier: Modifier = Modifier,
) {
    if (row.items.isEmpty()) return
    Row(Modifier.padding(horizontal = 56.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(row.titleFor(lang), style = MaterialTheme.typography.titleLarge, color = Tokens.foreground)
        Spacer(Modifier.width(12.dp))
        Text("${row.items.size}", color = Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium)
        // `reason` may be a machine key (`cold_start`) — only show human sentences.
        row.reason?.takeIf { it.isNotBlank() && it.contains(' ') }?.let {
            Spacer(Modifier.width(12.dp))
            Text(it, color = Tokens.mutedForeground, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    LazyRow(
        modifier = Modifier.focusRestorer(),
        contentPadding = PaddingValues(horizontal = 56.dp),
        horizontalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        items(row.items, key = { "${row.id}/${it.kind}/${it.tmdbId}" }) { card ->
            TitlePosterCard(api, card, modifier = if (card === row.items.first()) firstItemModifier else Modifier, onClick = { onOpen(card) })
        }
    }
}

@Composable
fun TitlePosterCard(api: MmoApi, card: TitleCard, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Column(modifier.width(POSTER_W)) {
        Card(
            onClick = onClick, modifier = Modifier.size(POSTER_W, POSTER_H),
            colors = mixaiCardColors(), border = mixaiCardBorder(), scale = mixaiCardScale(),
        ) {
            Box(Modifier.fillMaxSize()) {
                val url = api.tmdbImageUrl("w342", card.posterPath)
                if (url != null) {
                    AsyncImage(model = url, contentDescription = card.title, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                } else {
                    Box(Modifier.fillMaxSize().padding(12.dp), contentAlignment = Alignment.BottomStart) {
                        Text(card.title, color = Tokens.foreground, style = MaterialTheme.typography.titleMedium, maxLines = 5, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (card.inLibrary == true) Badge(stringResource(R.string.media_badge_library), Modifier.align(Alignment.TopStart).padding(8.dp))
                card.progress?.takeIf { it > 0.0 }?.let { ProgressBar(it.toFloat(), Modifier.align(Alignment.BottomCenter)) }
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(card.title, color = Tokens.foreground, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val sub = listOfNotNull(card.yearLabel(), card.voteAverage?.takeIf { it > 0 }?.let { "★ %.1f".format(it) }).joinToString(" · ")
        if (sub.isNotBlank()) Text(sub, color = Tokens.mutedForeground, style = MaterialTheme.typography.bodySmall, maxLines = 1)
    }
}

@Composable
fun Badge(text: String, modifier: Modifier = Modifier) {
    Box(modifier.clip(RoundedCornerShape(6.dp)).background(Tokens.primary).padding(horizontal = 8.dp, vertical = 3.dp)) {
        Text(text, color = Tokens.primaryForeground, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
    }
}

/** Placeholder while `/media/home` loads: hero block + two poster rows. */
@Composable
fun MediaHomeSkeleton() {
    Box(Modifier.fillMaxWidth().height(440.dp).background(Tokens.card))
    Spacer(Modifier.height(24.dp))
    repeat(2) {
        Box(Modifier.padding(horizontal = 56.dp, vertical = 12.dp).size(220.dp, 28.dp).background(Tokens.muted))
        SkeletonRow(count = 7, width = POSTER_W, height = POSTER_H)
        Spacer(Modifier.height(36.dp))
    }
}
