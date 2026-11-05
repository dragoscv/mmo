package ro.mixai.app.ui.player

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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import ro.mixai.app.AppDeps
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.data.generated.SeasonEpisode
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

// Player-side data (port of the TV PlayerData.kt): skip markers, next episode, scrubber sprite,
// autoplay streak and profile playback preferences.

/** [startMs, endMs) in ABSOLUTE media time. */
internal data class Span(val startMs: Long, val endMs: Long) {
    operator fun contains(ms: Long) = ms in startMs until endMs
}

internal data class Markers(val intro: Span? = null, val recap: Span? = null, val creditsMs: Long? = null)

private val markerJson = Json { ignoreUnknownKeys = true; isLenient = true }

private suspend fun fetchObject(api: MmoApi, path: String): JsonObject? =
    runCatching { markerJson.parseToJsonElement(api.getJson(path)).jsonObject }.getOrNull()

private fun JsonObject.num(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull

// GET /video/intro/{fileId} and /video/recap/{fileId} -> {start,end} seconds; {} when unknown; errors -> null.
internal suspend fun fetchSpan(api: MmoApi, path: String): Span? {
    val o = fetchObject(api, path) ?: return null
    val s = o.num("start") ?: return null
    val e = o.num("end") ?: return null
    if (e <= s) return null
    return Span((s * 1000).toLong(), (e * 1000).toLong())
}

// GET /video/credits/{fileId} -> {start} seconds.
internal suspend fun fetchCreditsMs(api: MmoApi, fileId: String): Long? =
    fetchObject(api, "/video/credits/$fileId")?.num("start")?.takeIf { it > 0 }?.let { (it * 1000).toLong() }

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

/** Current episode name + the next playable episode (this season, else the first playable of the next season). */
internal suspend fun resolveEpisodes(deps: AppDeps, ref: MediaRef): EpisodeContext {
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
    /** Episodes started by autoplay without a user interaction in between. */
    @Volatile var autoplayStreak = 0
    /** Set right before an autoplay `nav.replace`, consumed by the next player. */
    @Volatile var pendingAuto = false
}

internal const val STILL_WATCHING_AFTER = 3

// ─── scrubber sprite (server/src/library/video-routes.ts ensureSprite) ─────

internal const val SPRITE_GRID = 12
internal const val SPRITE_TILE_W = 160
internal const val SPRITE_TILE_H = 90

/** Server mapping: interval = max(2, ceil(duration / 144)) s, cells = min(144, ceil(duration / interval)). */
internal data class SpriteGrid(val intervalSec: Int, val cells: Int)

internal fun spriteGrid(durationSec: Double): SpriteGrid? {
    if (durationSec <= 0) return null
    val target = SPRITE_GRID * SPRITE_GRID
    val interval = max(2, ceil(durationSec / target).toInt())
    val cells = min(target, ceil(durationSec / interval).toInt())
    return SpriteGrid(interval, cells.coerceAtLeast(1))
}

internal fun spriteTile(grid: SpriteGrid, positionSec: Double): Int =
    (positionSec / grid.intervalSec).toInt().coerceIn(0, grid.cells - 1)

/** Loads `sprite.jpg` at full size as a software bitmap (503 while the server builds it -> null). */
internal suspend fun loadSprite(context: Context, url: String): ImageBitmap? {
    val req = ImageRequest.Builder(context).data(url).size(Size.ORIGINAL).allowHardware(false).build()
    val res = SingletonImageLoader.get(context).execute(req) as? SuccessResult ?: return null
    return res.image.toBitmap().asImageBitmap()
}

// ─── profile prefs (same keys as the TV ProfilePrefKeys) ───────────────────

internal object PlayerPrefKeys {
    const val AUTOPLAY_NEXT = "autoplayNext"
    const val SKIP_INTRO = "skipIntro"
    const val AUDIO_LANG = "audioLang"
    const val SUB_LANG = "subLang"
    const val SUB_FORCED_ONLY = "subForcedOnly"
    const val SUB_SIZE = "subSize"
    const val SUB_BG = "subBg"
}

internal fun Profile?.prefBool(key: String, default: Boolean): Boolean =
    (this?.prefs?.get(key) as? JsonPrimitive)?.booleanOrNull ?: default

internal fun Profile?.prefString(key: String, default: String): String =
    (this?.prefs?.get(key) as? JsonPrimitive)?.contentOrNull ?: default

internal fun formatTime(ms: Long): String {
    val total = ms.coerceAtLeast(0) / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/** Audio track label: "EN · AAC · 5.1 (Commentary)". */
internal fun audioLabel(lang: String?, codec: String, channels: Int, title: String?): String {
    val ch = when (channels) { 1 -> "1.0"; 2 -> "2.0"; 6 -> "5.1"; 8 -> "7.1"; else -> if (channels > 0) "${channels}ch" else "" }
    val main = listOfNotNull(
        lang?.uppercase()?.takeIf { it.isNotBlank() && it != "UND" },
        codec.uppercase().takeIf { it.isNotBlank() },
        ch.ifBlank { null },
    ).joinToString(" · ")
    return if (!title.isNullOrBlank()) "$main ($title)" else main.ifBlank { "-" }
}
