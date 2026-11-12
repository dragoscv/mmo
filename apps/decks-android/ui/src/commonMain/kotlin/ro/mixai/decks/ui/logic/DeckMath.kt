package ro.mixai.decks.ui.logic

import kotlin.math.floor
import kotlin.math.roundToInt

/** Pure DJ math used by the UI and MIDI dispatch (unit-tested). */
object DeckMath {
    /** Tempo ranges a DJ cycles through (fraction, ±). */
    val TEMPO_RANGES = listOf(0.06, 0.08, 0.16, 0.50)

    /** Fader position -1..1 -> tempo ratio for a ±range. */
    fun faderToRatio(fader: Float, range: Double): Double = 1.0 + fader.coerceIn(-1f, 1f) * range

    /** Inverse of [faderToRatio], clamped to the fader travel. */
    fun ratioToFader(ratio: Double, range: Double): Float =
        if (range <= 0.0) 0f else ((ratio - 1.0) / range).coerceIn(-1.0, 1.0).toFloat()

    /**
     * Phase offset of a deck against the master clock in beats, wrapped to -0.5..0.5
     * (negative = deck behind). Used by the phase meter.
     */
    fun phaseOffset(deckBeat: Double, masterBeat: Double): Double {
        val d = (deckBeat - masterBeat) - floor(deckBeat - masterBeat)
        return if (d >= 0.5) d - 1.0 else d
    }

    /** Beat index 0..beatsPerBar-1 within the bar for a fractional beat number. */
    fun beatInBar(beat: Double, beatsPerBar: Int): Int {
        val n = maxOf(1, beatsPerBar)
        val b = floor(beat).toLong()
        return (((b % n) + n) % n).toInt()
    }

    /** Auto-loop sizes offered by the UI (beats). */
    val LOOP_SIZES = listOf(0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0)

    fun loopLabel(beats: Double): String = when {
        beats >= 1.0 -> beats.roundToInt().toString()
        else -> "1/" + (1.0 / beats).roundToInt()
    }

    /** Next auto-loop size after halving / doubling, clamped to [LOOP_SIZES]. */
    fun stepLoop(beats: Double, up: Boolean): Double {
        val next = if (up) beats * 2 else beats / 2
        return next.coerceIn(LOOP_SIZES.first(), LOOP_SIZES.last())
    }

    /** MIDI 0..1 control -> EQ dB (0.5 = 0 dB, 0 = kill -26 dB, 1 = +6 dB). */
    fun unitToEqDb(v: Float): Float {
        val x = v.coerceIn(0f, 1f)
        return if (x < 0.5f) -26f * (1f - x * 2f) else 6f * (x * 2f - 1f)
    }

    /** MIDI 0..1 -> trim -12..+12 dB. */
    fun unitToTrimDb(v: Float): Float = (v.coerceIn(0f, 1f) * 2f - 1f) * 12f

    /** 0..1 -> -1..1 (bipolar controls: crossfader, filter). */
    fun unitToBipolar(v: Float): Float = v.coerceIn(0f, 1f) * 2f - 1f
}
