package ro.mixai.listen

/** Pure tempo helpers (unit-tested): MIDI clock tick period and tap tempo. */
object TempoMath {
    const val PPQN = 24
    const val MIN_BPM = 40.0
    const val MAX_BPM = 300.0

    /** Nanoseconds between two MIDI clock ticks (0xF8) at [bpm], 24 per quarter note. */
    fun tickNanos(bpm: Double): Long = (60_000_000_000.0 / (bpm.coerceIn(MIN_BPM, MAX_BPM) * PPQN)).toLong()

    /**
     * Tap tempo from tap timestamps (ms, ascending). Uses the last up to 8 intervals, drops intervals that differ
     * from the median by more than 30 % (a missed or double tap), needs at least 2 good intervals. A gap of more
     * than 2 s starts a new tempo, so callers can pass the raw tap history.
     */
    fun tapBpm(tapsMillis: List<Long>): Double? {
        val recent = tapsMillis.takeLastWhileGapUnder(2_000).takeLast(9)
        val gaps = recent.zipWithNext { a, b -> (b - a).toDouble() }.filter { it > 0 }
        if (gaps.size < 2) return null
        val median = gaps.sorted()[gaps.size / 2]
        val good = gaps.filter { kotlin.math.abs(it - median) <= median * 0.3 }
        if (good.size < 2) return null
        return (60_000.0 / good.average()).takeIf { it in MIN_BPM..MAX_BPM }
    }

    private fun List<Long>.takeLastWhileGapUnder(maxGap: Long): List<Long> {
        if (isEmpty()) return this
        var start = lastIndex
        while (start > 0 && this[start] - this[start - 1] <= maxGap) start--
        return subList(start, size)
    }
}
