package ro.mixai.app.ui.player

/** Volume fade window before a timed sleep fires. */
internal const val SLEEP_FADE_MS = 30_000L

/** End-of-episode sleep pauses this close to the end. */
internal const val SLEEP_END_MARGIN_MS = 1_500L

/** Lowest volume reached by the fade (silence: the pause happens at the end of the fade). */
internal const val SLEEP_MIN_VOLUME = 0f

/** Fade curve (D38): quadratic, so loudness drops evenly to the ear; 1.0 at >= 30 s left, 0.0 at 0. */
internal fun sleepFadeCurve(leftMs: Long): Float {
    if (leftMs >= SLEEP_FADE_MS) return 1f
    val x = (leftMs.coerceAtLeast(0L).toFloat() / SLEEP_FADE_MS)
    return SLEEP_MIN_VOLUME + (1f - SLEEP_MIN_VOLUME) * x * x
}

/**
 * Player sleep timer: either N minutes (with a 30 s volume fade) or "end of episode".
 * `now` is a monotonic clock in ms (SystemClock.elapsedRealtime in the app, a fake in tests).
 */
class SleepTimer(private val now: () -> Long) {
    private var endAt: Long? = null
    private var endOfEpisode = false

    /** Minutes chosen (0 = off, -1 = end of episode); for the UI selection. */
    var minutes: Int = 0
        private set

    val active: Boolean get() = endAt != null || endOfEpisode

    fun start(minutes: Int) {
        if (minutes <= 0) { cancel(); return }
        endAt = now() + minutes * 60_000L
        endOfEpisode = false
        this.minutes = minutes
    }

    fun startEndOfEpisode() {
        endAt = null
        endOfEpisode = true
        minutes = -1
    }

    fun cancel() {
        endAt = null
        endOfEpisode = false
        minutes = 0
    }

    /** Time left of a timed sleep; null when off or in end-of-episode mode. */
    fun remainingMs(): Long? = endAt?.let { (it - now()).coerceAtLeast(0L) }

    fun shouldPause(positionMs: Long, durationMs: Long): Boolean {
        val end = endAt
        if (end != null && now() >= end) return true
        return endOfEpisode && durationMs > 0 && positionMs >= durationMs - SLEEP_END_MARGIN_MS
    }

    /** 1.0 until the last 30 s of a timed sleep, then [sleepFadeCurve] down to silence. */
    fun fadeVolume(): Float {
        val left = remainingMs() ?: return 1f
        return sleepFadeCurve(left)
    }

    /** Like [fadeVolume], but end-of-episode mode also fades over the last 30 s before the pause point. */
    fun fadeVolumeAt(positionMs: Long, durationMs: Long): Float {
        if (endOfEpisode) {
            if (durationMs <= 0) return 1f
            return sleepFadeCurve(durationMs - SLEEP_END_MARGIN_MS - positionMs)
        }
        return fadeVolume()
    }
}
