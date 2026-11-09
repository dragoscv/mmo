package ro.mixai.keybpm.library

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import ro.mixai.tv.data.MmoApi

/** `GET /media/music/compatible` (server 3.14.0, WP18-24): tracks + 0..1 score, best first. */
@Serializable
data class CompatibleTrack(
    val id: String = "",
    val title: String = "",
    val artist: String? = null,
    val album: String? = null,
    val bpm: Double? = null,
    val keyCamelot: String? = null,
    val coverUrlPath: String = "",
    val score: Double = 0.0,
)

@Serializable
data class CompatibleResponse(val key: String? = null, val bpm: Double? = null, val tracks: List<CompatibleTrack> = emptyList())

object Library {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    fun path(camelot: String?, bpm: Double?, limit: Int = 30): String {
        val q = buildList {
            camelot?.let { add("key=" + java.net.URLEncoder.encode(it, "UTF-8")) }
            bpm?.let { add("bpm=" + "%.2f".format(java.util.Locale.ROOT, it)) }
            add("limit=$limit")
        }
        return "/media/music/compatible?" + q.joinToString("&")
    }

    fun parse(body: String): CompatibleResponse = json.decodeFromString(body)

    suspend fun compatible(api: MmoApi, camelot: String?, bpm: Double?): CompatibleResponse = parse(api.getJson(path(camelot, bpm)))

    /** Deep link understood by MixAI Music (WP17-45 canonical set). */
    fun playLink(trackId: String): String = "mixai-music://play?ids=" + java.net.URLEncoder.encode(trackId, "UTF-8") + "&index=0"
}
