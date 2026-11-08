package ro.mixai.tv.ui.settings

import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.Request
import ro.mixai.tv.R
import ro.mixai.tv.data.Http
import androidx.compose.ui.platform.LocalContext
import ro.mixai.tv.data.MusicHandoff
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.MediaStats
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.NoBackdrop
import ro.mixai.tv.ui.components.PosterCard
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.RowTitle
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens
import java.text.DateFormatSymbols
import java.util.Calendar
import java.util.Locale

// ─── typed view of MediaStats (watch/listen are loose JsonObjects in the generated model) ───

data class StatsTitle(val kind: String, val tmdbId: Long, val title: String, val hours: Double)
data class StatsGenre(val name: String, val hours: Double)
data class StatsTrack(val trackKey: String, val plays: Long)

data class YearStats(
    val year: Int,
    val hours: Double,
    val titles: Long,
    val movies: Long,
    val episodes: Long,
    val completed: Long,
    val streakDays: Long,
    val watchByMonth: List<Double>,
    val topGenres: List<StatsGenre>,
    val topTitles: List<StatsTitle>,
    val listenHours: Double,
    val plays: Long,
    val listenByMonth: List<Double>,
    val topTracks: List<StatsTrack>,
) {
    val isEmpty: Boolean get() = hours <= 0.0 && titles == 0L && plays == 0L
}

private fun JsonObject.d(k: String) = this[k]?.jsonPrimitive?.doubleOrNull ?: 0.0
private fun JsonObject.l(k: String) = this[k]?.jsonPrimitive?.longOrNull ?: 0L
private fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.contentOrNull ?: ""
private fun JsonObject.arr(k: String): List<JsonElement> = runCatching { this[k]?.jsonArray?.toList() }.getOrNull().orEmpty()
private fun months(list: List<JsonElement>) = List(12) { i -> list.getOrNull(i)?.jsonPrimitive?.doubleOrNull ?: 0.0 }

fun MediaStats.typed(): YearStats {
    val w = watch
    val li = listen
    return YearStats(
        year = year.toInt(),
        hours = w.d("hours"), titles = w.l("titles"), movies = w.l("movies"), episodes = w.l("episodes"),
        completed = w.l("completed"), streakDays = w.l("longestStreakDays"),
        watchByMonth = months(w.arr("byMonth")),
        topGenres = w.arr("topGenres").map { it.jsonObject }.map { StatsGenre(it.s("name"), it.d("hours")) },
        topTitles = w.arr("topTitles").map { it.jsonObject }.map { StatsTitle(it.s("kind"), it.l("tmdbId"), it.s("title"), it.d("hours")) },
        listenHours = li.d("hours"), plays = li.l("plays"),
        listenByMonth = months(li.arr("byMonth")),
        topTracks = li.arr("topTracks").map { it.jsonObject }.map { StatsTrack(it.s("trackKey"), it.l("plays")) },
    )
}

private sealed interface StatsState {
    data object Loading : StatsState
    data class Ready(val stats: YearStats) : StatsState
    data class Error(val message: String) : StatsState
}

private data class TrackInfo(val title: String, val artist: String?, val cover: String?)

private val statsJson = Json { ignoreUnknownKeys = true }

/** Subsonic id for a `track_plays.track_key` (`tr_42`, `42`, `srv:track:42`); sha256 keys → null. */
internal fun subsonicTrackId(key: String): String? {
    val k = key.trim()
    Regex("^(?:subsonic:)?tr_(\\d+)$", RegexOption.IGNORE_CASE).find(k)?.let { return "tr_${it.groupValues[1]}" }
    Regex("^(?:[^:]*:)?track:(\\d+)$", RegexOption.IGNORE_CASE).find(k)?.let { return "tr_${it.groupValues[1]}" }
    Regex("^(\\d+)$").find(k)?.let { return "tr_${it.groupValues[1]}" }
    return null
}

