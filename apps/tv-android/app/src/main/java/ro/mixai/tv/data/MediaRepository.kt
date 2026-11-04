package ro.mixai.tv.data

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import ro.mixai.tv.data.generated.HomeRow
import ro.mixai.tv.data.generated.LaunchData
import ro.mixai.tv.data.generated.LibraryIndex
import ro.mixai.tv.data.generated.MediaEtag
import ro.mixai.tv.data.generated.MediaHome
import ro.mixai.tv.data.generated.MediaSeasonResponse
import ro.mixai.tv.data.generated.MediaSearchPage
import ro.mixai.tv.data.generated.MediaStats
import ro.mixai.tv.data.generated.MediaStatus
import ro.mixai.tv.data.generated.MediaTitleResponse
import ro.mixai.tv.data.generated.ProgressInput
import ro.mixai.tv.data.generated.ProgressList
import ro.mixai.tv.data.generated.TrackPlayInput
import java.io.File

// Client for the server `media` module (`/media/*`, WP12-01). Every shape comes from the
// generated `data/generated/Models.kt` (server/openapi.yaml) — nothing is hand-duplicated here.
//
// `home()` is cached in memory for 5 min: a cheap `GET /media/etag` runs first and the rows
// are only refetched when `revision` or `libraryEtag` moved (or the cache aged out).
// WP16: the profile is the ACTIVE viewer profile (`profileId()`, from ProfileRepository) and the
// last home per profile is kept on disk (`<cacheDir>/home-<profile>.json`) so [homeFlow] paints
// instantly and revalidates in the background (stale-while-revalidate).
class MediaRepository(
    private val api: MmoApi,
    private val profileId: () -> String = { "default" },
    private val cacheDir: File? = null,
) {
    /** Convenience for tests / legacy callers with a fixed profile. */
    constructor(api: MmoApi, profile: String) : this(api, { profile }, null)

    /** Active profile id sent as `?profile=`. */
    val profile: String get() = profileId().ifBlank { "default" }

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }

    private data class HomeCache(val profile: String, val home: MediaHome, val etag: MediaEtag, val at: Long)
    private var homeCache: HomeCache? = null
    private val homeLock = Mutex()

    /** `null` when the server predates the media module (404 / 501) — callers fall back to `/video/scan`. */
    suspend fun status(): MediaStatus? = try {
        json.decodeFromString<MediaStatus>(api.getJson("/media/status"))
    } catch (e: ApiException) {
        if (e.status == 404 || e.status == 501) null else throw e
    }

    suspend fun etag(): MediaEtag = json.decodeFromString(api.getJson("/media/etag"))

    suspend fun home(force: Boolean = false): MediaHome = homeLock.withLock {
        val now = System.currentTimeMillis()
        val p = profile
        val cached = homeCache?.takeIf { it.profile == p }
        if (!force && cached != null && now - cached.at < HOME_TTL_MS) {
            val tag = runCatching { etag() }.getOrNull()
            if (tag == null || tag == cached.etag) return@withLock cached.home
        }
        val raw = api.getJson("/media/home?profile=${api.encode(p)}")
        val home = json.decodeFromString<MediaHome>(raw)
        homeCache = HomeCache(p, home, MediaEtag(home.revision, home.libraryEtag), now)
        writeDisk(p, raw)
        home
    }

    fun invalidateHome() { homeCache = null }

    /**
     * Stale-while-revalidate home: emits the disk copy for the active profile first (no network),
     * then checks `/media/etag` and emits a fresh home only when it changed (or nothing was cached).
     * Network failures after a cached emit are swallowed; with no cache they propagate.
     */
    fun homeFlow(): Flow<MediaHome> = flow {
        val p = profile
        val cached = readDisk(p)
        if (cached != null) emit(cached)
        try {
            if (cached != null) {
                val tag = etag()
                if (tag.revision == cached.revision && tag.libraryEtag == cached.libraryEtag) {
                    homeCache = HomeCache(p, cached, tag, System.currentTimeMillis())
                    return@flow
                }
            }
            emit(home(force = true))
        } catch (e: Exception) {
            if (cached == null) throw e
            Log.w(TAG, "home revalidate failed: ${e.message}")
        }
    }.flowOn(Dispatchers.IO)

    private fun diskFile(p: String): File? = cacheDir?.let { File(it, "home-${p.replace(Regex("[^A-Za-z0-9_-]"), "_")}.json") }

    private suspend fun readDisk(p: String): MediaHome? = withContext(Dispatchers.IO) {
        val f = diskFile(p) ?: return@withContext null
        if (!f.exists()) return@withContext null
        runCatching { json.decodeFromString<MediaHome>(f.readText()) }.getOrNull()
    }

    private suspend fun writeDisk(p: String, raw: String) = withContext(Dispatchers.IO) {
        val f = diskFile(p) ?: return@withContext
        runCatching {
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(raw)
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        }.onFailure { Log.w(TAG, "home cache write failed: ${it.message}") }
    }

    suspend fun title(kind: String, tmdbId: Long): MediaTitleResponse =
        json.decodeFromString(api.getJson("/media/title/${api.encode(kind)}/$tmdbId?profile=${api.encode(profile)}"))

    /** `GET /media/title/tv/{id}/season/{n}` — episodes + local files (versions) + per-episode progress. */
    suspend fun season(tmdbId: Long, n: Long): MediaSeasonResponse =
        json.decodeFromString(api.getJson("/media/title/tv/$tmdbId/season/$n?profile=${api.encode(profile)}"))

    /** `GET /media/watchlist` — entries + cards (filtered by the profile's max age). */
    suspend fun watchlist(): WatchlistPage =
        json.decodeFromString(api.getJson("/media/watchlist?profile=${api.encode(profile)}"))

    suspend fun addWatchlist(kind: String, tmdbId: Long) {
        api.putJson("/media/watchlist/${api.encode(kind)}/$tmdbId?profile=${api.encode(profile)}", "{}")
        invalidateHome()
    }

    suspend fun removeWatchlist(kind: String, tmdbId: Long) {
        api.deleteJson("/media/watchlist/${api.encode(kind)}/$tmdbId?profile=${api.encode(profile)}")
        invalidateHome()
    }

    /** `GET /media/stats` — year in review (`year` null = current year). */
    suspend fun stats(year: Int? = null): MediaStats =
        json.decodeFromString(api.getJson("/media/stats?profile=${api.encode(profile)}" + (year?.let { "&year=$it" } ?: "")))

    suspend fun search(q: String, page: Int = 1): MediaSearchPage =
        json.decodeFromString(api.getJson("/media/search?q=${api.encode(q)}&page=$page"))

    suspend fun getProgress(since: Long? = null): ProgressList {
        val qs = buildString {
            append("/media/progress?profile=").append(api.encode(profile))
            if (since != null) append("&since=").append(since)
        }
        return json.decodeFromString(api.getJson(qs))
    }

    /** Batch upsert (1..500). Returns the new server revision. */
    suspend fun putProgress(list: List<ProgressInput>): Long {
        if (list.isEmpty()) return -1
        val body = json.encodeToString(ListSerializer(ProgressInput.serializer()), list.take(500))
        val res = json.parseToJsonElement(api.putJson("/media/progress?profile=${api.encode(profile)}", body)).jsonObject
        invalidateHome() // the `continue` row changed
        return res["revision"]?.jsonPrimitive?.longOrNull ?: -1
    }

    suspend fun postPlay(input: TrackPlayInput) {
        api.postJson("/media/plays?profile=${api.encode(profile)}", json.encodeToString(TrackPlayInput.serializer(), input.copy(profileId = input.profileId ?: profile)))
    }

    suspend fun library(since: Long? = null): LibraryIndex =
        json.decodeFromString(api.getJson("/media/library" + if (since != null) "?since=$since" else ""))

    companion object {
        private const val TAG = "MediaRepository"
        const val HOME_TTL_MS = 5 * 60_000L
        const val ROW_CONTINUE = "continue"
    }
}

// ─── helpers over generated shapes whose loose parts are JsonObject ──────────

/** `HomeRow.title` is `{ro, en}`; pick by language tag, fall back to the other. */
fun HomeRow.titleFor(lang: String): String {
    val ro = title["ro"]?.jsonPrimitive?.content
    val en = title["en"]?.jsonPrimitive?.content
    return (if (lang.startsWith("ro")) ro ?: en else en ?: ro) ?: id
}

/** `LaunchData.android` is `{package, uri?}` in the spec; typed access. */
val LaunchData.androidPackage: String? get() = android?.str("package")
val LaunchData.androidUri: String? get() = android?.str("uri")

private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() }
