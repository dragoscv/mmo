package ro.mixai.keybpm.songid

import kotlinx.serialization.Serializable
import java.net.URLEncoder
import java.text.Normalizer

/** One Shazam catalog match, reduced to what the app stores and shows (WP18-06). */
@Serializable
data class SongMatch(
    val title: String,
    val artist: String? = null,
    val isrc: String? = null,
    val shazamId: String? = null,
    val artworkUrl: String? = null,
    val appleMusicUrl: String? = null,
    val webUrl: String? = null,
)

/** Outcome of one identification attempt. */
sealed interface SongIdResult {
    data class Match(val song: SongMatch) : SongIdResult
    data object NoMatch : SongIdResult
    /** Network/server trouble: the signature was kept and will be retried when online. */
    data class Queued(val reason: String) : SongIdResult
    data class Failed(val reason: String) : SongIdResult
}

/** Opaque signature the engine can match later (offline queue). */
@Serializable
data class StoredSignature(val data: String, val durationMs: Long, val createdAtMillis: Long, val entryAtMillis: Long? = null)

/**
 * Song ID engine. The ShazamKit implementation lives in `src/shazam` and is compiled only when the Apple AAR is
 * present (it is not redistributable, so public CI builds the `src/noshazam` stub where [available] is false).
 */
interface SongIdEngine {
    val available: Boolean
    /** Identify mono PCM16 little-endian audio at [sampleRate] (48 000 or 44 100). */
    suspend fun identify(pcm16: ByteArray, sampleRate: Int, entryAtMillis: Long?): SongIdResult
    /** Re-match a signature stored while offline. */
    suspend fun retry(stored: StoredSignature): SongIdResult
}

/** Circular buffer of the last [seconds] of PCM16 mono, fed from the capture thread. */
class PcmRing(val sampleRate: Int, seconds: Int) {
    private val buf = ByteArray(sampleRate * seconds * 2)
    private var write = 0
    private var filled = 0

    @Synchronized
    fun push(samples: FloatArray, count: Int = samples.size) {
        for (i in 0 until count) {
            val v = (samples[i].coerceIn(-1f, 1f) * 32767f).toInt()
            buf[write] = (v and 0xFF).toByte()
            buf[write + 1] = ((v shr 8) and 0xFF).toByte()
            write = (write + 2) % buf.size
        }
        filled = minOf(buf.size, filled + count * 2)
    }

    @get:Synchronized
    val filledSeconds: Double get() = filled / 2.0 / sampleRate

    /** The most recent audio, oldest first, at most [maxSeconds]. */
    @Synchronized
    fun snapshot(maxSeconds: Double = Double.MAX_VALUE): ByteArray {
        val wantBytes = (maxSeconds * sampleRate).toLong().coerceIn(0L, filled / 2L) * 2L
        val want = wantBytes.toInt()
        val out = ByteArray(want)
        var start = (write - want + buf.size) % buf.size
        for (i in 0 until want) {
            out[i] = buf[start]
            start = (start + 1) % buf.size
        }
        return out
    }

    @Synchronized
    fun clear() {
        write = 0
        filled = 0
    }
}

/** Library lookup + outbound links for a match. */
object SongLinks {
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
    fun query(m: SongMatch) = listOfNotNull(m.artist, m.title).joinToString(" ")
    fun spotify(m: SongMatch) = "https://open.spotify.com/search/" + enc(query(m)).replace("+", "%20")
    fun youtubeMusic(m: SongMatch) = "https://music.youtube.com/search?q=" + enc(query(m))
}

/** Fuzzy title/artist equality for "is this match in my MixAI library". */
object LibraryMatching {
    fun normalize(s: String?): String {
        if (s.isNullOrBlank()) return ""
        val noMarks = Normalizer.normalize(s.lowercase(), Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "")
        return noMarks
            .replace(Regex("\\((feat|ft|with)[^)]*\\)|\\[(feat|ft|with)[^]]*]"), " ")
            .replace(Regex("\\s(feat|ft)\\.?\\s.*$"), " ")
            .replace(Regex("[^a-z0-9]+"), " ")
            .trim()
    }

    /** Title must match (ignoring "(Original Mix)"-style suffixes); artist must overlap when both are known. */
    fun matches(matchTitle: String, matchArtist: String?, title: String, artist: String?): Boolean {
        val a = normalize(matchTitle)
        val b = normalize(title)
        if (a.isEmpty() || b.isEmpty()) return false
        val titleOk = a == b || stripMix(a) == stripMix(b)
        if (!titleOk) return false
        val ma = normalize(matchArtist)
        val ta = normalize(artist)
        if (ma.isEmpty() || ta.isEmpty()) return true
        val wa = ma.split(' ').toSet()
        val wb = ta.split(' ').toSet()
        return ma.contains(ta) || ta.contains(ma) || wa.intersect(wb).any { it.length > 2 }
    }

    private fun stripMix(s: String) = s.replace(Regex("\\s(original|extended|radio|club)?\\s?(mix|edit|version)$"), "").trim()
}
