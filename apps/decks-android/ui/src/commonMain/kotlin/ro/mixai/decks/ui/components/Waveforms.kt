package ro.mixai.decks.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.DrawScope
import ro.mixai.decks.ui.engine.GridStateUi
import ro.mixai.decks.ui.model.PeaksData
import ro.mixai.decks.ui.model.WaveDeck
import ro.mixai.decks.ui.model.WaveFrame
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksSkin
import ro.mixai.decks.ui.theme.panelShape

/** Slot for the scrolling waveform area: GPU (decks-render) on device, [ComposeWaveforms] otherwise. */
typealias WaveformSlot = @Composable (frame: WaveFrame, peaks: List<PeaksData?>, modifier: Modifier) -> Unit

/**
 * Beatgrids per deck (index = deck) for the waveform lanes (WP19-37). A [WaveformSlot] takes only
 * frame + peaks, so the grids travel as a composition local: the screen that owns the
 * [ro.mixai.decks.ui.engine.GridPort] provides them and every renderer — the Compose fallback here,
 * and the GPU renderers when they delegate to it — picks them up. Empty = constant grid from the
 * deck BPM, which is what the demo engine and the screenshot tests get.
 */
val LocalDeckGrids = staticCompositionLocalOf<List<GridStateUi?>> { emptyList() }

/**
 * Beat times in `[from, to]` for [grid] (WP19-37): `(sec, isDownbeat)`, following every tempo
 * marker (or the constant tempo when the grid is fixed). Capped at [limit] lines.
 */
fun gridBeatLines(grid: GridStateUi, from: Double, to: Double, beatsPerBar: Int = 4, limit: Int = 4096): List<Pair<Double, Boolean>> {
    val out = ArrayList<Pair<Double, Boolean>>()
    if (!(grid.bpm > 0) || !(to > from)) return out
    val bar = beatsPerBar.coerceAtLeast(1)
    var k = kotlin.math.ceil(grid.beatAt(from) - 1e-9).toLong()
    while (out.size < limit) {
        val t = grid.timeAt(k.toDouble())
        if (t > to) break
        if (t >= from) out.add(t to (((k % bar) + bar) % bar == 0L))
        k++
    }
    return out
}

/**
 * Pure Compose scrolling waveforms (fallback when the native renderer is unavailable, and in the
 * demo engine): one lane per deck, playhead centred, beat grid, cue/hot-cue/loop markers.
 * [grids] (index = deck) carries the flexible grids (WP19-37); a deck without one gets a
 * constant grid from its BPM.
 */
@Composable
fun ComposeWaveforms(
    frame: WaveFrame,
    peaks: List<PeaksData?>,
    modifier: Modifier,
    grids: List<GridStateUi?> = LocalDeckGrids.current,
) {
    Canvas(modifier) {
        val n = frame.decks.size.coerceAtLeast(1)
        val laneH = size.height / n
        frame.decks.forEachIndexed { i, d ->
            drawLane(d, peaks.getOrNull(i), grids.getOrNull(i), frame.zoomSeconds, Offset(0f, laneH * i), Size(size.width, laneH))
        }
    }
}

private fun DrawScope.drawLane(d: WaveDeck, p: PeaksData?, grid: GridStateUi?, zoom: Float, origin: Offset, area: Size) {
    drawRect(DecksColors.waveBg, origin, area)
    val mid = origin.y + area.height / 2
    if (!d.loaded || p == null || p.size == 0) {
        drawLine(DecksColors.border, Offset(0f, mid), Offset(area.width, mid), 1f)
        return
    }
    val secPerPx = zoom / area.width
    val t0 = d.playheadSec - zoom / 2
    // Loop region
    if (d.loopActive && d.loopEndSec > d.loopStartSec) {
        val x0 = ((d.loopStartSec - t0) / secPerPx).toFloat()
        val x1 = ((d.loopEndSec - t0) / secPerPx).toFloat()
        drawRect(DecksColors.success.copy(alpha = 0.18f), Offset(x0, origin.y), Size(x1 - x0, area.height))
    }
    // Peaks: low / mid / high stacked, mirrored around the centre line
    val half = area.height / 2 * 0.92f
    val low = DecksColors.waveLow(d.index)
    val midC = DecksColors.waveMid(d.index)
    val high = DecksColors.waveHigh(d.index)
    // The part left of the playhead has already played: dimmed by the look (`--wave-played-alpha`).
    val playedAlpha = DecksColors.wavePlayedAlpha
    var x = 0f
    while (x < area.width) {
        val t = t0 + x * secPerPx
        val idx = (t * p.pointsPerSecond).toInt()
        if (idx in 0 until p.size) {
            val lo = (p.low[idx].toInt() and 0xFF) / 255f
            val mi = (p.mid[idx].toInt() and 0xFF) / 255f
            val hi = (p.high[idx].toInt() and 0xFF) / 255f
            val a = if (x < area.width / 2) playedAlpha else 1f
            drawLine(low, Offset(x, mid - lo * half), Offset(x, mid + lo * half), 1.5f, alpha = a)
            drawLine(midC, Offset(x, mid - mi * half * 0.75f), Offset(x, mid + mi * half * 0.75f), 1.5f, alpha = a)
            drawLine(high, Offset(x, mid - hi * half * 0.45f), Offset(x, mid + hi * half * 0.45f), 1.5f, alpha = a)
        }
        x += 2f
    }
    // Beat grid: follows the tempo markers (WP19-37), or the constant tempo of the deck.
    val bpm = d.bpm
    val g = grid ?: if (bpm != null && bpm > 0) GridStateUi.constant("", bpm, d.firstBeatSec ?: 0.0) else null
    val t1 = t0 + zoom
    if (g != null) {
        for ((bt, bar) in gridBeatLines(g, t0, t1)) {
            val bx = ((bt - t0) / secPerPx).toFloat()
            drawLine(
                if (bar) DecksColors.waveDownbeat else DecksColors.waveGrid,
                Offset(bx, origin.y), Offset(bx, origin.y + area.height), if (bar) 2f else 1f,
            )
        }
        drawTempoMarkers(g, t0, secPerPx, origin, area)
    }
    // Cue + hot cues
    fun marker(sec: Double, c: androidx.compose.ui.graphics.Color) {
        val mx = ((sec - t0) / secPerPx).toFloat()
        if (mx in 0f..area.width) drawLine(c, Offset(mx, origin.y), Offset(mx, origin.y + area.height), 2f)
    }
    marker(d.cuePointSec, DecksColors.cueButton)
    d.hotCues.forEachIndexed { i, h -> if (h != null) marker(h, DecksColors.cue(i)) }
    // Playhead
    drawLine(DecksColors.wavePlayhead, Offset(area.width / 2, origin.y), Offset(area.width / 2, origin.y + area.height), 2f)
}

