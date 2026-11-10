package ro.mixai.decks.ui

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import ro.mixai.decks.ui.components.gridBeatLines
import ro.mixai.decks.ui.engine.GridMarkerUi
import ro.mixai.decks.ui.engine.GridPort
import ro.mixai.decks.ui.engine.GridStateUi
import ro.mixai.decks.ui.screens.GRID_BPM_STEP
import ro.mixai.decks.ui.screens.GRID_NUDGE_SEC
import ro.mixai.decks.ui.screens.DeckGridCache
import ro.mixai.decks.ui.screens.GridEditorState
import ro.mixai.decks.ui.screens.gridFmtBpm
import ro.mixai.decks.ui.screens.gridFmtTime

private fun near(a: Double, b: Double, eps: Double = 1e-9) = assertTrue(abs(a - b) < eps, "$a != $b")

/** In-memory [GridPort] that behaves like the FFI one (merge rules included). */
private class FakeGridPort(var state: GridStateUi) : GridPort {
    val applied = mutableListOf<Pair<Int, GridStateUi>>()
    var gridReads = 0
    override fun grid(trackId: String): GridStateUi? {
        gridReads++
        return state.takeIf { it.trackId == trackId }
    }
    override fun markers(trackId: String) = state.markers
    override fun setFixed(trackId: String, fixed: Boolean) = state.copy(fixed = fixed).also { state = it }
    override fun setBase(trackId: String, bpm: Double, firstBeatSec: Double, downbeatOffset: Int) =
        state.copy(bpm = bpm, firstBeatSec = firstBeatSec, downbeatOffset = downbeatOffset).normalised().also { state = it }
    override fun addMarker(trackId: String, sec: Double, bpm: Double) = state.withMarker(sec, bpm).also { state = it }
    override fun moveMarker(trackId: String, atSec: Double, newSec: Double, newBpm: Double?, toleranceSec: Double): GridStateUi? {
        val i = state.markerNear(atSec, toleranceSec).takeIf { it >= 0 } ?: return null
        return state.withMoved(i, newSec, newBpm ?: state.markers[i].bpm).also { state = it }
    }
    override fun removeMarker(trackId: String, atSec: Double, toleranceSec: Double): GridStateUi? {
        val i = state.markerNear(atSec, toleranceSec).takeIf { it >= 0 } ?: return null
        return state.withoutMarker(i).also { state = it }
    }
    override fun applyToDeck(deck: Int, grid: GridStateUi): Boolean { applied += deck to grid; return true }
    override fun deckGrid(deck: Int) = applied.lastOrNull { it.first == deck }?.second
    override fun driftCheck(path: String, source: String) = 0.0
}

private fun variable() = GridStateUi(
    trackId = "t1",
    bpm = 120.0,
    firstBeatSec = 0.5,
    downbeatOffset = 0,
    fixed = false,
    markers = listOf(GridMarkerUi(16.5, 128.0, 32), GridMarkerUi(31.5, 124.0, 64)),
)

class GridTest {
    @Test
    fun markersBendTheGridAndKeepTheLastTempo() {
        val g = variable()
        near(g.beatAt(16.5), 32.0)
        near(g.bpmAt(10.0), 120.0)
        near(g.bpmAt(20.0), 128.0)
        near(g.bpmAt(40.0), 124.0)
        near(g.timeAt(64.0), 31.5)
        near(g.timeAt(64.0 + 124.0), 91.5, 1e-7)
    }

    @Test
    fun fixedIgnoresTheMarkersButKeepsThem() {
        val g = variable().copy(fixed = true)
        assertEquals(2, g.markers.size)
        near(g.bpmAt(40.0), 120.0)
        near(g.beatAt(30.5), 60.0)
        near(g.timeAt(60.0), 30.5)
    }

    @Test
    fun normalisingMergesEqualTemposAndDuplicates() {
        val g = GridStateUi(
            "t", 120.0, 0.5, 0, false,
            listOf(
                GridMarkerUi(30.0, 128.02, 0), // same tempo as the previous marker
                GridMarkerUi(10.0, 126.0, 0), // replaced by the one 0.4 ms later
                GridMarkerUi(10.0004, 128.0, 0),
                GridMarkerUi(20.0, 128.0, 0), // no change
                GridMarkerUi(0.2, 122.0, 0), // before the first beat: starting tempo
            ),
        ).normalised()
        near(g.bpm, 122.0)
        assertEquals(1, g.markers.size, "${g.markers}")
        near(g.markers[0].sec, 10.0004)
        assertEquals(kotlin.math.round(g.beatAt(10.0004)).toInt(), g.markers[0].beat)
    }

    @Test
    fun beatLinesFollowTheTempoChangeAndAreBounded() {
        val g = variable()
        val lines = gridBeatLines(g, 16.5, 17.5)
        assertTrue(lines.size >= 2)
        near(lines[1].first - lines[0].first, 60.0 / 128.0)
        assertTrue(gridBeatLines(g, 0.0, 1e6, limit = 300).size <= 300)
        assertTrue(gridBeatLines(g, 5.0, 5.0).isEmpty())
        // Downbeats every 4 beats from beat 0.
        val bars = gridBeatLines(g, 0.5, 4.0).filter { it.second }.map { it.first }
        near(bars[0], 0.5)
        near(bars[1], 2.5)
    }

