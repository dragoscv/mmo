package ro.mixai.tv.data

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
import ro.mixai.tv.data.generated.MediaSearchPage
import ro.mixai.tv.data.generated.MediaStatus
import ro.mixai.tv.data.generated.MediaTitleResponse
import ro.mixai.tv.data.generated.ProgressInput
import ro.mixai.tv.data.generated.ProgressList
import ro.mixai.tv.data.generated.TrackPlayInput

// Client for the server `media` module (`/media/*`, WP12-01). Every shape comes from the
// generated `data/generated/Models.kt` (server/openapi.yaml) — nothing is hand-duplicated here.
//
// `home()` is cached in memory for 5 min: a cheap `GET /media/etag` runs first and the rows
// are only refetched when `revision` or `libraryEtag` moved (or the cache aged out).
class MediaRepository(private val api: MmoApi, val profile: String = "default") {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }

    private data class HomeCache(val home: MediaHome, val etag: MediaEtag, val at: Long)
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
        val cached = homeCache
        if (!force && cached != null && now - cached.at < HOME_TTL_MS) {
            val tag = runCatching { etag() }.getOrNull()
            if (tag == null || tag == cached.etag) return@withLock cached.home
        }
        val home = json.decodeFromString<MediaHome>(api.getJson("/media/home?profile=${api.encode(profile)}"))
        homeCache = HomeCache(home, MediaEtag(home.revision, home.libraryEtag), now)
        home
    }

    fun invalidateHome() { homeCache = null }

    suspend fun title(kind: String, tmdbId: Long): MediaTitleResponse =
        json.decodeFromString(api.getJson("/media/title/${api.encode(kind)}/$tmdbId?profile=${api.encode(profile)}"))

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
