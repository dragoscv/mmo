package ro.mixai.app.ui.remote

import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

/** Touchpad gesture result. */
enum class Swipe { Left, Right, Up, Down, None }

/** Pure helpers for the phone remote (unit-tested). */
object RemoteMath {
    /** Seek step for a horizontal swipe, in seconds. */
    const val SEEK_STEP_SEC = 10.0

    /** Dominant-axis swipe; a drag shorter than [threshold] on its dominant axis is [Swipe.None]. */
    fun classifySwipe(dx: Float, dy: Float, threshold: Float): Swipe {
        val ax = abs(dx)
        val ay = abs(dy)
        if (ax < threshold && ay < threshold) return Swipe.None
        return if (ax >= ay) {
            if (ax < threshold) Swipe.None else if (dx < 0) Swipe.Left else Swipe.Right
        } else {
            if (ay < threshold) Swipe.None else if (dy < 0) Swipe.Up else Swipe.Down
        }
    }

    /** New position after a relative seek, clamped to 0..duration (no upper bound when duration is unknown). */
    fun seekTarget(pos: Double, delta: Double, duration: Double?): Double {
        val target = pos + delta
        if (duration == null || duration <= 0.0) return maxOf(0.0, target)
        return target.coerceIn(0.0, duration)
    }

    /** "m:ss" below one hour, "h:mm:ss" above. Negative or NaN values show as 0:00. */
    fun formatClock(sec: Double): String {
        val total = if (sec.isNaN() || sec < 0) 0L else floor(sec).toLong()
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        return if (h > 0) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, s) else String.format(Locale.ROOT, "%d:%02d", m, s)
    }
}
