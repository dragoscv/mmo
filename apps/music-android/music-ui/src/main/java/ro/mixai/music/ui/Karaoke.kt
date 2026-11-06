package ro.mixai.music.ui

/** One timed unit of an enhanced-LRC line; [text] keeps its trailing whitespace. */
data class KaraokeWord(val text: String, val startMs: Long)

/**
 * Enhanced-LRC inline word tags, e.g. `<00:12.34>Hello <00:12.80>world`.
 * The server keeps these tags raw inside the lyric line text. Pure, no Android deps.
 */
object Karaoke {
    private val TAG = Regex("""<(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?>""")

    /** True when the line carries at least one well-formed inline word tag. */
    fun hasWordTiming(line: String): Boolean = TAG.containsMatchIn(line)

    /** The line with every well-formed tag removed; malformed tags stay as text. */
    fun plainText(line: String): String = TAG.replace(line, "")

    /**
     * Splits [line] into timed words. Text before the first tag starts at [lineStartMs]; tag times are
     * clamped to [lineStartMs, nextLineStartMs]. Concatenating the word texts equals [plainText].
     */
    fun parse(line: String, lineStartMs: Long, nextLineStartMs: Long?): List<KaraokeWord> {
        val matches = TAG.findAll(line).toList()
        if (matches.isEmpty()) return if (line.isEmpty()) emptyList() else listOf(KaraokeWord(line, lineStartMs))
        val words = ArrayList<KaraokeWord>(matches.size + 1)
        val lead = line.substring(0, matches.first().range.first)
        if (lead.isNotEmpty()) words += KaraokeWord(lead, lineStartMs)
        matches.forEachIndexed { i, m ->
            val end = if (i + 1 < matches.size) matches[i + 1].range.first else line.length
            val text = line.substring(m.range.last + 1, end)
            if (text.isNotEmpty()) words += KaraokeWord(text, clamp(tagMs(m), lineStartMs, nextLineStartMs))
        }
        return words
    }

    /** Index of the last word whose start is at or before [positionMs]; -1 before the first word. */
    fun activeWordIndex(words: List<KaraokeWord>, positionMs: Long): Int = words.indexOfLast { it.startMs <= positionMs }

    private fun tagMs(m: MatchResult): Long {
        val min = m.groupValues[1].toLong()
        val sec = m.groupValues[2].toLong()
        val frac = m.groupValues[3]
        val fracMs = when (frac.length) {
            0 -> 0L
            1 -> frac.toLong() * 100
            2 -> frac.toLong() * 10
            else -> frac.toLong()
        }
        return min * 60_000 + sec * 1_000 + fracMs
    }

    private fun clamp(ms: Long, lo: Long, hi: Long?): Long {
        val atLeast = maxOf(ms, lo)
        return if (hi != null && hi >= lo) minOf(atLeast, hi) else atLeast
    }
}
