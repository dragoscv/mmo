package ro.mixai.app.data

import kotlinx.serialization.json.Json
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.MmoApi

// Phone calls to the MMO Server 3.9 routes (bookmarks, usage, family stats, subtitle search, Plex import,
// original-file downloads). Thin wrappers over MmoApi's JSON transport (device token + x-profile-token).

private val pjson = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }

class PhoneApi(val api: MmoApi, private val profileId: () -> String, private val profileToken: () -> String) {
    private fun enc(s: String) = api.encode(s)
    private fun profileQuery(): String = "profile=${enc(profileId())}"

    // ─── bookmarks ────────────────────────────────────────────────────────
    /** `titleKey`: `movie:603`, `tv:1399` (all episodes), `tv:1399:s1e2`, `file:<fileId>`. */
    suspend fun bookmarks(titleKey: String?): List<Bookmark> {
        val q = profileQuery() + (titleKey?.let { "&titleKey=${enc(it)}" } ?: "")
        return pjson.decodeFromString<BookmarkList>(api.getJson("/media/bookmarks?$q")).bookmarks
    }

    suspend fun addBookmark(input: BookmarkInput): Bookmark =
        pjson.decodeFromString<BookmarkEnvelope>(api.postJson("/media/bookmarks?${profileQuery()}", pjson.encodeToString(BookmarkInput.serializer(), input))).bookmark

    suspend fun deleteBookmark(id: String) { api.deleteJson("/media/bookmarks/${enc(id)}?${profileQuery()}") }

    // ─── kids caps / stats ────────────────────────────────────────────────
    suspend fun usage(profile: String = profileId()): ProfileUsage =
        pjson.decodeFromString(api.getJson("/media/profiles/${enc(profile)}/usage"))

    suspend fun familyStats(): FamilyStats = pjson.decodeFromString(api.getJson("/media/stats/family"))

    // ─── subtitle search ──────────────────────────────────────────────────
    suspend fun searchSubtitles(q: String, fileId: String?): SubtitleSearchResult {
        val query = "q=${enc(q)}&${profileQuery()}" + (fileId?.let { "&fileId=${enc(it)}" } ?: "")
        return pjson.decodeFromString(api.getJson("/media/subtitles/search?$query"))
    }

    /** Index a file's subtitles on demand (200 complete / 202 queued). */
    suspend fun indexSubtitles(fileId: String): SubtitleIndexState =
        runCatching { pjson.decodeFromString<SubtitleIndexState>(api.postJson("/media/subtitles/index", """{"fileId":${jsonStr(fileId)}}""")) }
            .getOrElse { if (it is ApiException) throw it else SubtitleIndexState(fileId) }

    // ─── Plex importer (token used once, never stored) ────────────────────
    suspend fun importPlex(serverUrl: String, token: String, profile: String = profileId()): PlexImportResult {
        val body = """{"serverUrl":${jsonStr(serverUrl)},"token":${jsonStr(token)},"profileId":${jsonStr(profile)}}"""
        return pjson.decodeFromString(api.postJson("/media/import/plex", body))
    }

    // ─── downloads ────────────────────────────────────────────────────────
    /** Original file with Range (`GET /video/file/{id}`); `t` + viewer profile in the query (Media3 sets no headers). */
    fun originalFileUrl(fileId: String): String {
        val pt = profileToken()
        val path = "/video/file/${enc(fileId)}?${profileQuery()}" + (if (pt.isNotBlank()) "&pt=${enc(pt)}" else "")
        return api.withToken(path)
    }

    companion object {
        fun jsonStr(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""

        /** `ApiException` from a 403 kids gate → its body, else null. */
        fun dailyCapOf(e: Throwable): DailyCapError? {
            val a = e as? ApiException ?: return null
            if (a.status != 403) return null
            val body = a.message?.substringAfter(": ", "") ?: return null
            return runCatching { pjson.decodeFromString<DailyCapError>(body) }.getOrNull()?.takeIf { it.error == "daily_cap" }
        }
    }
}
