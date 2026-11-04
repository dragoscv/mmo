package ro.mixai.tv.player

import android.content.Context
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.size.Size
import coil3.toBitmap
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.SeasonEpisode
import ro.mixai.tv.ui.nav.ScreenDeps
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

// Player-side data: skip markers (intro/recap/credits/chapters), next-episode resolution,
// scrubber sprite mapping and the autoplay streak for "Are you still watching?".

/** [startMs, endMs) in ABSOLUTE media time. */
internal data class Span(val startMs: Long, val endMs: Long) {
    operator fun contains(ms: Long) = ms in startMs until endMs
}

internal data class Chapter(val startMs: Long, val title: String)

internal data class Markers(
    val intro: Span? = null,
    val recap: Span? = null,
    val creditsMs: Long? = null,
    val chapters: List<Chapter> = emptyList(),
)

private val markerJson = Json { ignoreUnknownKeys = true; isLenient = true }

private suspend fun fetchObject(api: MmoApi, path: String): JsonObject? =
    runCatching { markerJson.parseToJsonElement(api.getJson(path)).jsonObject }.getOrNull()

private fun JsonObject.num(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull

/** `GET /video/intro|recap/{fileId}` → `{start,end}` seconds, `{}` when unknown; 404/errors → null. */
internal suspend fun fetchSpan(api: MmoApi, path: String): Span? {
    val o = fetchObject(api, path) ?: return null
    val s = o.num("start") ?: return null
    val e = o.num("end") ?: return null
    if (e <= s) return null
    return Span((s * 1000).toLong(), (e * 1000).toLong())
}

/** `GET /video/credits/{fileId}` → `{start}` seconds. */
internal suspend fun fetchCreditsMs(api: MmoApi, fileId: String): Long? =
    fetchObject(api, "/video/credits/$fileId")?.num("start")?.takeIf { it > 0 }?.let { (it * 1000).toLong() }

/** `GET /video/chapters/{fileId}` → `{chapters:[{start,title}]}`. */
internal suspend fun fetchChapters(api: MmoApi, fileId: String): List<Chapter> {
    val arr = fetchObject(api, "/video/chapters/$fileId")?.get("chapters") as? JsonArray ?: return emptyList()
    return arr.mapNotNull { e ->
        val o = e as? JsonObject ?: return@mapNotNull null
        val s = o.num("start") ?: return@mapNotNull null
        Chapter((s * 1000).toLong(), (o["title"] as? JsonPrimitive)?.contentOrNull.orEmpty())
    }.sortedBy { it.startMs }
}

// ─── episodes ───────────────────────────────────────────────────────────────

internal data class EpisodeInfo(val season: Long, val episode: Long, val name: String, val stillUrl: String?, val fileId: String?)

internal data class EpisodeContext(val current: EpisodeInfo? = null, val next: EpisodeInfo? = null)

private fun SeasonEpisode.bestFileId(): String? =
    files.filter { it.serverFileId.isNotBlank() }.maxByOrNull { it.version.rank }?.serverFileId

private fun SeasonEpisode.toInfo(api: MmoApi, season: Long): EpisodeInfo {
    val fid = bestFileId()
    return EpisodeInfo(
        season = if (seasonNumber > 0) seasonNumber else season,
        episode = episodeNumber,
        name = name,
        stillUrl = api.tmdbImageUrl(TmdbSize.backdrop(300), stillPath) ?: fid?.let { api.stillUrl(it) },
        fileId = fid,
    )
}

/**
 * Current episode name + the next playable episode (has a local file): the next number in this
 * season, else the first playable episode of the following season.
 */
internal suspend fun resolveEpisodes(deps: ScreenDeps, ref: MediaRef): EpisodeContext {
    val s = ref.season ?: return EpisodeContext()
    val e = ref.episode ?: return EpisodeContext()
    val season = runCatching { deps.media.season(ref.tmdbId, s) }.getOrNull()
    val current = season?.episodes?.firstOrNull { it.episodeNumber == e }?.toInfo(deps.api, s)
    var next = season?.episodes
        ?.filter { it.episodeNumber > e && it.bestFileId() != null }
        ?.minByOrNull { it.episodeNumber }
        ?.toInfo(deps.api, s)
    if (next == null) {
        val following = runCatching { deps.media.season(ref.tmdbId, s + 1) }.getOrNull()
        next = following?.episodes?.filter { it.bestFileId() != null }?.minByOrNull { it.episodeNumber }?.toInfo(deps.api, s + 1)
    }
    return EpisodeContext(current, next)
}

// ─── autoplay streak ────────────────────────────────────────────────────────

/** Survives the player being replaced by the next episode. */
internal object PlaybackSession {
    /** Episodes started by autoplay without a key press in between. */
    @Volatile var autoplayStreak = 0
    /** Set right before an autoplay `nav.replace`, consumed by the next player. */
    @Volatile var pendingAuto = false
}

internal const val STILL_WATCHING_AFTER = 3

// ─── scrubber sprite (server/src/library/video-routes.ts ensureSprite) ─────

internal const val SPRITE_GRID = 12

/** Server mapping: interval = max(2, ceil(duration / 144)) s, cells = min(144, ceil(duration / interval)). */
internal data class SpriteGrid(val intervalSec: Int, val cells: Int)

internal fun spriteGrid(durationSec: Double): SpriteGrid? {
    if (durationSec <= 0) return null
    val target = SPRITE_GRID * SPRITE_GRID
    val interval = max(2, ceil(durationSec / target).toInt())
    val cells = min(target, ceil(durationSec / interval).toInt())
    return SpriteGrid(interval, cells.coerceAtLeast(1))
}

/** Tile i covers [i·interval, (i+1)·interval). */
internal fun spriteTile(grid: SpriteGrid, positionSec: Double): Int =
    (positionSec / grid.intervalSec).toInt().coerceIn(0, grid.cells - 1)

/** Loads `sprite.jpg` at full size as a software bitmap (503 while the server builds it → null). */
internal suspend fun loadSprite(context: Context, url: String): ImageBitmap? {
    val req = ImageRequest.Builder(context).data(url).size(Size.ORIGINAL).allowHardware(false).build()
    val res = SingletonImageLoader.get(context).execute(req) as? SuccessResult ?: return null
    return res.image.toBitmap().asImageBitmap()
}
