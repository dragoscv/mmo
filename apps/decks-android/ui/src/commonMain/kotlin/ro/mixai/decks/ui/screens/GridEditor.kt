package ro.mixai.decks.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.engine.GridPort
import ro.mixai.decks.ui.engine.GridStateUi
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksType

/** Nudge step for a tempo marker (seconds) and the tempo step of the ± buttons. */
const val GRID_NUDGE_SEC: Double = 0.005
const val GRID_BPM_STEP: Double = 0.1

/**
 * State of [GridEditor] (WP19-37). Plain class so tests drive it without Compose: it keeps the
 * grid being edited, calls the port for every change and hands the result to the deck. A port
 * that returns `null` (no library row, locked library) still updates the local grid so the UI
 * stays usable and the deck follows.
 *
 * Every port call reaches Rust behind the shared library mutex and can block for as long as an
 * import runs, so none of these methods may run on the UI thread (WP19-40 P1-17): the composable
 * claims the state with [begin] on the UI thread, runs the method on [decksBgDispatcher] and
 * releases it with [finish]. [onChanged] reports every applied grid so the caller (the waveform
 * grid cache) refreshes without polling the FFI.
 */
class GridEditorState(
    private val port: GridPort?,
    val deck: Int,
    trackId: String,
    fallbackBpm: Double = 120.0,
    fallbackFirstBeatSec: Double = 0.0,
    private val onChanged: (GridStateUi) -> Unit = {},
) {
    /**
     * The grid being edited. Starts from the deck's own tempo and is replaced by the stored grid
     * once [load] has read it off the UI thread (the constructor must never touch the FFI: it runs
     * inside `remember {}`, i.e. during composition).
     */
    var grid by mutableStateOf(GridStateUi.constant(trackId, fallbackBpm, fallbackFirstBeatSec))
        private set

    /** True while an edit is in flight; every control is disabled so a double tap cannot queue two. */
    var busy by mutableStateOf(false)
        private set

    /**
     * Claims the editor for one operation. Compose event callbacks run on the UI thread, so this
     * check-then-set is atomic there: a second tap sees [busy] and is dropped. Always pair it with
     * [finish] in a `finally`, so a cancelled panel cannot leave the editor stuck.
     */
    fun begin(): Boolean {
        if (busy) return false
        busy = true
        return true
    }

    fun finish() {
        busy = false
    }

    /** Reads the stored grid for this track. Blocking (FFI + library mutex): never on the UI thread. */
    fun load() {
        val stored = port?.grid(grid.trackId) ?: return
        grid = stored
        onChanged(stored)
    }

    private fun apply(next: GridStateUi?) {
        grid = next ?: return
        port?.applyToDeck(deck, grid)
        onChanged(grid)
    }

    fun toggleFixed() {
        val want = !grid.fixed
        apply(port?.setFixed(grid.trackId, want) ?: grid.copy(fixed = want))
    }

    /**
     * Add a tempo change at the playhead, snapped to the nearest beat. It starts one
     * [GRID_BPM_STEP] above the running tempo: a marker at the same tempo is not a change and
     * would be merged away at once. Retune it with ± afterwards.
     */
    fun addAtPlayhead(sec: Double) {
        val snapped = grid.timeAt(kotlin.math.round(grid.beatAt(sec)))
        val bpm = (grid.bpmAt(sec) + GRID_BPM_STEP).coerceAtMost(400.0)
        apply(port?.addMarker(grid.trackId, snapped, bpm) ?: grid.withMarker(snapped, bpm))
    }

    fun nudge(index: Int, deltaSec: Double) {
        val m = grid.markers.getOrNull(index) ?: return
        val to = (m.sec + deltaSec).coerceAtLeast(0.0)
        apply(port?.moveMarker(grid.trackId, m.sec, to, null, 0.25) ?: grid.withMoved(index, to, m.bpm))
    }

    fun retune(index: Int, deltaBpm: Double) {
        val m = grid.markers.getOrNull(index) ?: return
        val bpm = (m.bpm + deltaBpm).coerceIn(20.0, 400.0)
        apply(port?.moveMarker(grid.trackId, m.sec, m.sec, bpm, 0.25) ?: grid.withMoved(index, m.sec, bpm))
    }

    fun remove(index: Int) {
        val m = grid.markers.getOrNull(index) ?: return
        apply(port?.removeMarker(grid.trackId, m.sec, 0.25) ?: grid.withoutMarker(index))
    }
}

/** `m:ss.cc` (no locale formatting, so the tests are stable everywhere). */
fun gridFmtTime(sec: Double): String {
    val total = if (sec.isFinite() && sec > 0) sec else 0.0
    val m = (total / 60).toInt()
    val rest = total - m * 60
    val whole = rest.toInt()
    val cs = ((rest - whole) * 100).toInt()
    return "$m:${whole.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}"
}

