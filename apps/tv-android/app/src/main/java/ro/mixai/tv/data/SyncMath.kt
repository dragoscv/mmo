package ro.mixai.tv.data

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

// 1:1 port of server/src/hub/sync-math.ts (WP16-08) — keep the constants identical.
// SyncPlay-style clock sync:
//   offset = ((t1 - t0) + (t2 - t3)) / 2, RTT = (t3 - t0) - (t2 - t1)
//   keep the 8 latest samples, trust the lowest RTT, smooth with EMA α = 0.4.

data class ClockSample(val offsetMs: Double, val rttMs: Double)

fun sampleFrom(t0: Double, t1: Double, t2: Double, t3: Double): ClockSample =
    ClockSample(offsetMs = ((t1 - t0) + (t2 - t3)) / 2, rttMs = max(0.0, (t3 - t0) - (t2 - t1)))

class ClockEstimator(private val window: Int = 8, private val alpha: Double = 0.4) {
    private val samples = ArrayDeque<ClockSample>()
    private var ema: Double? = null

    @Synchronized
    fun add(s: ClockSample) {
        samples.addLast(s)
        if (samples.size > window) samples.removeFirst()
        val best = best() ?: return
        val e = ema
        ema = if (e == null) best.offsetMs else e + alpha * (best.offsetMs - e)
    }

    @Synchronized
    fun best(): ClockSample? = samples.fold(null as ClockSample?) { a, s -> if (a == null || s.rttMs < a.rttMs) s else a }

    /** serverTime ≈ localTime + offset */
    val offsetMs: Double @Synchronized get() = ema ?: 0.0
    val rttMs: Double get() = best()?.rttMs ?: 0.0
    val count: Int @Synchronized get() = samples.size
}

/** `positionSec` was true at server time `atServerMs`. */
data class PlaybackAnchor(val playing: Boolean, val positionSec: Double, val atServerMs: Double, val rate: Double? = null)

/** Where the media should be at `serverNowMs`. */
fun expectedPosition(a: PlaybackAnchor, serverNowMs: Double): Double {
    if (!a.playing) return a.positionSec
    return a.positionSec + max(0.0, serverNowMs - a.atServerMs) / 1000 * (a.rate ?: 1.0)
}

sealed interface DriftAction {
    data object None : DriftAction
    data class Rate(val rate: Double) : DriftAction
    data class Seek(val positionSec: Double) : DriftAction
}

const val DRIFT_START_MS = 120.0
const val DRIFT_STOP_MS = 40.0
const val DRIFT_SEEK_MS = 1500.0

/**
 * Hysteresis drift correction: start nudging the playback rate above 120 ms, stop below 40 ms,
 * hard-seek above 1.5 s. drift = actual - expected (seconds); positive = ahead → slow down.
 */
fun driftAction(actualSec: Double, expectedSec: Double, correcting: Boolean): DriftAction {
    val driftMs = (actualSec - expectedSec) * 1000
    val a = abs(driftMs)
    if (a >= DRIFT_SEEK_MS) return DriftAction.Seek(expectedSec)
    if (a < DRIFT_STOP_MS || (!correcting && a < DRIFT_START_MS)) return DriftAction.None
    // Proportional, clamped to ±5 % so the audio pitch change stays inaudible.
    val rate = 1 - max(-0.05, min(0.05, driftMs / 1000 / 4))
    return DriftAction.Rate(jsRound(rate * 1000) / 1000.0)
}

/** Lead time for a scheduled command: slowest member RTT + 150 ms, clamped 150..2000 ms. */
fun leadTimeMs(rtts: List<Double>): Long {
    val mx = rtts.maxOrNull() ?: 0.0
    return max(150L, min(2000L, jsRound(mx + 150)))
}

/** JavaScript `Math.round` (half rounds towards +∞). */
private fun jsRound(x: Double): Long = kotlin.math.floor(x + 0.5).roundToLong()

/**
 * Stateful wrapper around [driftAction]: remembers whether a rate correction is in progress
 * (the hysteresis input) so a player can call [update] once per report tick.
 */
class DriftCorrector {
    var correcting: Boolean = false
        private set

    fun update(actualSec: Double, expectedSec: Double): DriftAction {
        val act = driftAction(actualSec, expectedSec, correcting)
        correcting = act is DriftAction.Rate
        return act
    }

    fun reset() { correcting = false }
}
