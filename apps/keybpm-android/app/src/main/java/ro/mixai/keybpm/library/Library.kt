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

/** Subset of `GET /media/music/search` (`MusicSearch.tracks[]` = TrackCard). */
@Serializable
data class SearchTrack(
    val id: String = "",
    val title: String = "",
    val artist: String? = null,
    val bpm: Double? = null,
    val keyCamelot: String? = null,
)

@Serializable
data class SearchResponse(val tracks: List<SearchTrack> = emptyList())

/** `GET /library/tracks/{n}` → `{track: {filepath}}` (needs `x-user-id`). */
@Serializable
private data class LibraryTrackEnvelope(val track: LibraryTrackRow? = null)

@Serializable
private data class LibraryTrackRow(val filepath: String? = null)

@Serializable
private data class QueueState(val trackIds: List<String> = emptyList(), val index: Long = 0)

object Library {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false }

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

    /** Finds an identified song in the user's library (title + artist fuzzy match over the server search). */
    suspend fun findSong(api: MmoApi, title: String, artist: String?): SearchTrack? {
        val q = listOfNotNull(artist, title).joinToString(" ")
        val hits = json.decodeFromString<SearchResponse>(api.getJson("/media/music/search?q=" + api.encode(q))).tracks
        val alt = if (artist != null) json.decodeFromString<SearchResponse>(api.getJson("/media/music/search?q=" + api.encode(title))).tracks else emptyList()
        return (hits + alt).firstOrNull { ro.mixai.keybpm.songid.LibraryMatching.matches(title, artist, it.title, it.artist) }
    }

    /** Server file path of a `tr_N` track (best effort; null when the route or user header is unavailable). */
    suspend fun filePath(api: MmoApi, trackId: String): String? = runCatching {
        val n = trackId.removePrefix("tr_").toLongOrNull() ?: return null
        json.decodeFromString<LibraryTrackEnvelope>(api.getJson("/library/tracks/$n")).track?.filepath
    }.getOrNull()

    /** Appends a track to the active MixAI Music queue (shared across the user's devices). */
    suspend fun addToQueue(api: MmoApi, profile: String, trackId: String) {
        val p = api.encode(profile.ifBlank { "default" })
        val cur = json.decodeFromString<QueueState>(api.getJson("/media/music/queue?profile=$p"))
        if (trackId in cur.trackIds) return
        val body = buildString {
            append("{\"trackIds\":[")
            append((cur.trackIds + trackId).joinToString(",") { "\"" + it.replace("\"", "") + "\"" })
            append("],\"index\":").append(cur.index).append('}')
        }
        api.putJson("/media/music/queue?profile=$p", body)
    }
}
