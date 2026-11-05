package ro.mixai.app.ui.player

import kotlin.math.max
import kotlin.math.min

// Pure gesture math for the touch player (unit-tested on the JVM, no Android types).

/** Seek step of one double tap. */
internal const val DOUBLE_TAP_STEP_MS = 10_000L

/** A full-width horizontal drag spans this much media time at most. */
internal const val FULL_DRAG_SPAN_MS = 10 * 60_000L

/** Last position a seek may land on (one second before the end); unknown duration → unbounded. */
private fun maxSeek(durationMs: Long): Long = if (durationMs > 0) max(0L, durationMs - 1_000L) else Long.MAX_VALUE

/**
 * Horizontal scrub: a drag over the whole width moves `min(duration, 10 min)`.
 * Result clamped to `[0, duration - 1000]`.
 */
fun seekTargetMs(startMs: Long, dragPx: Float, widthPx: Float, durationMs: Long): Long {
    if (widthPx <= 0f) return startMs.coerceIn(0L, maxSeek(durationMs))
    val span = if (durationMs > 0) min(durationMs, FULL_DRAG_SPAN_MS) else FULL_DRAG_SPAN_MS
    val delta = (dragPx / widthPx * span).toLong()
    return (startMs + delta).coerceIn(0L, maxSeek(durationMs))
}

/** `taps` double taps from `currentMs`, 10 s each, forward or back, clamped to `[0, duration - 1000]`. */
fun doubleTapSeek(currentMs: Long, taps: Int, forward: Boolean, durationMs: Long): Long {
    val delta = DOUBLE_TAP_STEP_MS * taps.coerceAtLeast(0)
    val target = if (forward) currentMs + delta else currentMs - delta
    return target.coerceIn(0L, maxSeek(durationMs))
}

/**
 * Brightness / volume level after a vertical drag. `dragPx` is the raw pointer delta (positive = down),
 * so dragging UP the full height adds 1. Clamped to `0..1`.
 */
fun levelAfterDrag(start: Float, dragPx: Float, heightPx: Float): Float {
    if (heightPx <= 0f) return start.coerceIn(0f, 1f)
    return (start - dragPx / heightPx).coerceIn(0f, 1f)
}
