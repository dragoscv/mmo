package ro.mixai.tv.ui.title

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.MediaSeasonResponse
import ro.mixai.tv.data.generated.MediaTitleResponse
import ro.mixai.tv.data.generated.SeasonEpisode
import ro.mixai.tv.ui.components.BadgePill
import ro.mixai.tv.ui.components.BadgeTone
import ro.mixai.tv.ui.components.CardBadge
import ro.mixai.tv.ui.components.CardProgress
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.LocalBackdrop
import ro.mixai.tv.ui.components.formatRuntime
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.nav.rememberRestorableFocus
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

// Full season page (WP16-19): season tabs + vertical list of episodes with large stills,
// overview, runtime, progress and "on server"; Enter plays the best version (resume aware).

@Composable
fun SeasonScreen(deps: ScreenDeps, nav: Navigator, tmdbId: Long, season: Long) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val backdrop = LocalBackdrop.current
    val density = LocalDensity.current
    val backdropPx = with(density) { 1280.dp.roundToPx() }
    val stillPx = with(density) { 360.dp.roundToPx() }
    val rf = rememberRestorableFocus("season")

    var title by remember { mutableStateOf<MediaTitleResponse?>(null) }
    var selected by rememberSaveable { mutableStateOf(season) }
    var data by remember { mutableStateOf<MediaSeasonResponse?>(null) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(tmdbId) {
        runCatching { deps.media.title("tv", tmdbId) }.onSuccess { t ->
            title = t
            backdrop.show(deps.api.tmdbImageUrl(TmdbSize.backdrop(backdropPx), t.title.backdropPath ?: t.title.posterPath))
        }
    }
    LaunchedEffect(selected, reload) {
        error = null
        data = null
        try {
            data = deps.media.season(tmdbId, selected)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e
        }
    }
    LaunchedEffect(data) { if (data != null) rf.restoreFocus() }

    fun play(tg: PlayTarget) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                startPlayback(deps, nav, tg)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                toast(context, context.getString(R.string.wp16_title_play_failed, e.message ?: ""))
            } finally {
                busy = false
            }
        }
    }

    val t = title?.title
    val seasons = remember(t) { orderedSeasons(t?.seasons.orEmpty().map { it.seasonNumber }.ifEmpty { listOf(season) }) }
    val d = data
    val err = error

    LazyColumn(
        state = rememberLazyListState(),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = MixaiFocus.overscanTop, bottom = 56.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item("head") {
            Column(Modifier.padding(horizontal = MixaiFocus.overscan), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (t != null) TitleLogo(deps.api, t.logoPath, t.title, height = 72.dp, maxWidth = 420.dp)
                Text(
                    d?.name?.takeIf { it.isNotBlank() } ?: seasonLabel(selected, null),
                    style = MaterialTheme.typography.headlineMedium,
                    color = Tokens.foreground,
                )
                d?.overview?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 900.dp))
                }
            }
        }
        if (seasons.size > 1) item("tabs") {
            LazyRow(
                Modifier.fillMaxWidth().focusRestorer(),
                contentPadding = PaddingValues(horizontal = MixaiFocus.overscan, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(seasons, key = { it }) { s ->
                    TvPill(
                        label = seasonLabel(s, t?.seasons?.firstOrNull { it.seasonNumber == s }?.name),
                        selected = s == selected,
                        onClick = { selected = s },
                        modifier = rf.item("tab:$s"),
                    )
                }
            }
        }
        when {
            d != null -> items(d.episodes, key = { "${it.seasonNumber}-${it.episodeNumber}" }) { e ->
                val isFirst = e == d.episodes.firstOrNull()
                val mod = rf.item("ep:${e.seasonNumber}:${e.episodeNumber}").let { if (isFirst) it.focusRequester(rf.requester) else it }
                EpisodeRow(deps, e, stillPx, onClick = { playEpisode(context, tmdbId, e) { play(it) } }, modifier = mod)
            }
            err != null -> item("err") {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    TitleError(err, onRetry = { reload++ }, onBack = { nav.pop() })
                }
            }
            else -> item("loading") { LoadingState(rows = 1, hero = false) }
        }
        if (d != null && d.episodes.isEmpty()) item("empty") {
            Text(stringResource(R.string.wp16_title_no_episodes), style = MaterialTheme.typography.bodyLarge, color = Tokens.mutedForeground, modifier = Modifier.padding(horizontal = MixaiFocus.overscan))
        }
        if (t != null) item("open-title") {
            Row(Modifier.padding(horizontal = MixaiFocus.overscan)) {
                TvPill(stringResource(R.string.wp16_title_open_show), selected = false, onClick = { nav.push(Route.Title("tv", tmdbId)) }, modifier = rf.item("open"))
            }
        }
    }
}

@Composable
private fun EpisodeRow(deps: ScreenDeps, e: SeasonEpisode, stillPx: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val p = e.progress
    val frac = if (p != null && !p.completed && p.durationSec > 0) (p.positionSec / p.durationSec).toFloat() else null
    Surface(
        onClick = onClick,
        modifier = modifier.padding(horizontal = MixaiFocus.overscan).fillMaxWidth(),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(14.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Tokens.foreground.copy(alpha = 0.04f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground.copy(alpha = 0.14f),
            focusedContentColor = Tokens.foreground,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.02f),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(MixaiFocus.glowColor, 12.dp)),
        border = ClickableSurfaceDefaults.border(
            focusedBorder = androidx.tv.material3.Border(androidx.compose.foundation.BorderStroke(MixaiFocus.ringWidth, Tokens.ring), shape = RoundedCornerShape(14.dp)),
        ),
    ) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
            Box {
                EpisodeStill(deps.api.tmdbImageUrl(TmdbSize.backdrop(stillPx), e.stillPath))
                if (frac != null) CardProgress(frac, Modifier.align(Alignment.BottomCenter).padding(8.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    stringResource(R.string.wp16_title_episode_name, e.episodeNumber, e.name.ifBlank { stringResource(R.string.wp16_title_episode_fallback, e.episodeNumber) }),
                    style = MaterialTheme.typography.titleLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val meta = listOfNotNull(e.airDate?.take(10), e.runtime?.takeIf { it > 0 }?.let { formatRuntime(it) }).joinToString(" · ")
                if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
                e.overview?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (e.files.isNotEmpty()) BadgePill(CardBadge(stringResource(R.string.wp16_title_on_server), BadgeTone.Success))
                    e.files.maxByOrNull { it.version.rank }?.version?.label?.takeIf { it.isNotBlank() }?.let { BadgePill(CardBadge(it)) }
                    if (p?.completed == true) BadgePill(CardBadge(stringResource(R.string.wp16_title_watched)))
                }
            }
        }
    }
}
