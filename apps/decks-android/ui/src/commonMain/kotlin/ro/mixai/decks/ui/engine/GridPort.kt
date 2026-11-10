package ro.mixai.decks.ui.engine

/** One tempo change of a track's beatgrid: from [sec] on, the tempo is [bpm] (WP19-37). */
data class GridMarkerUi(val sec: Double, val bpm: Double, val beat: Int)

/**
 * A track's editable beatgrid: a first beat, the tempo up to the first marker, the tempo-change
 * markers, and the fixed-grid toggle (markers kept but ignored).
 */
data class GridStateUi(
    val trackId: String,
    val bpm: Double,
    val firstBeatSec: Double,
    val downbeatOffset: Int,
    val fixed: Boolean,
    val markers: List<GridMarkerUi>,
) {
    /** Tempo in force at [sec] (the constant tempo when [fixed]). */
    fun bpmAt(sec: Double): Double {
        if (fixed) return bpm
        var cur = bpm
        for (m in markers) {
            if (m.sec > sec) break
            cur = m.bpm
        }
        return cur
    }

    /** Fractional beat number at [sec] (beat 0 = [firstBeatSec]). */
    fun beatAt(sec: Double): Double {
        if (fixed || markers.isEmpty()) return (sec - firstBeatSec) * bpm / 60.0
        var t = firstBeatSec
        var beat = 0.0
        var cur = bpm
        for (m in markers) {
            if (m.sec >= sec) break
            beat += (m.sec - t) * cur / 60.0
            t = m.sec
            cur = m.bpm
        }
        return beat + (sec - t) * cur / 60.0
    }

    /** Source time of (fractional) beat [beat]. */
    fun timeAt(beat: Double): Double {
        if (fixed || markers.isEmpty()) return firstBeatSec + beat * 60.0 / bpm
        var t = firstBeatSec
        var b = 0.0
        var cur = bpm
        for (m in markers) {
            val next = b + (m.sec - t) * cur / 60.0
            if (next >= beat) break
            b = next
            t = m.sec
            cur = m.bpm
        }
        return t + (beat - b) * 60.0 / cur
    }

    /** Index of the marker nearest to [sec] within [toleranceSec], or -1. */
    fun markerNear(sec: Double, toleranceSec: Double): Int {
        var best = -1
        var bestD = kotlin.math.abs(toleranceSec)
        markers.forEachIndexed { i, m ->
            val d = kotlin.math.abs(m.sec - sec)
            if (d <= bestD) {
                best = i
                bestD = d
            }
        }
        return best
    }

    /**
     * Sorted, merged copy: markers at (or before) the first beat become the starting tempo,
     * markers within 1 ms keep the last, and markers that do not change the tempo are dropped
     * (same rule as Rust `mixai_core::beatgrid::merge_markers`).
     */
    fun normalised(): GridStateUi {
        var start = bpm
        val sorted = markers.filter { it.sec.isFinite() && it.bpm in 20.0..400.0 }.sortedBy { it.sec }
        val unique = ArrayList<GridMarkerUi>()
        for (m in sorted) {
            if (m.sec <= firstBeatSec + 1e-9) {
                start = m.bpm
                continue
            }
            val last = unique.lastOrNull()
            if (last != null && kotlin.math.abs(m.sec - last.sec) < 1e-3) unique[unique.size - 1] = m else unique.add(m)
        }
        val out = ArrayList<GridMarkerUi>()
        var cur = start
        for (m in unique) {
            if (!sameTempo(m.bpm, cur)) {
                out.add(m)
                cur = m.bpm
            }
        }
        val base = copy(bpm = start, markers = emptyList())
        return base.copy(markers = out.map { it.copy(beat = kotlin.math.round(base.copy(markers = out).beatAt(it.sec)).toInt().coerceAtLeast(0)) })
    }

    fun withMarker(sec: Double, bpm: Double): GridStateUi =
        copy(markers = markers.filter { kotlin.math.abs(it.sec - sec) > 1e-3 } + GridMarkerUi(sec, bpm, 0)).normalised()

    fun withMoved(index: Int, sec: Double, bpm: Double): GridStateUi =
        if (index !in markers.indices) this
        else copy(markers = markers.mapIndexed { i, m -> if (i == index) GridMarkerUi(sec, bpm, 0) else m }).normalised()

    fun withoutMarker(index: Int): GridStateUi =
        if (index !in markers.indices) this else copy(markers = markers.filterIndexed { i, _ -> i != index }).normalised()

    companion object {
        /** Relative tolerance under which two tempos are equal (0.05 %). */
        const val BPM_TOLERANCE = 0.0005

        fun sameTempo(a: Double, b: Double): Boolean =
            kotlin.math.abs(a - b) <= BPM_TOLERANCE * maxOf(kotlin.math.abs(a), kotlin.math.abs(b))

        /** Constant grid used while a track has no stored markers. */
        fun constant(trackId: String, bpm: Double, firstBeatSec: Double): GridStateUi =
            GridStateUi(trackId, if (bpm > 0) bpm else 120.0, firstBeatSec, 0, false, emptyList())
    }
}

/**
 * Flexible beatgrid editing (WP19-37): read a track's grid, edit its tempo markers, toggle the
 * fixed grid, apply a grid to a loaded deck and check another app's MP3 decoder offset.
 *
 * Every call returns `null` (or `0.0`) instead of throwing: the UI must never crash because the
 * engine or the library refused a command.
 */
interface GridPort {
    /** The editable grid of a library track (`null` when it has none). */
    fun grid(trackId: String): GridStateUi?

    /** Just the tempo markers of a library track. */
    fun markers(trackId: String): List<GridMarkerUi>

    /** Turn the fixed-grid toggle on/off; the markers are kept. */
    fun setFixed(trackId: String, fixed: Boolean): GridStateUi?

    /** Move the whole grid (first beat + starting tempo). */
    fun setBase(trackId: String, bpm: Double, firstBeatSec: Double, downbeatOffset: Int): GridStateUi?

    /** Add (or replace) a tempo change at [sec]. */
    fun addMarker(trackId: String, sec: Double, bpm: Double): GridStateUi?

    /** Move and/or retune the marker nearest to [atSec]. */
    fun moveMarker(trackId: String, atSec: Double, newSec: Double, newBpm: Double? = null, toleranceSec: Double = 0.25): GridStateUi?

    /** Delete the marker nearest to [atSec]. */
    fun removeMarker(trackId: String, atSec: Double, toleranceSec: Double = 0.25): GridStateUi?

    /** Hand a grid to a loaded deck; returns false when the engine refused it. */
    fun applyToDeck(deck: Int, grid: GridStateUi): Boolean

    /** The grid a deck is playing (`null` when it has none). */
    fun deckGrid(deck: Int): GridStateUi?

    /**
     * MP3 priming offset (seconds) to add to times written by [source]
     * (`rekordbox`, `serato`, `traktor`, `engine`, `mixai`); 0 when there is nothing to correct.
     */
    fun driftCheck(path: String, source: String): Double
}
