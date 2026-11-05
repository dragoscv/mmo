package ro.mixai.app.ui.title

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import ro.mixai.app.R
import ro.mixai.app.ui.theme.Mixai
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.Offer
import ro.mixai.tv.data.generated.Person
import ro.mixai.tv.data.generated.SeasonEpisode

// Title page building blocks: episode row, cast avatar, provider offer button.

/** One episode: still (TMDB, else server still of the first file), name, runtime, progress. */
@Composable
fun EpisodeRow(api: MmoApi, e: SeasonEpisode, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val available = e.files.isNotEmpty()
    val p = e.progress
    val frac = if (p != null && !p.completed && p.durationSec > 0) (p.positionSec / p.durationSec).toFloat().coerceIn(0f, 1f) else null
    Row(
        modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp).alpha(if (available) 1f else 0.55f),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(140.dp).aspectRatio(16f / 9f).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
            val url = api.tmdbImageUrl(TmdbSize.backdrop(300), e.stillPath) ?: e.files.firstOrNull()?.let { api.stillUrl(it.serverFileId) }
            if (url != null) AsyncImage(url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            if (available) {
                Icon(
                    Icons.Filled.PlayArrow, contentDescription = null, tint = Mixai.colors.onScrim,
                    modifier = Modifier.align(Alignment.Center).size(32.dp).clip(CircleShape).background(Mixai.colors.scrimBase.copy(alpha = 0.5f)).padding(4.dp),
                )
            }
            if (frac != null && frac > 0f) LinearProgressIndicator(progress = { frac }, modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(3.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val name = e.name.ifBlank { stringResource(R.string.title_episode_fallback, e.episodeNumber.toInt()) }
            Text(
                stringResource(R.string.title_episode_name, e.episodeNumber.toInt(), name),
                style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            val meta = listOfNotNull(runtimeLabel(e.runtime), e.airDate?.take(10)).joinToString(" · ")
            if (meta.isNotEmpty()) Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            e.overview?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (p?.completed == true) {
            Icon(Icons.Filled.CheckCircle, contentDescription = stringResource(R.string.title_watched), tint = Mixai.colors.success, modifier = Modifier.size(20.dp))
        }
    }
}

/** Round cast avatar + name + role. */
@Composable
fun CastItem(api: MmoApi, person: Person, modifier: Modifier = Modifier) {
    Column(modifier.width(88.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(76.dp).clip(CircleShape).background(MaterialTheme.colorScheme.secondaryContainer), contentAlignment = Alignment.Center) {
            val img = api.tmdbImageUrl(TmdbSize.poster(185), person.profilePath)
            if (img != null) {
                AsyncImage(img, contentDescription = person.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            } else {
                Text(person.name.take(1), style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSecondaryContainer)
            }
        }
        Text(person.name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        if (person.role.isNotBlank()) {
            Text(
                person.role, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** Provider button: logo + name + offer type ("Install" when the phone app is missing). */
@Composable
fun OfferButton(api: MmoApi, offer: Offer, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val pkg = remember(offer) { PhoneProviderLauncher.phonePackage(offer) }
    val installed = remember(pkg) { pkg == null || PhoneProviderLauncher.isInstalled(context, pkg) }
    val type = stringResource(
        when (offer.type) {
            "rent" -> R.string.title_offer_rent
            "buy" -> R.string.title_offer_buy
            "free" -> R.string.title_offer_free
            "ads" -> R.string.title_offer_ads
            else -> R.string.title_offer_subscription
        },
    )
    FilledTonalButton(onClick = { PhoneProviderLauncher.launch(context, offer) }, modifier = modifier) {
        val logo = offer.logo?.takeIf { it.startsWith("/") }?.let { api.tmdbImageUrl(TmdbSize.poster(185), it) } ?: offer.logo?.takeIf { it.startsWith("http") }
        if (logo != null) {
            AsyncImage(logo, contentDescription = null, modifier = Modifier.size(28.dp).clip(MaterialTheme.shapes.extraSmall))
            Spacer(Modifier.width(10.dp))
        }
        Column {
            Text(offer.name, style = MaterialTheme.typography.labelLarge, maxLines = 1)
            Text(if (installed) type else stringResource(R.string.title_offer_install), style = MaterialTheme.typography.labelSmall, maxLines = 1)
        }
    }
}
