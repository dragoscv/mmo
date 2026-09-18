package ro.mixai.tv.data

import kotlinx.serialization.Serializable

// ─── MMO Server (/health, /video/*) ─────────────────────────────────────────

@Serializable
data class Health(val status: String = "", val version: String = "", val hostname: String = "")

// ─── Quick Connect pairing (/pair/*) ─────────────────────────────────────────

@Serializable
data class PairInfo(
    val name: String = "",
    val version: String = "",
    val lanUrl: String = "",
    val port: Int = 0,
    val pairingSupported: Boolean = false,
    val hasToken: Boolean = false,
)

@Serializable
data class PairRequest(
    val code: String,
    val secret: String,
    val expiresAt: Long = 0,
    val qr: String = "",
    val approveUrl: String = "",
)

@Serializable
data class PairPoll(val status: String = "pending", val deviceToken: String? = null, val userId: String? = null)

@Serializable
data class ParsedName(val title: String = "", val year: Int? = null, val season: Int? = null, val episode: Int? = null)

@Serializable
data class SubtitleTrack(val index: Int = 0, val codec: String = "", val lang: String? = null, val title: String? = null, val forced: Boolean = false)

@Serializable
data class AudioTrack(val index: Int = 0, val codec: String = "", val channels: Int = 2, val lang: String? = null, val title: String? = null)

/** One entry of `POST /video/scan` → `files[]` (probed metadata + parsed filename). */
@Serializable
data class VideoFile(
    val fileId: String,
    val parsed: ParsedName = ParsedName(),
    val path: String = "",
    val container: String? = null,
    val videoCodec: String? = null,
    val audioCodec: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val durationSec: Double? = null,
    val bitrateKbps: Int? = null,
    val hdr: String? = null,
    val audioTracks: List<AudioTrack> = emptyList(),
    val subtitleTracks: List<SubtitleTrack> = emptyList(),
) {
    val title: String get() = parsed.title.ifBlank { path.substringAfterLast('/').substringAfterLast('\\') }

    /** Can Media3 open the original over HTTP range without the server transcoding? */
    val directPlayable: Boolean
        get() {
            val c = container?.lowercase() ?: return false
            val v = videoCodec?.lowercase() ?: ""
            val okContainer = c.contains("mp4") || c.contains("matroska") || c.contains("webm")
            val okVideo = v == "h264" || v == "hevc" || v == "vp9" || v == "av1"
            return okContainer && okVideo
        }
}

@Serializable
data class ScanResponse(val files: List<VideoFile> = emptyList(), val rootsScanned: Int = 0)

/** Episodes of one series grouped by normalised title (`parsed.title.trim().lowercase()`). */
data class Show(val title: String, val episodes: List<VideoFile>) {
    val key: String get() = title.trim().lowercase()
    val seasons: Int get() = episodes.mapNotNull { it.parsed.season }.distinct().size

    companion object {
        fun group(files: List<VideoFile>): List<Show> = files
            .filter { it.parsed.season != null }
            .groupBy { it.parsed.title.trim().lowercase() }
            .map { (_, eps) ->
                val sorted = eps.sortedWith(compareBy({ it.parsed.season ?: 0 }, { it.parsed.episode ?: 0 }))
                Show(sorted.first().parsed.title.trim().ifBlank { sorted.first().title }, sorted)
            }
            .sortedBy { it.key }
    }
}

/** `S01E02` style label; falls back to what is known. */
fun VideoFile.episodeCode(): String {
    val s = parsed.season; val e = parsed.episode
    return when {
        s != null && e != null -> "S%02dE%02d".format(s, e)
        s != null -> "S%02d".format(s)
        else -> ""
    }
}

// ─── OpenSubsonic (/rest/*.view) ─────────────────────────────────────────────

@Serializable
data class SubsonicEnvelope(val `subsonic-response`: SubsonicResponse)

@Serializable
data class SubsonicError(val code: Int = 0, val message: String = "")

@Serializable
data class SubsonicResponse(
    val status: String = "failed",
    val version: String = "",
    val error: SubsonicError? = null,
    val albumList2: AlbumList? = null,
    val album: Album? = null,
    val searchResult3: SearchResult3? = null,
)

@Serializable
data class AlbumList(val album: List<Album> = emptyList())

@Serializable
data class SearchResult3(val album: List<Album> = emptyList(), val song: List<Song> = emptyList())

@Serializable
data class Album(
    val id: String,
    val name: String = "",
    val artist: String? = null,
    val coverArt: String? = null,
    val songCount: Int = 0,
    val duration: Int = 0,
    val year: Int? = null,
    val genre: String? = null,
    val song: List<Song> = emptyList(),
)

@Serializable
data class Song(
    val id: String,
    val title: String = "",
    val album: String? = null,
    val artist: String? = null,
    val coverArt: String? = null,
    val duration: Int? = null,
    val suffix: String? = null,
    val contentType: String? = null,
)