/**
 * Year in review (WP16-28) from `GET /media/stats?year=`: big numbers, a month bar chart drawn on a
 * Canvas (token chart colours), top genres, top titles (posters via a cached title lookup),
 * listening hours + top tracks; year picker; loading / empty / error states.
 */
@Composable
fun StatsScreen(deps: ScreenDeps, nav: Navigator) {
    NoBackdrop()
    val context = LocalContext.current
    val thisYear = remember { Calendar.getInstance().get(Calendar.YEAR) }
    var year by rememberSaveable { mutableIntStateOf(thisYear) }
    var reload by remember { mutableIntStateOf(0) }
    var state by remember { mutableStateOf<StatsState>(StatsState.Loading) }
    val posters = remember { mutableStateMapOf<String, String?>() }
    val tracks = remember { mutableStateMapOf<String, TrackInfo?>() }
    val yearFocus = remember { FocusRequester() }

    LaunchedEffect(year, reload) {
        state = StatsState.Loading
        state = runCatching { deps.media.stats(year).typed() }.fold({ StatsState.Ready(it) }, { StatsState.Error(it.message ?: it.javaClass.simpleName) })
        delay(60); runCatching { yearFocus.requestFocus() }
    }
    val ready = (state as? StatsState.Ready)?.stats
    LaunchedEffect(ready) {
        ready ?: return@LaunchedEffect
        for (t in ready.topTitles) {
            val k = "${t.kind}:${t.tmdbId}"
            if (k in posters) continue
            posters[k] = runCatching { deps.media.title(t.kind, t.tmdbId).title.posterPath }.getOrNull()?.let { deps.api.tmdbImageUrl(TmdbSize.poster(240), it) }
        }
        for (t in ready.topTracks.take(10)) {
            if (t.trackKey in tracks) continue
            val id = subsonicTrackId(t.trackKey)
            tracks[t.trackKey] = if (id == null) null else runCatching { fetchTrack(deps, id) }.getOrNull()
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = MixaiFocus.overscanTop, bottom = 40.dp),
        verticalArrangement = Arrangement.spacedBy(28.dp),
    ) {
        Column(Modifier.padding(horizontal = MixaiFocus.overscan), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(stringResource(R.string.stats_title), style = MaterialTheme.typography.displaySmall, color = Tokens.foreground)
            LazyRow(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                itemsIndexed((thisYear downTo thisYear - 5).toList()) { _, y ->
                    OptionChip(y.toString(), y == year, { year = y }, if (y == year) Modifier.focusRequester(yearFocus) else Modifier)
                }
            }
        }
        when (val s = state) {
            StatsState.Loading -> LoadingState(Modifier.padding(horizontal = MixaiFocus.overscan), rows = 1, hero = true)
            is StatsState.Error -> ErrorState(s.message, onRetry = { reload++ }, modifier = Modifier.padding(horizontal = MixaiFocus.overscan))
            is StatsState.Ready -> if (s.stats.isEmpty) {
                Column(Modifier.padding(horizontal = MixaiFocus.overscan), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.stats_empty, year), style = MaterialTheme.typography.headlineSmall, color = Tokens.foreground)
                    Text(stringResource(R.string.stats_empty_hint), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
                    PrimaryButton(stringResource(R.string.wp16_nav_home), { nav.resetTo(Route.Home) })
                }
            } else StatsBody(s.stats, posters, tracks, nav) {
                if (!MusicHandoff.openFromTv(context, deps.musicPlayback)) nav.push(Route.Music)
            }
        }
    }
}

