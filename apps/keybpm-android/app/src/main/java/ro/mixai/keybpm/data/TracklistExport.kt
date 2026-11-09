package ro.mixai.keybpm.data

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Tracklist exports of the set log (oldest first = set order): plain text for Mixcloud/YouTube/SoundCloud
 * descriptions, M3U8 for players and rekordbox XML for DJ software. M3U8/XML entries carry a file location only
 * when the track is in the user's MixAI library ([LogEntry.libraryPath]); otherwise players show title/artist.
 */
object TracklistExport {
    private fun ordered(entries: List<LogEntry>) = entries.sortedBy { it.atMillis }

    private fun label(e: LogEntry) = when {
        e.title != null && e.artist != null -> "${e.artist} – ${e.title}"
        e.title != null -> e.title
        else -> null
    }

    /** `01. Artist – Title (5A · 125)` with `[0:00]` offsets from the first entry; unidentified = `ID – ID`. */
    fun text(entries: List<LogEntry>): String {
        val list = ordered(entries)
        val t0 = list.firstOrNull()?.atMillis ?: return ""
        return list.mapIndexed { i, e ->
            val off = (e.atMillis - t0) / 1000
            val stamp = if (off >= 3600) "%d:%02d:%02d".format(off / 3600, off / 60 % 60, off % 60) else "%d:%02d".format(off / 60, off % 60)
            "%02d. [%s] %s (%s · %s)".format(Locale.ROOT, i + 1, stamp, label(e) ?: "ID – ID", e.camelot, "%.0f".format(Locale.ROOT, e.bpm))
        }.joinToString("\n") + "\n"
    }

    fun m3u8(entries: List<LogEntry>): String = buildString {
        append("#EXTM3U\n")
        for (e in ordered(entries)) {
            val name = label(e) ?: "ID (${e.camelot} · ${"%.0f".format(Locale.ROOT, e.bpm)} BPM)"
            append("#EXTINF:-1,").append(name.replace('\n', ' ')).append('\n')
            append(e.libraryPath ?: "# not in library").append('\n')
        }
    }

    /** rekordbox `DJ_PLAYLISTS` 1.0.0: one COLLECTION track per entry + one playlist in set order. */
    fun rekordboxXml(entries: List<LogEntry>, name: String, zone: ZoneId = ZoneId.systemDefault()): String {
        fun x(s: String?) = (s ?: "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
        val list = ordered(entries)
        val day = DateTimeFormatter.ISO_LOCAL_DATE
        return buildString {
            append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<DJ_PLAYLISTS Version=\"1.0.0\">\n")
            append("  <PRODUCT Name=\"MixAI Key &amp; BPM\" Version=\"1\" Company=\"MixAI\"/>\n")
            append("  <COLLECTION Entries=\"${list.size}\">\n")
            list.forEachIndexed { i, e ->
                val loc = e.libraryPath?.let { "file://localhost/" + it.replace('\\', '/').trimStart('/').replace(" ", "%20") } ?: ""
                val added = Instant.ofEpochMilli(e.atMillis).atZone(zone).toLocalDate().format(day)
                append("    <TRACK TrackID=\"${i + 1}\" Name=\"${x(e.title ?: "ID")}\" Artist=\"${x(e.artist)}\" ")
                append("AverageBpm=\"${"%.2f".format(Locale.ROOT, e.bpm)}\" Tonality=\"${x(e.camelot)}\" DateAdded=\"$added\" ")
                append("Comments=\"${x(e.keyName)}\" Location=\"${x(loc)}\"/>\n")
            }
            append("  </COLLECTION>\n  <PLAYLISTS>\n    <NODE Type=\"0\" Name=\"ROOT\" Count=\"1\">\n")
            append("      <NODE Name=\"${x(name)}\" Type=\"1\" KeyType=\"0\" Entries=\"${list.size}\">\n")
            list.indices.forEach { append("        <TRACK Key=\"${it + 1}\"/>\n") }
            append("      </NODE>\n    </NODE>\n  </PLAYLISTS>\n</DJ_PLAYLISTS>\n")
        }
    }
}
