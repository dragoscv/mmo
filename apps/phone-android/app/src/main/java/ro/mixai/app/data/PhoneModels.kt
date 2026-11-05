package ro.mixai.app.data

import kotlinx.serialization.Serializable
import ro.mixai.tv.data.generated.WeeklyUsage

// Phone-side shapes of the server 3.9 additions (server/openapi.yaml: Bookmark, ProfileUsage, FamilyStats,
// SubtitleHit, PlexImportResult, DailyCapError). The generated core Models.kt predates them; every field has a
// default so an older server still decodes.

@Serializable
data class Bookmark(
    val id: String = "",
    val profileId: String = "",
    val titleKey: String = "",
    val kind: String? = null,
    val tmdbId: Long? = null,
    val season: Long? = null,
    val episode: Long? = null,
    val fileId: String? = null,
    val sec: Double = 0.0,
    val label: String = "",
    val shared: Boolean = false,
    val createdAt: Long = 0L,
    val mine: Boolean? = null,
    val profileName: String? = null,
)

@Serializable
data class BookmarkInput(
    val kind: String? = null,
    val tmdbId: Long? = null,
    val season: Long? = null,
    val episode: Long? = null,
    val fileId: String? = null,
    val sec: Double,
    val label: String? = null,
    val shared: Boolean = false,
)

@Serializable
data class BookmarkList(val bookmarks: List<Bookmark> = emptyList())

@Serializable
data class BookmarkEnvelope(val bookmark: Bookmark = Bookmark())

@Serializable
data class ProfileUsage(
    val profileId: String = "",
    val day: String = "",
    val watchMin: Long = 0L,
    val listenMin: Long = 0L,
    val dailyCapMin: Long? = null,
    val remainingMin: Long? = null,
    val overCap: Boolean = false,
    val enforced: Boolean = false,
    val week: WeeklyUsage = WeeklyUsage(),
)

@Serializable
data class FamilyProfileStats(
    val profileId: String = "",
    val name: String = "",
    val kind: String = "adult",
    val avatar: String? = null,
    val color: String? = null,
    val days: List<String> = emptyList(),
    val watchMin: List<Long> = emptyList(),
    val listenMin: List<Long> = emptyList(),
    val weeklyWatchMin: Long = 0L,
    val weeklyListenMin: Long = 0L,
    val todayWatchMin: Long = 0L,
    val dailyCapMin: Long? = null,
    val overCap: Boolean = false,
)

@Serializable
data class FamilyStats(val generatedAt: Long = 0L, val profiles: List<FamilyProfileStats> = emptyList())

@Serializable
data class SubtitleHit(
    val fileId: String = "",
    val tmdbId: Long? = null,
    val kind: String? = null,
    val season: Long? = null,
    val episode: Long? = null,
    val title: String = "",
    val source: String = "",
    val trackIndex: Int? = null,
    val trackKey: String = "",
    val lang: String? = null,
    val startSec: Double = 0.0,
    val endSec: Double = 0.0,
    val text: String = "",
)

@Serializable
data class SubtitleSearchResult(val q: String = "", val hits: List<SubtitleHit> = emptyList(), val indexedFiles: Boolean? = null)

@Serializable
data class SubtitleIndexState(
    val fileId: String = "",
    val state: String? = null,
    val progress: Double? = null,
    val error: String? = null,
)

@Serializable
data class PlexImportResult(
    val profileId: String = "",
    val sections: Long = 0L,
    val watchedMovies: Long = 0L,
    val watchedEpisodes: Long = 0L,
    val ratings: Long = 0L,
    val watchlist: Long = 0L,
    val unmatched: Long = 0L,
    val errors: List<String> = emptyList(),
)

/** 403 body of the kids playback gate. */
@Serializable
data class DailyCapError(val error: String = "", val profileId: String? = null, val dailyCapMin: Long? = null, val watchMin: Long = 0L)

/** `/api/auth/native/google` answer (subset). */
@Serializable
data class NativeSessionUser(val id: String = "", val name: String? = null, val email: String? = null, val image: String? = null)

@Serializable
data class NativeSession(val session_token: String = "", val sessionToken: String = "", val expires: String = "", val user: NativeSessionUser = NativeSessionUser()) {
    val token: String get() = sessionToken.ifBlank { session_token }
}