private suspend fun fetchTrack(deps: ScreenDeps, id: String): TrackInfo? = withContext(Dispatchers.IO) {
    val url = deps.api.withApiKey("/rest/getSong.view?f=json&id=$id")
    Http.client.newCall(Request.Builder().url(url).build()).execute().use { res ->
        if (!res.isSuccessful) return@withContext null
        val song = statsJson.parseToJsonElement(res.body.string()).jsonObject["subsonic-response"]?.jsonObject?.get("song")?.jsonObject
            ?: return@withContext null
        TrackInfo(
            title = song["title"]?.jsonPrimitive?.contentOrNull ?: id,
            artist = song["artist"]?.jsonPrimitive?.contentOrNull,
            cover = song["coverArt"]?.jsonPrimitive?.contentOrNull?.let { deps.music.coverUrl(it, 300) },
        )
    }
}

private fun fmtHours(h: Double): String = if (h >= 10) String.format(Locale.ROOT, "%.0f", h) else String.format(Locale.ROOT, "%.1f", h)

@Composable
private fun StatsBody(s: YearStats, posters: Map<String, String?>, tracks: Map<String, TrackInfo?>, nav: Navigator, openMusic: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(28.dp)) {
        Row(Modifier.padding(horizontal = MixaiFocus.overscan), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            BigNumber(fmtHours(s.hours), stringResource(R.string.stats_hours), Tokens.chart1, Modifier.weight(1f))
            BigNumber(s.titles.toString(), stringResource(R.string.stats_titles), Tokens.chart2, Modifier.weight(1f))
            BigNumber(s.episodes.toString(), stringResource(R.string.stats_episodes), Tokens.chart3, Modifier.weight(1f))
            BigNumber(s.streakDays.toString(), stringResource(R.string.stats_streak), Tokens.chart4, Modifier.weight(1f))
            BigNumber(fmtHours(s.listenHours), stringResource(R.string.stats_listen_hours), Tokens.chart5, Modifier.weight(1f))
        }

        Column(Modifier.padding(horizontal = MixaiFocus.overscan), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            RowTitle(stringResource(R.string.stats_by_month))
            MonthChart(s.watchByMonth, s.listenByMonth, Modifier.fillMaxWidth().height(220.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                Legend(stringResource(R.string.stats_watch_legend), Tokens.chart1)
                Legend(stringResource(R.string.stats_listen_legend), Tokens.chart3)
            }
        }

        if (s.topGenres.isNotEmpty()) {
            Column(Modifier.padding(horizontal = MixaiFocus.overscan), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                RowTitle(stringResource(R.string.stats_top_genres))
                val max = s.topGenres.maxOf { it.hours }.coerceAtLeast(0.01)
                val palette = listOf(Tokens.chart1, Tokens.chart2, Tokens.chart3, Tokens.chart4, Tokens.chart5)
                s.topGenres.take(6).forEachIndexed { i, g ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(g.name, style = MaterialTheme.typography.bodyMedium, color = Tokens.foreground, modifier = Modifier.width(200.dp), maxLines = 1)
                        Box(Modifier.weight(1f).height(14.dp).background(Tokens.foreground.copy(alpha = 0.08f), RoundedCornerShape(7.dp))) {
                            Box(Modifier.fillMaxWidth((g.hours / max).toFloat().coerceIn(0.02f, 1f)).height(14.dp).background(palette[i % palette.size], RoundedCornerShape(7.dp)))
                        }
                        Text(
                            stringResource(R.string.stats_hours_short, fmtHours(g.hours)),
                            style = MaterialTheme.typography.bodySmall,
                            color = Tokens.mutedForeground,
                            modifier = Modifier.padding(start = 12.dp).width(64.dp),
                        )
                    }
                }
            }
        }

        if (s.topTitles.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                RowTitle(stringResource(R.string.stats_top_titles), modifier = Modifier.padding(horizontal = MixaiFocus.overscan))
                LazyRow(Modifier.focusRestorer(), contentPadding = PaddingValues(horizontal = MixaiFocus.overscan, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    itemsIndexed(s.topTitles, key = { _, t -> "${t.kind}:${t.tmdbId}" }) { i, t ->
                        PosterCard(
                            imageUrl = posters["${t.kind}:${t.tmdbId}"],
                            title = t.title,
                            subtitle = "#${i + 1} · " + stringResource(R.string.stats_hours_short, fmtHours(t.hours)),
                            alwaysShowTitle = true,
                            onClick = { nav.push(Route.Title(t.kind, t.tmdbId)) },
                        )
                    }
                }
            }
        }

        if (s.topTracks.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                RowTitle(stringResource(R.string.stats_top_tracks, s.plays.toInt()), modifier = Modifier.padding(horizontal = MixaiFocus.overscan))
                LazyRow(Modifier.focusRestorer(), contentPadding = PaddingValues(horizontal = MixaiFocus.overscan, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    itemsIndexed(s.topTracks.take(10), key = { _, t -> t.trackKey }) { i, t ->
                        val info = tracks[t.trackKey]
                        PosterCard(
                            imageUrl = info?.cover,
                            title = info?.title ?: stringResource(R.string.stats_track_unknown),
                            subtitle = listOfNotNull("#${i + 1}", info?.artist, stringResource(R.string.stats_plays, t.plays.toInt())).joinToString(" · "),
                            alwaysShowTitle = true,
                            width = 160.dp,
                            onClick = openMusic,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun BigNumber(value: String, label: String, color: Color, modifier: Modifier) {
    Column(
        modifier.background(Brush.verticalGradient(listOf(color.copy(alpha = 0.22f), Tokens.card)), RoundedCornerShape(16.dp)).padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(value, style = MaterialTheme.typography.displaySmall, color = Tokens.foreground, maxLines = 1)
        Text(label, style = MaterialTheme.typography.labelLarge, color = Tokens.mutedForeground, maxLines = 1)
    }
}

@Composable
private fun Legend(label: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(12.dp).background(color, RoundedCornerShape(3.dp)))
        Spacer(Modifier.width(8.dp))
        Text(label, style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
    }
}

/** Grouped month bars (watch + listen hours); labels from the locale's short month names. */
@Composable
private fun MonthChart(watch: List<Double>, listen: List<Double>, modifier: Modifier) {
    val names = remember { DateFormatSymbols.getInstance().shortMonths.take(12) }
    val max = (watch + listen).maxOrNull()?.coerceAtLeast(0.1) ?: 0.1
    val watchColor = Tokens.chart1
    val listenColor = Tokens.chart3
    val grid = Tokens.foreground.copy(alpha = 0.08f)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Canvas(Modifier.fillMaxWidth().weight(1f)) {
            val slot = size.width / 12f
            val bar = slot * 0.32f
            for (g in 1..3) {
                val y = size.height * (1f - g / 3f)
                drawLine(grid, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
            }
            for (i in 0 until 12) {
                val x0 = i * slot + slot * 0.14f
                val wh = (watch.getOrElse(i) { 0.0 } / max).toFloat() * size.height
                val lh = (listen.getOrElse(i) { 0.0 } / max).toFloat() * size.height
                if (wh > 0f) drawRoundRect(watchColor, Offset(x0, size.height - wh), Size(bar, wh), CornerRadius(4f, 4f))
                if (lh > 0f) drawRoundRect(listenColor, Offset(x0 + bar + slot * 0.04f, size.height - lh), Size(bar, lh), CornerRadius(4f, 4f))
            }
        }
        Row(Modifier.fillMaxWidth()) {
            names.forEach { n -> Text(n, style = MaterialTheme.typography.labelSmall, color = Tokens.mutedForeground, modifier = Modifier.weight(1f), maxLines = 1) }
        }
    }
}

/** Entry point the Home screen may place in a row ("Your year"). */
@Composable
fun YourYearButton(nav: Navigator, modifier: Modifier = Modifier) {
    PrimaryButton(stringResource(R.string.stats_open), { nav.push(Route.Stats) }, modifier, icon = MixaiIcons.Speed)
}
