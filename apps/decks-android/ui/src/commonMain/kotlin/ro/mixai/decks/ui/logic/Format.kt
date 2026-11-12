package ro.mixai.decks.ui.logic

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToLong

/** Plural form of a counted word, as the string keys name it (`<key>_one` / `_few` / `_other`). */
enum class Plural { One, Few, Other }

/** Pure formatting helpers (unit-tested in commonTest; no locale-dependent APIs). */
object Format {
    private fun romanian(lang: String): Boolean = lang.lowercase().startsWith("ro")

    /**
     * Plural form of a whole count [n] in [lang] ("ro…" = Romanian, anything else = English): the languages' own
     * cardinal rules, the same ones the desktop app gets from `Intl.PluralRules` (apps/mixai `pluralCategory`).
     * English: 1 = one, everything else = other. Romanian: 1 = one ("1 piesă"); 0, 2 to 19 and every number whose
     * last two digits are 01 to 19 = few ("5 piese", "101 piese"); the rest = other, the form with "de"
     * ("20 de piese", "100 de piese", "120 de piese"). The sign does not matter.
     */
    fun pluralCategory(lang: String, n: Long): Plural {
        if (n == 1L || n == -1L) return Plural.One
        if (!romanian(lang)) return Plural.Other
        return if (n == 0L || abs(n % 100L) in 1L..19L) Plural.Few else Plural.Other
    }

    /**
     * Plural form of a count that may have a fraction: a whole number follows the rule above; a number with a
     * fraction (0.5, 3.5) is other in English ("0.5 beats") and few in Romanian ("0,5 bătăi"). Not a number = other.
     */
    fun pluralCategory(lang: String, n: Double): Plural {
        if (!n.isFinite()) return Plural.Other
        if (n == floor(n) && abs(n) < 9.0e15) return pluralCategory(lang, n.toLong())
        return if (romanian(lang)) Plural.Few else Plural.Other
    }

    /**
     * Plural form of "beat" after a beat count as it is SHOWN ([DeckMath.loopLabel]: "1/4", "1", "16"), the port of
     * `beatsPlural` (apps/mixai/src/components/deck-tabs/tab-math.ts): a fraction of a beat written with a slash
     * reads as one in both languages ("1/2 beat", "1/2 bătaie"); any other label follows [pluralCategory].
     */
    fun beatsPlural(lang: String, label: String): Plural {
        if ('/' in label) return Plural.One
        val n = label.trim().toDoubleOrNull() ?: return Plural.Other
        return pluralCategory(lang, n)
    }

    /** `m:ss.t` (tenths), negative values clamp to 0. */
    fun time(sec: Double): String {
        val tenths = (maxOf(0.0, sec) * 10).toLong()
        val m = tenths / 600
        val s = (tenths / 10) % 60
        val t = tenths % 10
        return "$m:${s.toString().padStart(2, '0')}.$t"
    }

    /** BPM with two decimals, or an em dash when unknown. */
    fun bpm(bpm: Double?): String = if (bpm == null || bpm <= 0.0) "—" else fixed(bpm, 2)

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