/**
 * Tempo-change markers in the warning colour (dimmed while the grid is fixed), with a tick whose
 * direction encodes up / down tempo, plus the fixed-grid bar along the lane top. The BPM itself is
 * in the grid editor.
 */
private fun DrawScope.drawTempoMarkers(g: GridStateUi, t0: Double, secPerPx: Float, origin: Offset, area: Size) {
    var prev = g.bpm
    for (m in g.markers) {
        val mx = ((m.sec - t0) / secPerPx).toFloat()
        val up = m.bpm > prev
        prev = m.bpm
        if (mx < 0f || mx > area.width) continue
        val c = DecksColors.warning.copy(alpha = if (g.fixed) 0.35f else 1f)
        drawLine(c, Offset(mx, origin.y), Offset(mx, origin.y + area.height), 2.5f)
        val tip = if (up) 6f else -6f
        drawLine(c, Offset(mx, origin.y + 2f), Offset(mx + tip, origin.y + 8f), 2f)
    }
    if (g.fixed) drawRect(DecksColors.warning.copy(alpha = 0.8f), origin, Size(area.width, 3f))
}

/**
 * Transparent overlay for the GPU waveform renderers (WP19-40 P1-18): `decks-render` only knows a
 * constant-tempo grid, so the tempo markers and the fixed-grid bar of [grids] are drawn on top of
 * it here. Draws nothing when no deck has a stored grid with markers or the fixed flag.
 */
@Composable
fun GridMarkersOverlay(frame: WaveFrame, modifier: Modifier, grids: List<GridStateUi?> = LocalDeckGrids.current) {
    if (grids.none { it != null && (it.fixed || it.markers.isNotEmpty()) }) return
    Canvas(modifier) {
        val n = frame.decks.size.coerceAtLeast(1)
        val laneH = size.height / n
        frame.decks.forEachIndexed { i, d ->
            val g = grids.getOrNull(i) ?: return@forEachIndexed
            if (!d.loaded) return@forEachIndexed
            val secPerPx = frame.zoomSeconds / size.width
            drawTempoMarkers(g, d.playheadSec - frame.zoomSeconds / 2, secPerPx, Offset(0f, laneH * i), Size(size.width, laneH))
        }
    }
}

/**
 * Layout panel `waves` (Decks 1.5, `PanelId.Waves`): the scrolling waveform band of every deck as a
 * panel of the layout instead of a fixed strip. [lanes] is the waveform slot of the screen (GPU
 * renderer or [ComposeWaveforms], with the beatgrids): one lane per deck, playhead centred. Edge to
 * edge on the waveform backdrop, no padding, at every tier (a 200×36 dp icon box still shows lanes).
 *
 * Not yet at parity with WavesPanel.tsx: no header chips / beat keeper / phase meter, no zoom or seek
 * on the lanes, lanes stay horizontal in a tall box (TS turns them into columns, playhead at 1/3) and
 * the skin's `overlay` arrangement is not drawn (lanes stay stacked).
 */
@Composable
fun WavesPanel(modifier: Modifier = Modifier, lanes: @Composable (Modifier) -> Unit) {
    val shape = panelShape(LocalDecksSkin.current)
    Box(modifier.clip(shape).background(DecksColors.waveBg)) {
        lanes(Modifier.fillMaxSize())
    }
}