    @Test
    fun editorStateEditsThroughThePortAndAppliesToTheDeck() {
        val port = FakeGridPort(GridStateUi.constant("t1", 120.0, 0.5))
        val s = GridEditorState(port, deck = 1, trackId = "t1")
        s.load()
        assertTrue(s.grid.markers.isEmpty())

        // Add at the playhead snaps to the nearest beat (16.6 s → beat 32 at 16.5 s) and starts
        // one step above the running tempo so it is a real change.
        s.addAtPlayhead(16.6)
        assertEquals(1, s.grid.markers.size)
        near(s.grid.markers[0].sec, 16.5)
        near(s.grid.markers[0].bpm, 120.0 + GRID_BPM_STEP)
        s.retune(0, 8.0)
        near(s.grid.markers[0].bpm, 128.0 + GRID_BPM_STEP)
        s.nudge(0, GRID_NUDGE_SEC)
        near(s.grid.markers[0].sec, 16.5 + GRID_NUDGE_SEC)
        s.retune(0, -GRID_BPM_STEP)
        near(s.grid.markers[0].bpm, 128.0)

        s.toggleFixed()
        assertTrue(s.grid.fixed)
        assertEquals(1, s.grid.markers.size, "fixed keeps the markers")
        s.toggleFixed()
        assertFalse(s.grid.fixed)

        s.remove(0)
        assertTrue(s.grid.markers.isEmpty())
        // Every edit reached deck 1.
        assertTrue(port.applied.isNotEmpty() && port.applied.all { it.first == 1 })
        assertEquals(s.grid, port.deckGrid(1))
    }

    /**
     * P1-17: the editor is built inside `remember {}` (composition, UI thread), so its constructor
     * must not touch the port; the stored grid arrives through [GridEditorState.load], which the
     * composable runs on the IO dispatcher.
     */
    @Test
    fun constructingTheEditorDoesNotCallTheFfi() {
        val port = FakeGridPort(variable())
        val s = GridEditorState(port, deck = 0, trackId = "t1", fallbackBpm = 126.0)
        assertEquals(0, port.gridReads, "no FFI read during composition")
        near(s.grid.bpm, 126.0)
        s.load()
        assertEquals(1, port.gridReads)
        assertEquals(variable(), s.grid)
    }

    @Test
    fun editorBusyGuardDropsASecondTapAndReportsEveryEdit() {
        val port = FakeGridPort(GridStateUi.constant("t1", 120.0, 0.5))
        val seen = mutableListOf<GridStateUi>()
        val s = GridEditorState(port, deck = 0, trackId = "t1", onChanged = { seen += it })
        assertTrue(s.begin())
        assertFalse(s.begin(), "a second tap while an edit runs is dropped")
        s.addAtPlayhead(16.6)
        s.finish()
        assertFalse(s.busy)
        assertEquals(1, seen.size, "the applied grid reached the waveform cache")
        assertEquals(s.grid, seen.last())
    }

    /** P1-18: grids for the waveform are read once per (deck, trackId), not per frame. */
    @Test
    fun deckGridCacheReadsOncePerTrackAndTakesEditsWithoutTheFfi() {
        val port = FakeGridPort(variable())
        val cache = DeckGridCache(port, decks = 2)
        assertTrue(cache.needs(0, "t1"))
        cache.load(0, "t1")
        assertFalse(cache.needs(0, "t1"), "same track: no second read")
        repeat(100) { if (cache.needs(0, "t1")) cache.load(0, "t1") }
        assertEquals(1, port.gridReads, "one FFI read for a hundred frames")
        assertEquals(variable(), cache.grids[0])
        assertEquals(null, cache.grids[1])

        // An edit lands straight in the cache.
        val edited = variable().copy(fixed = true)
        cache.put(0, edited)
        assertEquals(edited, cache.grids[0])
        assertEquals(1, port.gridReads)

        // A new track on the deck triggers one read; unloading clears the lane.
        assertTrue(cache.needs(0, "t2"))
        cache.load(0, "t2")
        assertEquals(null, cache.grids[0], "t2 has no stored grid")
        assertTrue(cache.needs(0, null))
        cache.load(0, null)
        assertFalse(cache.needs(0, null))
        assertEquals(2, port.gridReads, "an empty deck is not read")
    }

    @Test
    fun editorStateWorksWithoutAPort() {
        val s = GridEditorState(null, deck = 0, trackId = "x", fallbackBpm = 120.0, fallbackFirstBeatSec = 0.5)
        s.addAtPlayhead(16.5)
        s.retune(0, 8.0)
        assertEquals(1, s.grid.markers.size)
        s.toggleFixed()
        assertTrue(s.grid.fixed)
    }

    @Test
    fun formattersAreLocaleFree() {
        assertEquals("1:05.25", gridFmtTime(65.25))
        assertEquals("0:00.00", gridFmtTime(Double.NaN))
        assertEquals("127.95", gridFmtBpm(127.949))
        assertEquals("128.00", gridFmtBpm(128.0))
    }
}
