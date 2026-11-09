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

/** One saved reading: what played, when, key + tempo (D69 set log). Title/artist come later from ShazamKit. */
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

    suspend fun clear() = withContext(Dispatchers.IO) {
        _entries.value = emptyList()
        file.delete()
    }

    companion object {
        const val MAX = 2000

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
