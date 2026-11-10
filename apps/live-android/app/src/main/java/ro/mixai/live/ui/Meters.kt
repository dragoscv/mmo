package ro.mixai.live.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import ro.mixai.live.R
import ro.mixai.live.core.Meters
import ro.mixai.live.core.linToDb
import ro.mixai.live.core.meterFill
import ro.mixai.live.core.midiName
import ro.mixai.mobile.theme.Mixai
import kotlin.math.abs
import kotlin.math.max

/**
 * Smoothed meter levels that update every frame WITHOUT recomposition: the frame loop writes plain floats, the
 * Canvas reads them in its draw lambda via [tick] (a state only the draw phase observes). A51 jank trap (WP18-04):
 * reading animated values in composition recomposes the whole screen 60x/s.
 */
class MeterLevels {
    val inLevel = FloatArray(1)
    val out = FloatArray(2)
    val inHold = FloatArray(1)
    val outHold = FloatArray(2)
    var clipped = false
    var cents = 0f

    /** Frame counter: written by the frame loop, read ONLY inside Canvas draw lambdas. */
    val tick = mutableIntStateOf(0)

    fun step(m: Meters?, dtSec: Float) {
        val targetIn = meterFill(linToDb(m?.inPeak ?: 0f))
        val targetOut = floatArrayOf(meterFill(linToDb(m?.outPeak?.getOrNull(0) ?: 0f)), meterFill(linToDb(m?.outPeak?.getOrNull(1) ?: 0f)))
        // Instant attack, ~20 dB/s release on a 60 dB scale; peak-hold falls slower.
        val fall = dtSec / 3f
        inLevel[0] = if (targetIn > inLevel[0]) targetIn else max(targetIn, inLevel[0] - fall)
        inHold[0] = if (inLevel[0] > inHold[0]) inLevel[0] else max(inLevel[0], inHold[0] - fall / 3f)
        for (i in 0..1) {
            out[i] = if (targetOut[i] > out[i]) targetOut[i] else max(targetOut[i], out[i] - fall)
            outHold[i] = if (out[i] > outHold[i]) out[i] else max(out[i], outHold[i] - fall / 3f)
        }
        clipped = m?.clipped == true
        val target = (m?.tune?.cents ?: 0f).coerceIn(-50f, 50f)
        cents += (target - cents) * (dtSec * 12f).coerceAtMost(1f)
    }
}

@Composable
fun rememberMeterLevels(meters: StateFlow<Meters?>): MeterLevels {
    val levels = remember { MeterLevels() }
    LaunchedEffect(levels) {
        var last = 0L
        while (true) {
            withFrameNanos { t ->
                val dt = if (last == 0L) 0.016f else ((t - last) / 1e9f).coerceIn(0f, 0.1f)
                last = t
                levels.step(meters.value, dt)
                levels.tick.intValue = (levels.tick.intValue + 1) and 0xFFFF
            }
        }
    }
    return levels
}

@Composable
fun MeterBars(levels: MeterLevels, modifier: Modifier = Modifier) {
    val track = MaterialTheme.colorScheme.surfaceContainerHighest
    val ok = Mixai.colors.success
    val hot = Mixai.colors.warning
    val clip = MaterialTheme.colorScheme.error
    val labels = listOf(stringResource(R.string.meter_in), stringResource(R.string.meter_out))
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(labels[0], style = MaterialTheme.typography.labelSmall, color = Mixai.colors.muted)
            Text(labels[1], style = MaterialTheme.typography.labelSmall, color = Mixai.colors.muted)
        }
        Canvas(Modifier.weight(1f).height(56.dp).semantics { contentDescription = labels.joinToString(" / ") }) {
            levels.tick.intValue // draw-phase read: invalidates only this Canvas each frame
            val gap = 4.dp.toPx()
            val rowH = (size.height - gap * 2) / 3f
            fun bar(row: Int, fill: Float, hold: Float) {
                val y = row * (rowH + gap)
                val r = CornerRadius(rowH / 2, rowH / 2)
                drawRoundRect(track, Offset(0f, y), Size(size.width, rowH), r)
                val w = size.width * fill
                if (w > 0f) {
                    val greenW = minOf(w, size.width * HOT_AT)
                    drawRoundRect(ok, Offset(0f, y), Size(greenW, rowH), r)
                    if (w > size.width * HOT_AT) drawRect(hot, Offset(size.width * HOT_AT, y), Size(w - size.width * HOT_AT, rowH))
                }
                val hx = (size.width * hold).coerceIn(0f, size.width - 2f)
                drawRect(if (hold > CLIP_AT) clip else hot, Offset(hx, y), Size(3.dp.toPx(), rowH))
            }
            bar(0, levels.inLevel[0], levels.inHold[0])
            bar(1, levels.out[0], levels.outHold[0])
            bar(2, levels.out[1], levels.outHold[1])
        }
    }
}