/** Two decimals without `String.format` (not available in commonMain). */
fun gridFmtBpm(bpm: Double): String {
    val x = kotlin.math.round(bpm * 100).toLong()
    return "${x / 100}.${(x % 100).toString().padStart(2, '0')}"
}

/**
 * Beatgrid editor (WP19-37): fixed-grid toggle, the tempo-marker list and add / nudge / retune /
 * delete. `playheadSec` is where a new marker goes. Every control is a [PadButton], so it is
 * focusable, operable with Enter / Space and carries a content description.
 */
@Composable
fun GridEditor(
    port: GridPort?,
    deck: Int,
    trackId: String,
    playheadSec: Double,
    modifier: Modifier = Modifier,
    fallbackBpm: Double = 120.0,
    fallbackFirstBeatSec: Double = 0.0,
    onGridChanged: (GridStateUi) -> Unit = {},
    onClose: (() -> Unit)? = null,
) {
    val state = remember(port, deck, trackId) {
        GridEditorState(port, deck, trackId, fallbackBpm, fallbackFirstBeatSec, onGridChanged)
    }
    val scope = rememberCoroutineScope()
    // Reading the stored grid is an FFI call behind the library mutex: off the UI thread (P1-17).
    // It holds the claim too, so a tap during the read cannot edit the placeholder grid.
    LaunchedEffect(state) {
        if (!state.begin()) return@LaunchedEffect
        try {
            withContext(decksBgDispatcher + NonCancellable) { state.load() }
        } finally {
            state.finish()
        }
    }
    // Every edit: claimed on the UI thread (so a double tap cannot start two), run off it, and
    // released in `finally` — closing the panel cancels the scope but never leaves the editor busy.
    fun edit(block: GridEditorState.() -> Unit) {
        if (!state.begin()) return
        scope.launch {
            try {
                withContext(decksBgDispatcher + NonCancellable) { state.block() }
            } finally {
                state.finish()
            }
        }
    }
    val g = state.grid
    val type = LocalDecksType.current
    val markersLabel = str(Str.GridMarkers)
    Panel(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BasicText(
                    str(Str.GridTitle),
                    Modifier.semantics { heading() },
                    style = type.label.copy(color = DecksColors.foreground),
                )
                BasicText(
                    str(Str.GridBpmAt, gridFmtBpm(g.bpmAt(playheadSec))),
                    style = type.small.copy(color = DecksColors.muted),
                )
                if (onClose != null) {
                    PadButton(label = "×", description = str(Str.GridClose), onClick = onClose)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                PadButton(
                    label = str(Str.GridFixed),
                    description = str(Str.GridFixed),
                    active = g.fixed,
                    enabled = !state.busy,
                    state = if (g.fixed) str(Str.GridFixedHint) else str(Str.GridFlexHint),
                    onClick = { edit { toggleFixed() } },
                )
                BasicText(
                    if (g.fixed) str(Str.GridFixedHint) else str(Str.GridFlexHint),
                    style = type.small.copy(color = DecksColors.muted),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                BasicText(str(Str.GridMarkers), style = type.label.copy(color = DecksColors.foreground))
                PadButton(
                    label = "+", description = str(Str.GridMarkerAdd), enabled = !state.busy,
                    onClick = { edit { addAtPlayhead(playheadSec) } },
                )
            }
            if (g.markers.isEmpty()) {
                BasicText(str(Str.GridMarkerEmpty), style = type.small.copy(color = DecksColors.muted))
            } else {
                LazyColumn(
                    Modifier.fillMaxWidth().heightIn(max = 220.dp).semantics { contentDescription = markersLabel },
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    items(g.markers.size) { i ->
                        val m = g.markers[i]
                        val at = gridFmtTime(m.sec)
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            BasicText(
                                str(Str.GridMarkerItem, at, gridFmtBpm(m.bpm)),
                                style = type.small.copy(color = DecksColors.foreground),
                            )
                            val on = !state.busy
                            PadButton("<", str(Str.GridMarkerEarlier, at), enabled = on) { edit { nudge(i, -GRID_NUDGE_SEC) } }
                            PadButton(">", str(Str.GridMarkerLater, at), enabled = on) { edit { nudge(i, GRID_NUDGE_SEC) } }
                            PadButton("−", str(Str.GridTempoDown, at), enabled = on) { edit { retune(i, -GRID_BPM_STEP) } }
                            PadButton("+", str(Str.GridTempoUp, at), enabled = on) { edit { retune(i, GRID_BPM_STEP) } }
                            PadButton("␡", str(Str.GridMarkerRemove, at), enabled = on) { edit { remove(i) } }
                        }
                    }
                }
            }
        }
    }
}
