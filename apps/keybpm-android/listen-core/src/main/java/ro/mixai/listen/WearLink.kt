package ro.mixai.listen

/**
 * Phone ↔ watch protocol for MixAI Key & BPM (WP18-04). The phone streams the live reading to the watch with the
 * Wearable `MessageClient` on [PATH_LIVE] (≤ 2/s, only on change + a 2 s heartbeat) and keeps the last locked reading
 * in a `DataClient` item on [PATH_LAST] (tile / complication read it when the phone is gone). Payload = one short
 * UTF-8 line so both ends stay dependency-free and old/new builds tolerate extra fields.
 */
object WearLink {
    const val PATH_LIVE = "/keybpm/live"
    const val PATH_LAST = "/keybpm/last"
    const val KEY_LINE = "line"
    const val CAPABILITY_PHONE = "mixai_keybpm_phone"
    const val CAPABILITY_WATCH = "mixai_keybpm_watch"
    private const val VERSION = "v1"

    data class Reading(
        val listening: Boolean,
        /** mixai-listen key index (tonic + 12 when minor), null before a key reading. */
        val keyIndex: Int? = null,
        val keyLocked: Boolean = false,
        val bpm: Double? = null,
        val tempoLocked: Boolean = false,
        /** Milliseconds from [atMillis] to the next predicted beat (haptic sync), null without tempo. */
        val nextBeatMs: Long? = null,
        /** Sender wall clock when the reading was taken. */
        val atMillis: Long = 0,
        /** Song ID title when known ("Title — Artist"). */
        val title: String? = null,
    )

    fun encode(r: Reading): String = listOf(
        VERSION,
        if (r.listening) "1" else "0",
        r.keyIndex?.toString().orEmpty(),
        if (r.keyLocked) "1" else "0",
        r.bpm?.let { "%.2f".format(java.util.Locale.ROOT, it) }.orEmpty(),
        if (r.tempoLocked) "1" else "0",
        r.nextBeatMs?.toString().orEmpty(),
        r.atMillis.toString(),
        r.title.orEmpty().replace(';', ',').take(120),
    ).joinToString(";")

    /** Null for an unknown version or a malformed line (never throws: the other end may be a newer build). */
    fun decode(line: String): Reading? {
        val p = line.split(';')
        if (p.size < 8 || p[0] != VERSION) return null
        return runCatching {
            Reading(
                listening = p[1] == "1",
                keyIndex = p[2].toIntOrNull()?.takeIf { it in 0..23 },
                keyLocked = p[3] == "1",
                bpm = p[4].toDoubleOrNull()?.takeIf { it > 0 },
                tempoLocked = p[5] == "1",
                nextBeatMs = p[6].toLongOrNull(),
                atMillis = p[7].toLongOrNull() ?: 0,
                title = p.getOrNull(8)?.takeIf { it.isNotBlank() },
            )
        }.getOrNull()
    }

    /** Whether a new reading is worth sending now (state change, or heartbeat after [heartbeatMs]). */
    fun shouldSend(prev: Reading?, next: Reading, sinceLastMs: Long, minGapMs: Long = 500, heartbeatMs: Long = 2_000): Boolean {
        if (prev == null) return true
        if (prev.listening != next.listening) return true
        if (sinceLastMs < minGapMs) return false
        if (prev.keyIndex != next.keyIndex || prev.keyLocked != next.keyLocked || prev.tempoLocked != next.tempoLocked) return true
        val pb = prev.bpm
        val nb = next.bpm
        if ((pb == null) != (nb == null)) return true
        if (pb != null && nb != null && kotlin.math.abs(pb - nb) >= 0.3) return true
        if (prev.title != next.title) return true
        return sinceLastMs >= heartbeatMs
    }
}

/**
 * Beat clock for haptics and pulses: turns "next beat in X ms at BPM" snapshots into a stable beat grid. Small
 * corrections are smoothed (the engine's phase jitters by a few ms), a jump of more than a quarter period resyncs.
 */
class BeatClock {
    var periodMs: Double = 0.0
        private set
    private var nextBeatAt = 0.0
    var beatIndex = 0L
        private set

    val running: Boolean get() = periodMs > 0

    fun stop() {
        periodMs = 0.0
    }

    fun update(bpm: Double, nextBeatInMs: Double, nowMs: Double) {
        if (bpm <= 0) { stop(); return }
        val p = 60_000.0 / bpm
        val observed = nowMs + nextBeatInMs
        if (!running) {
            periodMs = p
            nextBeatAt = observed
            beatIndex = 0
            return
        }
        periodMs = p
        // Bring the predicted grid next to the observation, then nudge (a beat that is due but not yet played stays).
        while (nextBeatAt < nowMs - LATE_MS) { nextBeatAt += periodMs; beatIndex++ }
        var err = observed - nextBeatAt
        if (err > periodMs / 2) err -= periodMs
        if (err < -periodMs / 2) err += periodMs
        nextBeatAt += if (kotlin.math.abs(err) > periodMs / 4) err else err * 0.25
    }

    /**
     * Milliseconds until the next beat (0 when due) and skips beats missed by more than [LATE_MS] (a timer that wakes
     * a few ms late still plays its beat — skipping those made the watch haptics irregular). Null when stopped.
     */
    fun untilNext(nowMs: Double): Double? {
        if (!running) return null
        while (nextBeatAt < nowMs - LATE_MS) { nextBeatAt += periodMs; beatIndex++ }
        return (nextBeatAt - nowMs).coerceAtLeast(0.0)
    }

    /** Marks the current beat as played; returns its index (accent on index % 4 == 0). */
    fun consume(): Long {
        val i = beatIndex
        nextBeatAt += periodMs
        beatIndex++
        return i
    }

    private companion object {
        const val LATE_MS = 60.0
    }
}
