package ro.mixai.decks.ui.logic

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToLong

/** Pure formatting helpers (unit-tested in commonTest; no locale-dependent APIs). */
object Format {
    /** `m:ss.t` (tenths), negative values clamp to 0. */
    fun time(sec: Double): String {
        val tenths = (maxOf(0.0, sec) * 10).toLong()
        val m = tenths / 600
        val s = (tenths / 10) % 60
        val t = tenths % 10
        return "$m:${s.toString().padStart(2, '0')}.$t"
    }

    /** Remaining time `-m:ss.t`. */
    fun remaining(playhead: Double, duration: Double): String = "-" + time(duration - playhead)

    /** BPM with two decimals, or an em dash when unknown. */
    fun bpm(bpm: Double?): String = if (bpm == null || bpm <= 0.0) "—" else fixed(bpm, 2)

    /** Tempo ratio as signed percent: 1.025 -> `+2.50%`. */
    fun tempoPercent(ratio: Double): String {
        val pct = (ratio - 1.0) * 100.0
        return signed(pct, 2) + "%"
    }

    /** Semitones with sign: 0 -> `0`, 2 -> `+2`, -1.5 -> `-1.5`. */
    fun semitones(st: Double): String {
        if (abs(st) < 0.005) return "0"
        val r = (st * 10).roundToLong() / 10.0
        val body = if (r == floor(r)) abs(r).toLong().toString() else fixed(abs(r), 1)
        return (if (r > 0) "+" else "-") + body
    }

    /** Decibels with sign and one decimal (`+3.0 dB`, `-∞ dB` below -60). */
    fun db(db: Float): String = if (db <= -60f) "-∞ dB" else signed(db.toDouble(), 1) + " dB"

    /** Fixed decimals without locale (always `.`). */
    fun fixed(value: Double, decimals: Int): String {
        var scale = 1L
        repeat(decimals) { scale *= 10 }
        val neg = value < 0
        val scaled = (abs(value) * scale).roundToLong()
        val whole = scaled / scale
        val frac = scaled % scale
        val fracStr = if (decimals == 0) "" else "." + frac.toString().padStart(decimals, '0')
        return (if (neg && scaled != 0L) "-" else "") + whole + fracStr
    }

    fun signed(value: Double, decimals: Int): String {
        val s = fixed(value, decimals)
        val isZero = s.all { it == '0' || it == '.' }
        return if (s.startsWith("-") || isZero) s else "+$s"
    }
}
