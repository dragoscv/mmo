package ro.mixai.tv.data

import kotlinx.serialization.Serializable
import ro.mixai.tv.data.generated.AlbumCard
import ro.mixai.tv.data.generated.LiveTvProgramme
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.data.generated.TitleCard
import ro.mixai.tv.data.generated.WatchlistEntry

// Response envelopes that server/openapi.yaml declares inline (so the generator does not emit them).
// Field names follow the spec exactly; keep in sync with the paths noted on each class.

/** `GET /media/profiles` */
@Serializable
data class ProfilesPage(val revision: Long = 0L, val profiles: List<Profile> = emptyList())

/** `POST/PATCH /media/profiles[/{id}]` */
@Serializable
data class ProfileEnvelope(val profile: Profile = Profile())

/** `POST /media/profiles/{id}/unlock` 200 */
@Serializable
data class ProfileUnlock(val token: String = "", val expiresAt: Long = 0L)

/** `POST /media/profiles/{id}/unlock` 401 / 429 body */
@Serializable
data class ProfileUnlockError(val error: String = "", val triesLeft: Int? = null, val retryAfterMs: Long? = null)

/** `GET /media/watchlist` */
@Serializable
data class WatchlistPage(val revision: Long = 0L, val entries: List<WatchlistEntry> = emptyList(), val items: List<TitleCard> = emptyList())

/** `GET /media/music/genres/{name}` */
@Serializable
data class GenreAlbums(val genre: String = "", val total: Long = 0L, val offset: Long = 0L, val limit: Long = 0L, val items: List<AlbumCard> = emptyList())

/** `GET /livetv/groups` item */
@Serializable
data class LiveTvGroup(val name: String = "", val count: Long = 0L)

/** `GET /livetv/guide` */
@Serializable
data class LiveTvGuide(val from: Long = 0L, val to: Long = 0L, val programmes: List<LiveTvProgramme> = emptyList())

/** `GET /livetv/now` item */
@Serializable
data class LiveTvNowNext(val channelId: String = "", val now: LiveTvProgramme? = null, val next: LiveTvProgramme? = null)

/** `GET /livetv/rules` item (`components.schemas.LiveTvRule`, not generated for Kotlin). */
@Serializable
data class LiveTvRule(
    val id: String = "",
    val titleMatch: String = "",
    val channelId: String? = null,
    val paddingBeforeSec: Long = 0L,
    val paddingAfterSec: Long = 0L,
    val keepLast: Long = 0L,
    val enabled: Boolean = true,
    val createdAt: Long = 0L,
)

/** `POST/PATCH /livetv/sources` body (`components.schemas.LiveTvSourceInput`). `kind`: m3u | xtream | hdhomerun. */
@Serializable
data class LiveTvSourceInput(
    val kind: String? = null,
    val name: String? = null,
    val url: String? = null,
    val xmltvUrl: String? = null,
    val username: String? = null,
    val password: String? = null,
    val enabled: Boolean? = null,
    val refreshHours: Long? = null,
    val tunerLimit: Long? = null,
)

/** `POST /livetv/sources/{id}/test` */
@Serializable
data class LiveTvSourceTest(val ok: Boolean = false, val channelCount: Long = 0L, val error: String? = null)
