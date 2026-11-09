package ro.mixai.listen

import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.roundToInt

/**
 * Pure music helpers shared by the phone and the watch (unit-tested, no FFI so they run in plain JVM tests).
 * Key index = tonic pitch class (C = 0) + 12 when minor, the same scheme as `mixai-listen` (A minor = 21 = 8A).
 */
object Harmony {
    private val NOTE = listOf("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

    fun tonic(index: Int): Int = index.mod(12)
    fun isMinor(index: Int): Boolean = index >= 12
    fun index(tonic: Int, minor: Boolean): Int = tonic.mod(12) + if (minor) 12 else 0
    fun noteName(pitchClass: Int): String = NOTE[pitchClass.mod(12)]
    fun keyName(index: Int): String = noteName(tonic(index)) + if (isMinor(index)) "m" else ""

    /** Camelot number 1..12 (C major = 8B, A minor = 8A). */
    fun camelotNumber(index: Int): Int {
        // Major: C = 8, each fifth up = +1. Minor shares the number of its relative major (tonic + 3).
        val t = if (isMinor(index)) tonic(index) + 3 else tonic(index)
        return (7 * t + 7).mod(12) + 1
    }

    fun camelot(index: Int): String = "${camelotNumber(index)}${if (isMinor(index)) "A" else "B"}"

    /** 0 = same, 1 = relative / ±1 on the wheel, 2 = energy boost (±2) or diagonal, 3+ = clash. */
    fun wheelDistance(a: Int, b: Int): Int {
        val na = camelotNumber(a)
        val nb = camelotNumber(b)
        val ring = minOf((na - nb).mod(12), (nb - na).mod(12))
        val letter = if (isMinor(a) == isMinor(b)) 0 else 1
        return when {
            ring == 0 -> letter
            letter == 0 -> ring
            else -> ring + 1
        }
    }

    fun transpose(index: Int, semitones: Int): Int = index(tonic(index) + semitones, isMinor(index))

    private val MAJOR_STEPS = intArrayOf(0, 2, 4, 5, 7, 9, 11)
    private val MINOR_STEPS = intArrayOf(0, 2, 3, 5, 7, 8, 10)

    /** The 7 notes of the key's scale (natural minor for minor keys). */
    fun scale(index: Int): List<String> =
        (if (isMinor(index)) MINOR_STEPS else MAJOR_STEPS).map { noteName(tonic(index) + it) }

    /** Diatonic triads (I ii iii IV V vi vii° / i ii° III iv v VI VII). */
    fun chords(index: Int): List<String> {
        val q = if (isMinor(index)) listOf("m", "dim", "", "m", "m", "", "") else listOf("", "m", "m", "", "", "m", "dim")
        val steps = if (isMinor(index)) MINOR_STEPS else MAJOR_STEPS
        return steps.mapIndexed { i, s -> noteName(tonic(index) + s) + q[i] }
    }

    /** Semitones a playback rate change shifts the pitch by when key lock is off (+6 % ≈ +1 semitone). */
    fun semitonesForRate(percent: Double): Double = 12.0 * ln(1.0 + percent / 100.0) / ln(2.0)

    /**
     * Rate change that brings [trackBpm] to [liveBpm], allowing half / double time (a 70 BPM track against 140 live
     * is a 0 % match, not +100 %).
     */
    fun tempoMatchPercent(liveBpm: Double, trackBpm: Double): Double {
        if (liveBpm <= 0 || trackBpm <= 0) return 0.0
        return listOf(trackBpm, trackBpm * 2, trackBpm / 2)
            .map { (liveBpm / it - 1.0) * 100.0 }
            .minBy { abs(it) }
    }

    data class MixAdvice(
        /** Rate change to beat-match, percent. */
        val ratePercent: Double,
        /** Key the track lands on at that rate with key lock off (null when the shift rounds to 0 semitones). */
        val keyAtRate: Int?,
        /** Key-lock transpose (−2..+2) that makes the track mix best with the live key; 0 when it already does. */
        val transpose: Int,
        val keyAfterTranspose: Int,
        /** Wheel distance after [transpose]: 0 perfect, 1 smooth, 2 energy change, 3+ clash. */
        val distance: Int,
    )

    /** "Mix next" advice for a candidate track against what is playing now. */
    fun mixAdvice(liveKey: Int, liveBpm: Double, trackKey: Int, trackBpm: Double): MixAdvice {
        val rate = tempoMatchPercent(liveBpm, trackBpm)
        val shift = semitonesForRate(rate).roundToInt()
        val atRate = if (shift != 0) transpose(trackKey, shift) else null
        val best = (-2..2).minWith(compareBy<Int>({ wheelDistance(liveKey, transpose(trackKey, it)) }, { abs(it) }))
        val after = transpose(trackKey, best)
        return MixAdvice(rate, atRate, best, after, wheelDistance(liveKey, after))
    }

    /**
     * Singer transpose (D: WP18 round 2): shortest shift (−6..+5) that puts the song's tonic on the singer's
     * comfortable pitch class, from the median of a short hummed range test.
     */
    fun singerTranspose(songKey: Int, voiceCentreMidi: Int): Int {
        val d = (voiceCentreMidi.mod(12) - tonic(songKey)).mod(12)
        return if (d > 5) d - 12 else d
    }

    /** Median pitch of a hum test, ignoring the outer 10 % (breaths, octave slips). Null under 5 readings. */
    fun voiceCentre(midiNotes: List<Int>): Int? {
        if (midiNotes.size < 5) return null
        val s = midiNotes.sorted()
        val cut = s.size / 10
        val core = s.subList(cut, s.size - cut)
        return core[core.size / 2]
    }

    data class Capo(val fret: Int, val shapeKey: Int)

    private val EASY_MAJOR = listOf(7, 0, 2, 4, 9) // G C D E A
    private val EASY_MINOR = listOf(4, 9, 2) // Em Am Dm

    /** Lowest capo (0..7) that lets a guitarist play [key] with open-chord shapes. */
    fun capo(key: Int): Capo {
        val easy = if (isMinor(key)) EASY_MINOR else EASY_MAJOR
        var best: Capo? = null
        for (fret in 0..7) {
            val shape = tonic(key) - fret
            val rank = easy.indexOf(shape.mod(12))
            if (rank < 0) continue
            val c = Capo(fret, index(shape, isMinor(key)))
            if (best == null || fret < best.fret) best = c
            if (fret == 0) break
        }
        return best ?: Capo(0, key)
    }
}

/**
 * BPM drift alarm (bands, drummers): the reference is the first locked tempo (or a manual one); the alarm fires
 * when the tempo stays more than [thresholdPercent] away from it for [holdMillis].
 */
class DriftMonitor(private val thresholdPercent: Double = 0.5, private val holdMillis: Long = 3_000) {
    var reference: Double? = null
        private set
    private var outsideSince: Long? = null

    fun setReference(bpm: Double?) {
        reference = bpm
        outsideSince = null
    }

    /** Returns the drift in percent when the alarm should fire, else null. */
    fun update(bpm: Double, nowMillis: Long): Double? {
        val ref = reference ?: run { reference = bpm; return null }
        val drift = (bpm / ref - 1.0) * 100.0
        if (abs(drift) <= thresholdPercent) {
            outsideSince = null
            return null
        }
        val since = outsideSince ?: nowMillis.also { outsideSince = it }
        return if (nowMillis - since >= holdMillis) drift else null
    }
}
