package ro.mixai.decks.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import kotlin.math.floor
import ro.mixai.decks.ui.model.PeaksData
import ro.mixai.decks.ui.model.WaveDeck
import ro.mixai.decks.ui.model.WaveFrame
import ro.mixai.decks.ui.theme.DecksColors

/** Slot for the scrolling waveform area: GPU (decks-render) on device, [ComposeWaveforms] otherwise. */
typealias WaveformSlot = @Composable (frame: WaveFrame, peaks: List<PeaksData?>, modifier: Modifier) -> Unit

/**
 * Pure Compose scrolling waveforms (fallback when the native renderer is unavailable, and in the
 * demo engine): one lane per deck, playhead centred, beat grid, cue/hot-cue/loop markers.
 */
@Composable
fun ComposeWaveforms(frame: WaveFrame, peaks: List<PeaksData?>, modifier: Modifier) {
    Canvas(modifier) {
        val n = frame.decks.size.coerceAtLeast(1)
        val laneH = size.height / n
        frame.decks.forEachIndexed { i, d ->
            drawLane(d, peaks.getOrNull(i), frame.zoomSeconds, Offset(0f, laneH * i), Size(size.width, laneH))
        }
    }
}

private fun DrawScope.drawLane(d: WaveDeck, p: PeaksData?, zoom: Float, origin: Offset, area: Size) {
    drawRect(DecksColors.background, origin, area)
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
    var x = 0f
    while (x < area.width) {
        val t = t0 + x * secPerPx
        val idx = (t * p.pointsPerSecond).toInt()
        if (idx in 0 until p.size) {
            val lo = (p.low[idx].toInt() and 0xFF) / 255f
            val mi = (p.mid[idx].toInt() and 0xFF) / 255f
            val hi = (p.high[idx].toInt() and 0xFF) / 255f
            drawLine(DecksColors.waveLow, Offset(x, mid - lo * half), Offset(x, mid + lo * half), 1.5f)
            drawLine(DecksColors.waveMid, Offset(x, mid - mi * half * 0.75f), Offset(x, mid + mi * half * 0.75f), 1.5f)
            drawLine(DecksColors.waveHigh, Offset(x, mid - hi * half * 0.45f), Offset(x, mid + hi * half * 0.45f), 1.5f)
        }
        x += 2f
    }
    // Beat grid
    val bpm = d.bpm
    if (bpm != null && bpm > 0) {
        val beat = 60.0 / bpm
        val first = d.firstBeatSec ?: 0.0
        var k = floor((t0 - first) / beat)
        while (true) {
            val bt = first + k * beat
            val bx = ((bt - t0) / secPerPx).toFloat()
            if (bx > area.width) break
            if (bx >= 0) {
                val bar = ((k.toLong() % 4) + 4) % 4 == 0L
                drawLine(
                    if (bar) DecksColors.foreground.copy(alpha = 0.55f) else DecksColors.border,
                    Offset(bx, origin.y), Offset(bx, origin.y + area.height), if (bar) 2f else 1f,
                )
            }
            k += 1.0
        }
    }
    // Cue + hot cues
    fun marker(sec: Double, c: androidx.compose.ui.graphics.Color) {
        val mx = ((sec - t0) / secPerPx).toFloat()
        if (mx in 0f..area.width) drawLine(c, Offset(mx, origin.y), Offset(mx, origin.y + area.height), 2f)
    }
    marker(d.cuePointSec, DecksColors.warning)
    d.hotCues.forEachIndexed { i, h -> if (h != null) marker(h, DecksColors.deck(i % 4)) }
    // Playhead
    drawLine(DecksColors.danger, Offset(area.width / 2, origin.y), Offset(area.width / 2, origin.y + area.height), 2f)
}

/**
 * Whole-track overview for one deck. Tap seeks; Left/Right keys seek ±5 %.
 */
@Composable
fun Overview(
    deck: WaveDeck,
    peaks: PeaksData?,
    description: String,
    positionText: String,
    modifier: Modifier,
    onSeek: (Float) -> Unit,
) {
    val frac = if (deck.durationSec > 0) (deck.playheadSec / deck.durationSec).toFloat() else 0f
    Canvas(
        modifier
            .pointerInput(Unit) { detectTapGestures { onSeek(it.x / size.width) } }
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                when (e.key) {
                    Key.DirectionLeft -> { onSeek((frac - 0.05f).coerceAtLeast(0f)); true }
                    Key.DirectionRight -> { onSeek((frac + 0.05f).coerceAtMost(1f)); true }
                    else -> false
                }
            }
            .focusable()
            .semantics { contentDescription = description; stateDescription = positionText },
    ) {
        drawRect(DecksColors.background)
        val mid = size.height / 2
        if (peaks != null && peaks.size > 0) {
            val cols = size.width.toInt().coerceAtLeast(1)
            val per = peaks.size.toFloat() / cols
            for (c in 0 until cols) {
                val s = (c * per).toInt()
                val e = ((c + 1) * per).toInt().coerceAtMost(peaks.size).coerceAtLeast(s + 1)
                var m = 0
                for (k in s until e) m = maxOf(m, peaks.low[k].toInt() and 0xFF, peaks.mid[k].toInt() and 0xFF)
                val h = m / 255f * mid
                val played = c < frac * cols
                drawLine(
                    if (played) DecksColors.muted else DecksColors.deck(deck.index),
                    Offset(c.toFloat(), mid - h), Offset(c.toFloat(), mid + h), 1f,
                )
            }
        }
        if (deck.durationSec > 0) {
            deck.hotCues.forEachIndexed { i, h ->
                if (h != null) {
                    val x = (h / deck.durationSec * size.width).toFloat()
                    drawLine(DecksColors.deck(i % 4), Offset(x, 0f), Offset(x, size.height), 2f)
                }
            }
        }
        drawLine(DecksColors.foreground, Offset(frac * size.width, 0f), Offset(frac * size.width, size.height), 2f)
    }
}
