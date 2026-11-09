package ro.mixai.keybpm.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/** One saved reading: what played, when, key + tempo (D69 set log); title/artist/ISRC from Song ID (WP18-06). */
@Serializable
data class LogEntry(
    val atMillis: Long,
    val camelot: String,
    val keyName: String,
    val bpm: Double,
    val keyConfidence: Double,
    val source: String,
    val title: String? = null,
    val artist: String? = null,
    val isrc: String? = null,
    val artworkUrl: String? = null,
    val appleMusicUrl: String? = null,
    /** MixAI library track id (`tr_N`) when the identified song is in the user's own library. */
    val libraryTrackId: String? = null,
    /** Key/BPM the library analysed for that track (sanity check against the live reading). */
    val libraryCamelot: String? = null,
    val libraryBpm: Double? = null,
    /** Absolute file path on the server (M3U8 / rekordbox export only). */
    val libraryPath: String? = null,
)

/** App-private JSON file, newest first, capped at 2000 entries. Nothing leaves the device unless the user exports. */
class SetLog(context: Context) {
    private val file = File(context.filesDir, "setlog.json")
    private val json = Json { ignoreUnknownKeys = true }
    private val _entries = MutableStateFlow<List<LogEntry>>(emptyList())
    val entries: StateFlow<List<LogEntry>> = _entries.asStateFlow()

    suspend fun load() = withContext(Dispatchers.IO) {
        _entries.value = runCatching { json.decodeFromString<List<LogEntry>>(file.readText()) }.getOrDefault(emptyList())
    }

    suspend fun add(e: LogEntry) = withContext(Dispatchers.IO) {
        val next = (listOf(e) + _entries.value).take(MAX)
        _entries.value = next
        file.writeText(json.encodeToString(next))
    }

    suspend fun remove(atMillis: Long) = withContext(Dispatchers.IO) {
        val next = _entries.value.filterNot { it.atMillis == atMillis }
        _entries.value = next
        file.writeText(json.encodeToString(next))
    }

    /**
     * Applies Song ID to an entry. When the same recording (ISRC, else title + artist) was identified on another
     * entry within [DEDUPE_MS], the two are one song (e.g. a key change inside the track): the newer entry is
     * dropped and the older one keeps its time. Returns the surviving entry's time.
     */
    suspend fun update(atMillis: Long, change: (LogEntry) -> LogEntry): Long? = withContext(Dispatchers.IO) {
        val cur = _entries.value
        val target = cur.firstOrNull { it.atMillis == atMillis } ?: return@withContext null
        val updated = change(target)
        val dup = cur.firstOrNull { it.atMillis != atMillis && sameSong(it, updated) && kotlin.math.abs(it.atMillis - atMillis) <= DEDUPE_MS }
        val next = when {
            dup == null -> cur.map { if (it.atMillis == atMillis) updated else it }
            dup.atMillis < atMillis -> cur.filterNot { it.atMillis == atMillis }
            else -> cur.filterNot { it.atMillis == dup.atMillis }.map { if (it.atMillis == atMillis) updated else it }
        }
        _entries.value = next
        file.writeText(json.encodeToString(next))
        if (dup != null && dup.atMillis < atMillis) dup.atMillis else atMillis
    }

    suspend fun clear() = withContext(Dispatchers.IO) {
        _entries.value = emptyList()
        file.delete()
    }

    companion object {
        const val MAX = 2000
        const val DEDUPE_MS = 10L * 60 * 1000

        fun sameSong(a: LogEntry, b: LogEntry): Boolean = when {
            a.isrc != null && b.isrc != null -> a.isrc.equals(b.isrc, ignoreCase = true)
            a.title != null && b.title != null && a.source == "mic" && b.source == "mic" ->
                a.title.equals(b.title, ignoreCase = true) && (a.artist ?: "").equals(b.artist ?: "", ignoreCase = true)
            else -> false
        }

        /** RFC 4180 CSV, oldest first (set order), ISO-8601 local time. */
        fun toCsv(entries: List<LogEntry>, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
            fun q(s: String?) = if (s == null) "" else "\"" + s.replace("\"", "\"\"") + "\""
            val fmt = java.time.format.DateTimeFormatter.ISO_LOCAL_DATE_TIME
            val rows = entries.sortedBy { it.atMillis }.map { e ->
                val t = java.time.Instant.ofEpochMilli(e.atMillis).atZone(zone).toLocalDateTime().withNano(0).format(fmt)
                listOf(t, e.camelot, q(e.keyName), "%.1f".format(java.util.Locale.ROOT, e.bpm),
                    "%.2f".format(java.util.Locale.ROOT, e.keyConfidence), e.source, q(e.title), q(e.artist)).joinToString(",")
            }
            return (listOf("time,camelot,key,bpm,key_confidence,source,title,artist") + rows).joinToString("\r\n") + "\r\n"
        }
    }
}
