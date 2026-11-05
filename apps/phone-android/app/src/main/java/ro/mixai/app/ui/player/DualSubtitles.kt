package ro.mixai.app.ui.player

/** One WebVTT cue in ABSOLUTE media time (the server `/video/subs` route extracts the whole track). */
data class VttCue(val startMs: Long, val endMs: Long, val text: String)

/**
 * Minimal WebVTT reader for the second (dual) subtitle line: `HH:MM:SS.mmm` or `MM:SS.mmm` stamps, cue
 * settings ignored, voice/style tags stripped. Pure, unit-tested.
 */
object Vtt {
    private val stamp = Regex("""(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})""")
    private val tag = Regex("<[^>]+>")

    fun parseTime(s: String): Long? {
        val m = stamp.find(s.trim()) ?: return null
        val h = m.groupValues[1].toLongOrNull() ?: 0L
        val min = m.groupValues[2].toLong()
        val sec = m.groupValues[3].toLong()
        val frac = m.groupValues[4]
        val ms = frac.padEnd(3, '0').take(3).toLong()
        return ((h * 60 + min) * 60 + sec) * 1000 + ms
    }

    fun parse(text: String): List<VttCue> {
        val out = mutableListOf<VttCue>()
        val lines = text.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            if (line.contains("-->")) {
                val parts = line.split("-->")
                val start = parseTime(parts[0])
                val end = parts.getOrNull(1)?.let { parseTime(it.trim().substringBefore(' ')) }
                i++
                val body = StringBuilder()
                while (i < lines.size && lines[i].isNotBlank()) {
                    if (body.isNotEmpty()) body.append('\n')
                    body.append(lines[i].replace(tag, "").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
                    i++
                }
                if (start != null && end != null && end > start && body.isNotBlank()) out += VttCue(start, end, body.toString().trim())
            } else {
                i++
            }
        }
        return out.sortedBy { it.startMs }
    }

    /** Text of the cues active at [positionMs] (joined by newline), or null. */
    fun activeText(cues: List<VttCue>, positionMs: Long): String? {
        if (cues.isEmpty()) return null
        // Binary search for the last cue starting at or before the position, then scan back over overlaps.
        var lo = 0
        var hi = cues.size - 1
        var idx = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (cues[mid].startMs <= positionMs) { idx = mid; lo = mid + 1 } else hi = mid - 1
        }
        if (idx < 0) return null
        val active = mutableListOf<String>()
        var j = idx
        while (j >= 0 && idx - j < 8) {
            val c = cues[j]
            if (positionMs < c.endMs) active.add(0, c.text)
            j--
        }
        return active.takeIf { it.isNotEmpty() }?.joinToString("\n")
    }
}
