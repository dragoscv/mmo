package ro.mixai.tv.ui

import android.content.Context
import android.util.Log
import android.view.WindowManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Ultrawide panels (21:9, 32:9) behind a 16:9-only source (Chromecast outputs 3840×2160) stretch
 * the picture horizontally. We lay the UI out on a wider canvas and squeeze it by 1/[squeeze];
 * the panel's own stretch then restores correct proportions AND uses the whole screen.
 *
 * Measured: Odyssey OLED G8 (3440×1440) via Chromecast reports 3840×2160 at 120.4 × 156.8 dpi
 * → physical aspect 2.31 → snapped to 21:9 (3440×1440, 2.389) → squeeze 1.344.
 */
enum class ScreenFormat(val key: String, val panelAspect: Float) {
    Auto("auto", 0f),
    Wide16x9("16:9", 16f / 9f),
    Ultra21x9("21:9", 3440f / 1440f),
    Super32x9("32:9", 32f / 9f);

    companion object {
        fun of(key: String?): ScreenFormat = entries.firstOrNull { it.key == key } ?: Auto
    }
}

/** Horizontal squeeze factor (1 = no compensation) for the current panel. */
val LocalSqueeze = compositionLocalOf { 1f }

/** True while the video player is on screen: it compensates in real pixels itself
 *  (SurfaceView ignores layer transforms), so the global squeeze steps aside. */
val squeezeSuspended = mutableStateOf(false)

private val CANDIDATES = listOf(16f / 9f, 64f / 27f, 3440f / 1440f, 32f / 9f)

/** Panel aspect from the display's physical dpi; null when the values look unreliable. */
fun detectPanelAspect(context: Context): Float? {
    @Suppress("DEPRECATION")
    val display = (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay
    val mode = display.mode
    val m = context.resources.displayMetrics
    val w = mode.physicalWidth.toFloat()
    val h = mode.physicalHeight.toFloat()
    if (w <= 0 || h <= 0 || m.xdpi <= 1f || m.ydpi <= 1f) return null
    val raw = (w / h) * (m.ydpi / m.xdpi)
    val best = CANDIDATES.minBy { abs(it - raw) / it }
    val snapped = if (abs(best - raw) / best < 0.08f) best else null
    Log.i("ScreenFormat", "mode=${mode.physicalWidth}x${mode.physicalHeight} dpi=${m.xdpi}x${m.ydpi} raw=$raw snapped=$snapped")
    return snapped
}

/** Squeeze for a chosen format; Auto uses [detected] (16:9 when unknown). */
fun squeezeFor(format: ScreenFormat, detected: Float?, signalAspect: Float = 16f / 9f): Float {
    val panel = if (format == ScreenFormat.Auto) detected ?: signalAspect else format.panelAspect
    val k = panel / signalAspect
    return if (abs(k - 1f) < 0.02f) 1f else k
}

/**
 * Lays [content] out [squeeze]× wider than the screen and scales it back by 1/[squeeze].
 * Does NOT apply to SurfaceView video (it ignores layer transforms) — the player sizes its
 * video surface itself via [videoBoxFraction].
 */
@Composable
fun SqueezeBox(squeeze: Float, content: @Composable () -> Unit) {
    // Same node structure for every factor, so toggling never recreates the content.
    val k = if (squeezeSuspended.value) 1f else squeeze
    Box(
        Modifier
            .fillMaxSize()
            .clipToBounds()
            .layout { measurable, constraints ->
                val w = constraints.maxWidth
                val h = constraints.maxHeight
                val placeable = measurable.measure(Constraints.fixed((w * k).roundToInt(), h))
                layout(w, h) {
                    placeable.placeWithLayer(0, 0) {
                        scaleX = 1f / k
                        transformOrigin = TransformOrigin(0f, 0f)
                    }
                }
            },
    ) { content() }
}

/**
 * Fraction (width, height) of the screen the video surface must occupy so that a film of
 * [videoAspect] appears undistorted and as large as possible on a panel squeezed by [squeeze]
 * (the surface is drawn with RESIZE_MODE_FILL).
 */
fun videoBoxFraction(videoAspect: Float, squeeze: Float, signalAspect: Float = 16f / 9f): Pair<Float, Float> {
    if (videoAspect <= 0f) return 1f to 1f
    val panel = signalAspect * squeeze
    return if (videoAspect >= panel) 1f to (panel / videoAspect) else (videoAspect / panel) to 1f
}