/** Clip lamp; reads the latch in the draw phase only. */
@Composable
fun ClipLamp(levels: MeterLevels) {
    val on = MaterialTheme.colorScheme.error
    val off = MaterialTheme.colorScheme.surfaceContainerHighest
    val cd = stringResource(R.string.clip)
    Canvas(Modifier.width(14.dp).height(14.dp).semantics { contentDescription = cd }) {
        levels.tick.intValue
        drawCircle(if (levels.clipped) on else off)
    }
}

/** DSP load + dropouts: coarse values (5 % steps), so this recomposes only when they really change. */
@Composable
fun EngineHealth(meters: StateFlow<Meters?>, modifier: Modifier = Modifier) {
    val flow = remember(meters) {
        meters.map { m -> m?.let { (Math.round(it.dspLoad * 20f) * 5) to it.xruns.toInt() } }.distinctUntilChanged()
    }
    val v by flow.collectAsState(initial = null)
    val (load, xruns) = v ?: return
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            stringResource(R.string.dsp_load, load), style = MaterialTheme.typography.labelSmall,
            color = if (load >= 80) MaterialTheme.colorScheme.error else Mixai.colors.muted,
        )
        if (xruns > 0) {
            Text(pluralStringResource(R.plurals.xruns, xruns, xruns), style = MaterialTheme.typography.labelSmall, color = Mixai.colors.warning)
        }
    }
}

private const val HOT_AT = 0.8f   // -12 dBFS on a 60 dB scale
private const val CLIP_AT = 0.985f

/** Tuner: note name + cents needle. Shown only while the engine sends `tune`. */
@Composable
fun TunerView(meters: StateFlow<Meters?>, levels: MeterLevels, modifier: Modifier = Modifier) {
    // Recomposes only when the shown note changes; the needle draws per frame from the smoothed cents.
    val noteFlow = remember(meters) {
        meters.map { m -> m?.tune?.let { midiName(it.target?.toFloat() ?: it.midi) } }.distinctUntilChanged()
    }
    val note by noteFlow.collectAsState(initial = null)
    val centsFlow = remember(meters) { meters.map { m -> m?.tune?.cents?.let { Math.round(it / 2f) * 2f } }.distinctUntilChanged() }
    val coarseCents by centsFlow.collectAsState(initial = null)
    if (note == null) return
    val ok = Mixai.colors.success
    val warn = Mixai.colors.warning
    val track = MaterialTheme.colorScheme.outlineVariant
    val needleCol = MaterialTheme.colorScheme.onSurface
    val label = stringResource(R.string.tuner)
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("$label · $note", style = MaterialTheme.typography.titleMedium)
            coarseCents?.let { Text(stringResource(R.string.tuner_cents, it), style = MaterialTheme.typography.labelMedium, color = Mixai.colors.muted) }
        }
        Canvas(Modifier.fillMaxWidth().height(36.dp).semantics { contentDescription = "$label ${note.orEmpty()}" }) {
            levels.tick.intValue
            val cents = levels.cents
            val mid = size.width / 2
            drawLine(track, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), 2.dp.toPx())
            for (c in listOf(-50, -25, 0, 25, 50)) {
                val x = mid + c / 50f * (size.width / 2 - 8f)
                drawLine(track, Offset(x, size.height * 0.25f), Offset(x, size.height * 0.75f), if (c == 0) 3.dp.toPx() else 1.dp.toPx())
            }
            val x = mid + cents / 50f * (size.width / 2 - 8f)
            drawLine(if (abs(cents) <= 5f) ok else warn, Offset(x, 0f), Offset(x, size.height), 5.dp.toPx(), StrokeCap.Round)
            drawCircle(needleCol, 3.dp.toPx(), Offset(x, size.height / 2))
        }
    }
}
