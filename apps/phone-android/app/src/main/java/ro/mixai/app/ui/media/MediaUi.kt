package ro.mixai.app.ui.media

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import ro.mixai.app.AppDeps
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.generated.MediaTitleResponse
import ro.mixai.tv.data.generated.ProgressEntry
import ro.mixai.tv.data.generated.TitleCard
import ro.mixai.tv.data.generated.TitleDetails
import ro.mixai.tv.data.generated.VersionedFile
import kotlin.math.roundToLong

// Shared media logic for Home / Title / Library / Search (port of tv-android ui/title/MediaUi.kt,
// without TV UI): play-target resolution, format chips, trailer key, card keys.

/** What the primary button plays: one server file, its TMDB identity and where to start. */
data class PlayTarget(
    val fileId: String,
    val ref: MediaRef,
    /** Absolute start (ms); -1 = local resume position. */
    val resumeMs: Long,
    /** Minutes left when resuming (null when unknown). */
    val leftMin: Long?,
)

fun VersionedFile.isEpisode(): Boolean = (season ?: 0L) > 0L || (episode ?: 0L) > 0L

fun bestFile(files: List<VersionedFile>, preferredId: String? = null): VersionedFile? =
    files.firstOrNull { it.serverFileId == preferredId } ?: files.maxByOrNull { it.version.rank }

private fun resumeOf(p: ProgressEntry?): Pair<Long, Long?> {
    if (p == null || p.completed || p.positionSec <= 0.0) return -1L to null
    val left = if (p.durationSec > p.positionSec) ((p.durationSec - p.positionSec) / 60.0).roundToLong().coerceAtLeast(1L) else null
    return (p.positionSec * 1000).toLong() to left
}

fun episodeTarget(tmdbId: Long, season: Long, episode: Long, files: List<VersionedFile>, progress: ProgressEntry?, preferredId: String? = null): PlayTarget? {
    val f = bestFile(files, preferredId) ?: return null
    val (ms, left) = resumeOf(progress)
    return PlayTarget(f.serverFileId, MediaRef("tv", tmdbId, season, episode), ms, left)
}

fun movieTarget(d: MediaTitleResponse, preferredId: String? = null): PlayTarget? {
    val f = bestFile(d.files.filter { !it.isEpisode() }.ifEmpty { d.files }, preferredId) ?: return null
    val (ms, left) = resumeOf(d.progress.firstOrNull { it.season == 0L && it.episode == 0L })
    return PlayTarget(f.serverFileId, MediaRef(d.title.kind.ifBlank { "movie" }, d.title.tmdbId), ms, left)
}

/** Movies → best file; series → `nextUp` episode, else the earliest local episode not completed. */
suspend fun resolveTarget(deps: AppDeps, d: MediaTitleResponse, preferredId: String? = null): PlayTarget? {
    if (d.title.kind != "tv") return movieTarget(d, preferredId)
    val id = d.title.tmdbId
    val eps = d.files.filter { it.isEpisode() }
    val nu = d.nextUp
    if (nu != null && nu.season > 0) {
        var files = eps.filter { it.season == nu.season && it.episode == nu.episode }
        if (files.isEmpty()) {
            files = runCatching { deps.media.season(id, nu.season).episodes.firstOrNull { it.episodeNumber == nu.episode }?.files }.getOrNull().orEmpty()
        }
        if (files.isNotEmpty()) {
            val p = d.progress.firstOrNull { it.season == nu.season && it.episode == nu.episode }
            val t = episodeTarget(id, nu.season, nu.episode, files, p, preferredId)
            if (t != null && t.resumeMs < 0 && nu.positionSec > 0) return t.copy(resumeMs = (nu.positionSec * 1000).toLong())
            return t
        }
    }
    if (eps.isEmpty()) return null
    val done = d.progress.filter { it.completed }.map { it.season to it.episode }.toSet()
    val order = compareBy<VersionedFile>({ it.season ?: 0L }, { it.episode ?: 0L })
    val pick = eps.filter { ((it.season ?: 0L) to (it.episode ?: 0L)) !in done }.minWithOrNull(order) ?: eps.minWithOrNull(order) ?: return null
    val s = pick.season ?: 0L
    val e = pick.episode ?: 0L
    return episodeTarget(id, s, e, eps.filter { it.season == pick.season && it.episode == pick.episode }, d.progress.firstOrNull { it.season == s && it.episode == e })
}

/** Pushes the player for a target (`fromStart` ignores the resume point). */
fun startPlayback(nav: Navigator, t: PlayTarget, fromStart: Boolean = false) {
    nav.push(Dest.Player(t.fileId, t.ref, if (fromStart) 0L else t.resumeMs))
}

/** Technical format chips (never localised: 4K, HD, DV, HDR). */
fun formatChips(files: List<VersionedFile>): List<String> = buildList {
    if (files.any { it.version.resolution == "2160p" }) add("4K") else if (files.any { it.version.resolution == "1080p" }) add("HD")
    if (files.any { it.version.hdr == "DV" }) add("DV")
    if (files.any { it.version.hdr == "HDR" || it.version.hdr == "HDR10+" }) add("HDR")
}

fun yearOf(date: String?): String? = date?.take(4)?.takeIf { it.length == 4 && it.all(Char::isDigit) }

fun genresOf(t: TitleDetails): List<String> = t.genres.mapNotNull { it.str("name") }

private fun JsonObject.str(key: String): String? = runCatching { this[key]?.jsonPrimitive?.contentOrNull }.getOrNull()?.takeIf { it.isNotBlank() }

/** YouTube key of the best trailer (official Trailer first). */
fun trailerKey(t: TitleDetails): String? {
    val yt = t.videos.filter { it.str("site").equals("YouTube", ignoreCase = true) && it.str("key") != null }
    return (yt.firstOrNull { it.str("type") == "Trailer" } ?: yt.firstOrNull())?.str("key")
}

/** Stable key of a TMDB card (shared-element key + LazyRow key). */
fun cardKey(c: TitleCard): String = "${c.kind}-${c.tmdbId}"

/** Shared-element key of the poster image of a title (Home/Library/Search card → Title header). */
fun posterKey(kind: String, tmdbId: Long): String = "poster-$kind-$tmdbId"
