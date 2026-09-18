package ro.mixai.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonPrimitive
import ro.mixai.tv.R
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MediaRepository
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.ProgressSync
import ro.mixai.tv.data.ProviderLauncher
import ro.mixai.tv.data.androidPackage
import ro.mixai.tv.data.generated.LibraryIndexRow
import ro.mixai.tv.data.generated.MediaTitleResponse
import ro.mixai.tv.data.generated.Offer
import ro.mixai.tv.data.generated.ProgressEntry
import ro.mixai.tv.player.PlayRequest
import ro.mixai.tv.ui.theme.Tokens

// Unified title page (WP12-01): TMDB details + local files ("Play from <server>") + provider
// buttons ("Where to watch") + "Mark watched". Watchlist lives on the web app only — no button here.

@Composable
fun TitleScreen(
    api: MmoApi,
    media: MediaRepository,
    progressSync: ProgressSync,
    kind: String,
    tmdbId: Long,
    onPlay: (PlayRequest, MediaRef, resumeMs: Long) -> Unit,
    onOpenTitle: (kind: String, tmdbId: Long) -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<MediaTitleResponse?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var watched by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val firstFocus = remember { FocusRequester() }

    LaunchedEffect(kind, tmdbId) {
        data = null; error = null
        try { data = media.title(kind, tmdbId) } catch (e: Exception) { error = e.message ?: "error" }
    }
    LaunchedEffect(data) { if (data != null) { delay(50); runCatching { firstFocus.requestFocus() } } }

    val d = data
    if (d == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            if (error != null) EmptyState("⚠", stringResource(R.string.home_load_failed), error, tone = EmptyTone.Error)
            else SkeletonRow(count = 1, width = 480.dp, height = 270.dp)
        }
        return
    }
    val t = d.title
    val kindLabel = stringResource(if (t.kind == "tv") R.string.media_kind_tv else R.string.media_kind_movie)
    val meta = listOfNotNull(
        t.releaseDate?.take(4), kindLabel,
        t.runtime?.takeIf { it > 0 }?.let { stringResource(R.string.movie_duration, (it / 60).toInt(), (it % 60).toInt()) },
        t.numberOfSeasons?.takeIf { it > 0 }?.let { stringResource(R.string.home_seasons, it.toInt()) },
        t.certification?.takeIf { it.isNotBlank() },
        t.voteAverage?.takeIf { it > 0 }?.let { "★ %.1f".format(it) },
    ).joinToString(" · ")
    val genres = t.genres.mapNotNull { it["name"]?.jsonPrimitive?.content }.joinToString(", ")
    val ref = MediaRef(t.kind, t.tmdbId)
    // Best progress entry for this title (movie: the only one; tv: latest episode).
    val prog: ProgressEntry? = d.progress.filter { !it.completed }.maxByOrNull { it.updatedAt }
    val completed = watched || (d.progress.isNotEmpty() && d.progress.all { it.completed })

    Box(Modifier.fillMaxSize()) {
        AsyncImage(
            model = api.tmdbImageUrl("w1280", t.backdropPath ?: t.posterPath), contentDescription = null,
            contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().alpha(0.35f),
        )
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Tokens.background.copy(alpha = 0.2f), 0.6f to Tokens.background)))

        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 64.dp, vertical = 48.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(40.dp)) {
                Box(Modifier.size(POSTER_W * 1.5f, POSTER_H * 1.5f).clip(RoundedCornerShape(12.dp)).background(Tokens.card)) {
                    AsyncImage(model = api.tmdbImageUrl("w500", t.posterPath), contentDescription = t.title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    if (prog != null && prog.durationSec > 0) ProgressBar((prog.positionSec / prog.durationSec).toFloat(), Modifier.align(Alignment.BottomCenter))
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    val logo = api.tmdbImageUrl("w500", t.logoPath)
                    if (logo != null) AsyncImage(model = logo, contentDescription = t.title, modifier = Modifier.height(96.dp).wrapContentWidth(), contentScale = ContentScale.Fit)
                    else Text(t.title, style = MaterialTheme.typography.displaySmall, color = Tokens.foreground, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    t.tagline?.takeIf { it.isNotBlank() }?.let { Text(it, color = Tokens.mutedForeground, style = MaterialTheme.typography.titleMedium) }
                    Text(meta, color = Tokens.mutedForeground, style = MaterialTheme.typography.titleMedium)
                    if (genres.isNotBlank()) Text(genres, color = Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium)
                    t.overview?.takeIf { it.isNotBlank() }?.let { Text(it, color = Tokens.foreground, style = MaterialTheme.typography.bodyLarge, maxLines = 6, overflow = TextOverflow.Ellipsis) }
                    val cast = t.cast.take(6).joinToString { it.name }
                    if (cast.isNotBlank()) Text(stringResource(R.string.title_cast, cast), color = Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (completed) Badge(stringResource(R.string.title_watched))

                    // ── Sources: one "Play from <server>" per local file ─────────
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(R.string.title_sources), style = MaterialTheme.typography.titleMedium, color = Tokens.foreground)
                    if (d.files.isEmpty()) {
                        Text(stringResource(R.string.title_no_local), color = Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium)
                    } else Row(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        d.files.sortedWith(compareBy({ it.season ?: 0 }, { it.episode ?: 0 })).forEachIndexed { i, row ->
                            val epRef = if (row.season != null || row.episode != null) ref.copy(season = row.season, episode = row.episode) else ref
                            val p = d.progress.firstOrNull { !it.completed && it.season == (row.season ?: 0L) && it.episode == (row.episode ?: 0L) }
                            val resumeMs = p?.let { (it.positionSec * 1000).toLong() } ?: 0L
                            Button(
                                onClick = {
                                    if (busy) return@Button
                                    busy = true
                                    scope.launch {
                                        try {
                                            val f = api.fileInfo(row.serverFileId)
                                            onPlay(PlayRequest.Video(f, hls = !f.directPlayable), epRef, resumeMs)
                                        } catch (e: Exception) { error = e.message } finally { busy = false }
                                    }
                                },
                                modifier = if (i == 0) Modifier.focusRequester(firstFocus) else Modifier,
                            ) {
                                Text(playLabel(row, d.serverName, resumeMs))
                            }
                        }
                    }

                    // ── Where to watch ───────────────────────────────────────
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(R.string.title_where), style = MaterialTheme.typography.titleMedium, color = Tokens.foreground)
                    if (d.availability.offers.isEmpty()) {
                        Text(stringResource(R.string.title_no_offers), color = Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium)
                    } else {
                        Row(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            d.availability.offers.distinctBy { it.providerId to it.type }.take(8).forEachIndexed { i, offer ->
                                OfferButton(
                                    api, offer,
                                    modifier = if (i == 0 && d.files.isEmpty()) Modifier.focusRequester(firstFocus) else Modifier,
                                    onClick = { ProviderLauncher.launch(context, offer) },
                                )
                            }
                        }
                        if (d.availability.attribution.isNotEmpty()) Text(
                            stringResource(R.string.title_attribution, d.availability.attribution.joinToString(", ")),
                            color = Tokens.mutedForeground, style = MaterialTheme.typography.bodySmall,
                        )
                    }

                    // ── Actions ──────────────────────────────────────────────
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (!completed) OutlinedButton(onClick = {
                            scope.launch { progressSync.markWatched(ref, t.runtime?.let { it * 60.0 }); watched = true }
                        }) { Text(stringResource(R.string.title_mark_watched)) }
                        OutlinedButton(
                            onClick = onBack,
                            modifier = if (d.files.isEmpty() && d.availability.offers.isEmpty()) Modifier.focusRequester(firstFocus) else Modifier,
                        ) { Text(stringResource(R.string.action_back)) }
                    }
                    if (error != null) Text(error!!, color = Tokens.destructive, style = MaterialTheme.typography.bodySmall)
                }
            }

            // ── Similar / recommendations ────────────────────────────────────
            val more = (t.recommendations + t.similar).distinctBy { it.kind to it.tmdbId }.take(20)
            if (more.isNotEmpty()) {
                Spacer(Modifier.height(32.dp))
                Text(stringResource(R.string.title_similar), style = MaterialTheme.typography.titleLarge, color = Tokens.foreground, modifier = Modifier.padding(vertical = 12.dp))
                LazyRow(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    items(more, key = { "${it.kind}/${it.tmdbId}" }) { c ->
                        TitlePosterCard(api, c, onClick = { onOpenTitle(c.kind, c.tmdbId) })
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun playLabel(row: LibraryIndexRow, serverName: String, resumeMs: Long): String {
    val ep = when {
        row.season != null && row.episode != null -> "S%02dE%02d · ".format(row.season, row.episode)
        else -> ""
    }
    val base = stringResource(R.string.title_play_from, serverName.ifBlank { stringResource(R.string.common_mmo_server) })
    return if (resumeMs > 0) "▶  $ep$base · ${clock(resumeMs)}" else "▶  $ep$base"
}

/** Provider button: logo (`w92`) + name + offer type; greyed with "Install" when the app is missing. */
@Composable
private fun OfferButton(api: MmoApi, offer: Offer, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val context = LocalContext.current
    val pkg = offer.launch.androidPackage
    val installed = remember(pkg) { pkg == null || ProviderLauncher.isInstalled(context, pkg) }
    val typeLabel = stringResource(
        when (offer.type) {
            "subscription" -> R.string.offer_subscription
            "rent" -> R.string.offer_rent
            "buy" -> R.string.offer_buy
            "free" -> R.string.offer_free
            "ads" -> R.string.offer_ads
            else -> R.string.offer_subscription
        },
    )
    OutlinedButton(onClick = onClick, modifier = modifier.alpha(if (installed) 1f else 0.6f)) {
        val logo = api.tmdbImageUrl("w92", offer.logo)
        if (logo != null) {
            AsyncImage(model = logo, contentDescription = null, modifier = Modifier.size(28.dp).clip(RoundedCornerShape(6.dp)))
            Spacer(Modifier.width(10.dp))
        }
        Column {
            Text(offer.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
            Text(
                if (installed) typeLabel else stringResource(R.string.offer_install),
                style = MaterialTheme.typography.labelSmall, color = Tokens.mutedForeground, maxLines = 1,
            )
        }
    }
}
