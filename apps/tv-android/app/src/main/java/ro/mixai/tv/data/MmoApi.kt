package ro.mixai.tv.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** Codecs Media3 plays on Google TV (DD/DD+ decoded or passed through to HDMI). */
private const val TV_CAPS = "h264,hevc,vp9,av1,aac,ac3,eac3,opus,mp3,flac"

class ApiException(val status: Int, message: String) : IOException("HTTP $status: $message")

// Thin HTTP client for one MMO Server: OkHttp (shared [Http.client], also used by the hub
// WebSocket and Coil) + kotlinx.serialization — no Retrofit.
//
// Auth: `x-device-token` header on JSON calls; `?t=<token>` on media URLs
// (Media3 loads those itself and cannot set custom headers per item).
// `u` (userId) is optional for the video routes — `queryAuth` only copies it to
// `x-user-id` when present and `authMiddleware` never reads it.
class MmoApi(val baseUrl: String, private val token: String) {
    /** Extra request headers on every authenticated JSON call (WP16: `x-profile-token` of the active profile). */
    @Volatile var extraHeaders: () -> Map<String, String> = { emptyMap() }

    /** Headers a media loader must send where `?t=` is not accepted (e.g. `/livetv/stream`). */
    fun authHeaders(): Map<String, String> = mapOf("x-device-token" to token)

    /** `ws(s)://host:port/hub?t=<token>` for [HubClient]. */
    fun hubUrl(): String = baseUrl.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/hub?t=${enc(token)}"

    /** Server-relative Subsonic path (`/rest/...`, e.g. `coverUrlPath`) → absolute URL with client params + `apiKey`. */
    fun withApiKey(path: String): String = baseUrl + path + (if (path.contains('?')) "&" else "?") + "v=1.16.1&c=mixaitv&apiKey=${enc(token)}"

    /** Server-relative path → absolute URL with `t=<token>` (routes behind `queryAuth`). */
    fun withToken(path: String): String = baseUrl + path + (if (path.contains('?')) "&" else "?") + "t=${enc(token)}"

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
    /** Always the original video; `caps` lets the server copy audio it can and convert only the rest
     *  (E-AC3 5.1). `startSec` makes the server start AT the resume point — instant resume. */
    fun hlsUrl(fileId: String, startSec: Long = 0L, audio: Int = 0) =
        "$baseUrl/video/stream/$fileId?q=original&caps=$TV_CAPS" + (if (startSec > 0) "&start=$startSec" else "") +
            (if (audio > 0) "&audio=$audio" else "") + "&t=${enc(token)}"
    fun subtitleUrl(fileId: String, ordinal: Int) = "$baseUrl/video/subs/$fileId/$ordinal?t=${enc(token)}"
    /** Scrubber sprite: 12×12 grid of 160×90 tiles, generated lazily by ffmpeg (503 until ready). */
    fun spriteUrl(fileId: String) = "$baseUrl/video/thumbs/$fileId/sprite.jpg?t=${enc(token)}"
    /** Card still: one keyframe ≈10 % into the film, 640 px, cached server-side (~1 s, ~0 CPU). */
    fun stillUrl(fileId: String) = "$baseUrl/video/thumbs/$fileId/still.jpg?t=${enc(token)}"
    /** Cached TMDB image proxy (`/video/tmdb-image/{size}/{path}`); `path` is the TMDB path incl. its leading `/`. */
    fun tmdbImageUrl(size: String, path: String?): String? =
        path?.takeIf { it.isNotBlank() }?.let { "$baseUrl/video/tmdb-image/$size${if (it.startsWith("/")) it else "/$it"}?t=${enc(token)}" }

    // ─── generic JSON transport for feature repositories (MediaRepository) ─

    /** `GET {baseUrl}{path}` with the device token; `path` starts with `/`. */
    suspend fun getJson(path: String): String = get("$baseUrl$path", auth = true)
    suspend fun putJson(path: String, body: String): String = request("PUT", "$baseUrl$path", body, auth = true)
    suspend fun postJson(path: String, body: String): String = request("POST", "$baseUrl$path", body, auth = true)
    suspend fun patchJson(path: String, body: String): String = request("PATCH", "$baseUrl$path", body, auth = true)
    suspend fun deleteJson(path: String): String = request("DELETE", "$baseUrl$path", null, auth = true)
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
        val rb = when {
            body != null -> body.toRequestBody(JSON_TYPE)
            method == "POST" || method == "PUT" || method == "PATCH" -> "".toRequestBody(JSON_TYPE)
            else -> null
        }
        val req = Request.Builder().url(url).method(method, rb).header("Accept", "application/json").apply {
            if (auth) {
                header("x-device-token", token)
                runCatching { extraHeaders() }.getOrNull()?.forEach { (k, v) -> if (v.isNotBlank()) header(k, v) }
            }
        }.build()
        // `/video/scan` walks every root and can take minutes.
        val client = if (method == "POST" && url.endsWith("/video/scan")) Http.slow else Http.client
        client.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw ApiException(res.code, text.take(200))
            text
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private companion object {
        val JSON_TYPE = "application/json".toMediaType()
    }
}

/** One OkHttp connection pool for the app (API, hub WebSocket, Coil). */
object Http {
    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }
    val slow: OkHttpClient by lazy { client.newBuilder().readTimeout(180, TimeUnit.SECONDS).build() }
    /** WebSocket client: no read timeout, protocol pings every 20 s. */
    val ws: OkHttpClient by lazy { client.newBuilder().readTimeout(0, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build() }
}
