package ro.mixai.live.core

/**
 * Leading + trailing throttle for slider drags: sends at most once per [intervalMs]; the last value of a burst is
 * always delivered via [flush] (call on drag end). Pure: the caller passes the clock.
 */
class Throttle<T>(private val intervalMs: Long = 30, private val sink: (T) -> Unit) {
    private var lastSent = Long.MIN_VALUE / 2
    private var pending: T? = null
    private var hasPending = false

    fun offer(value: T, nowMs: Long) {
        if (nowMs - lastSent >= intervalMs) {
            lastSent = nowMs
            hasPending = false
            pending = null
            sink(value)
        } else {
            pending = value
            hasPending = true
        }
    }

    /** Delivers the held value if one is pending (end of drag, or a timer tick). */
    fun flush(nowMs: Long) {
        if (!hasPending) return
        @Suppress("UNCHECKED_CAST")
        val v = pending as T
        hasPending = false
        pending = null
        lastSent = nowMs
        sink(v)
    }
}
