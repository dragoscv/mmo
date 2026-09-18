package ro.mixai.tv.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class ApiException(val status: Int, message: String) : IOException("HTTP $status: $message")

// Thin HTTP client for one MMO Server. Plain `HttpURLConnection` +
// kotlinx.serialization — no Retrofit/OkHttp on the API path.
//
// Auth: `x-device-token` header on JSON calls; `?t=<token>` on media URLs
// (Media3 loads those itself and cannot set custom headers per item).
// `u` (userId) is optional for the video routes — `queryAuth` only copies it to
// `x-user-id` when present and `authMiddleware` never reads it.
class MmoApi(val baseUrl: String, private val token: String) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true }
    private val subsonicBase = "$baseUrl/rest"
    private val subsonicQuery = "f=json&v=1.16.1&c=mixaitv&apiKey=${enc(token)}"

    // ─── MMO Server ───────────────────────────────────────────────────────

    suspend fun health(): Health = json.decodeFromString(get("$baseUrl/health", auth = false))

    // ─── Quick Connect pairing (no auth) ──────────────────────────────────

    suspend fun pairInfo(): PairInfo = json.decodeFromString(get("$baseUrl/pair/info", auth = false))

    suspend fun pairRequest(deviceName: String): PairRequest {
        val body = """{"deviceName":${jsonStr(deviceName)},"platform":"android-tv"}"""
        return json.decodeFromString(request("POST", "$baseUrl/pair/request", body, auth = false))
    }

    suspend fun pairPoll(code: String, secret: String): PairPoll =
        json.decodeFromString(get("$baseUrl/pair/poll?code=${enc(code)}&secret=${enc(secret)}", auth = false))

    private fun jsonStr(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    /** Returns 200 with the token, 401 without → tells the Connect screen "paired or not". */
    suspend fun checkToken(): Boolean = try {
        get("$baseUrl/video/flags", auth = true); true
    } catch (e: ApiException) {
        if (e.status == 401) false else throw e
    }

    /** No list endpoint exists — `POST /video/scan` walks the configured roots and returns every probed file. */
    suspend fun scanAll(): List<VideoFile> {
        val body = post("$baseUrl/video/scan", "{}")
        return json.decodeFromString<ScanResponse>(body).files
    }

    suspend fun scanMovies(): List<VideoFile> =
        scanAll().filter { it.parsed.season == null }.sortedBy { it.title.lowercase() }

    /** Registry metadata for one known file id (`GET /video/file/{id}/info`) — same shape as a scan entry. */
    suspend fun fileInfo(fileId: String): VideoFile = json.decodeFromString(get("$baseUrl/video/file/${enc(fileId)}/info", auth = true))

    fun directUrl(fileId: String) = "$baseUrl/video/direct/$fileId?t=${enc(token)}"
    fun hlsUrl(fileId: String, quality: String = "720p") = "$baseUrl/video/stream/$fileId?q=$quality&t=${enc(token)}"
    fun subtitleUrl(fileId: String, ordinal: Int) = "$baseUrl/video/subs/$fileId/$ordinal?t=${enc(token)}"
    /** Scrubber sprite: 12×12 grid of 160×90 tiles, generated lazily by ffmpeg (503 until ready). */
    fun spriteUrl(fileId: String) = "$baseUrl/video/thumbs/$fileId/sprite.jpg?t=${enc(token)}"
    /** Cached TMDB image proxy (`/video/tmdb-image/{size}/{path}`); `path` is the TMDB path incl. its leading `/`. */
    fun tmdbImageUrl(size: String, path: String?): String? =
        path?.takeIf { it.isNotBlank() }?.let { "$baseUrl/video/tmdb-image/$size${if (it.startsWith("/")) it else "/$it"}?t=${enc(token)}" }

    // ─── generic JSON transport for feature repositories (MediaRepository) ─

    /** `GET {baseUrl}{path}` with the device token; `path` starts with `/`. */
    suspend fun getJson(path: String): String = get("$baseUrl$path", auth = true)
    suspend fun putJson(path: String, body: String): String = request("PUT", "$baseUrl$path", body, auth = true)
    suspend fun postJson(path: String, body: String): String = request("POST", "$baseUrl$path", body, auth = true)
    fun encode(s: String) = enc(s)

    // ─── OpenSubsonic ─────────────────────────────────────────────────────

    suspend fun newestAlbums(size: Int = 50): List<Album> =
        subsonic("getAlbumList2", "type=newest&size=$size").albumList2?.album ?: emptyList()

    suspend fun album(id: String): Album =
        subsonic("getAlbum", "id=${enc(id)}").album ?: throw ApiException(404, "album not found")

    suspend fun search(query: String): SearchResult3 =
        subsonic("search3", "query=${enc(query)}&albumCount=20&songCount=40&artistCount=0").searchResult3 ?: SearchResult3()

    fun streamUrl(songId: String) = "$subsonicBase/stream.view?$subsonicQuery&id=${enc(songId)}"
    fun coverArtUrl(id: String?, size: Int = 400) = id?.let { "$subsonicBase/getCoverArt.view?$subsonicQuery&id=${enc(it)}&size=$size" }

    private suspend fun subsonic(method: String, params: String): SubsonicResponse {
        val body = get("$subsonicBase/$method.view?$subsonicQuery&$params", auth = false)
        val r = json.decodeFromString<SubsonicEnvelope>(body).`subsonic-response`
        if (r.status != "ok") throw ApiException(r.error?.code ?: 0, r.error?.message ?: "subsonic error")
        return r
    }

    // ─── transport ────────────────────────────────────────────────────────

    private suspend fun get(url: String, auth: Boolean): String = request("GET", url, null, auth)
    private suspend fun post(url: String, body: String): String = request("POST", url, body, auth = true)

    private suspend fun request(method: String, url: String, body: String?, auth: Boolean): String = withContext(Dispatchers.IO) {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 8_000
            readTimeout = if (method == "POST" && url.endsWith("/video/scan")) 180_000 else 20_000 // scan can take a while
            setRequestProperty("Accept", "application/json")
            if (auth) setRequestProperty("x-device-token", token)
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        try {
            if (body != null) conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) throw ApiException(code, text.take(200))
            text
        } finally {
            conn.disconnect()
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
