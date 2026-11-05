package ro.mixai.tv.ui.components

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import coil3.compose.AsyncImage
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.tv.ui.theme.Tokens

/**
 * Full-bleed backdrop behind every screen (WP16-17, cinematic backdrop-first). Any screen sets the
 * focused item's image with `LocalBackdrop.current.show(url)`; changes are debounced 120 ms (fast
 * D-pad scrolling does not thrash the decoder) and crossfaded 300 ms.
 */
@Stable
class BackdropState {
    /** Currently displayed image URL (null = plain background). */
    var url by mutableStateOf<String?>(null)
        private set

    /** 0..1 strength of the image (screens with dense UI may dim it). */
    var intensity by mutableStateOf(1f)

    private val scope = MainScope()
    private var pending: Job? = null

    /** Show [url] after a short debounce; null clears. */
    fun show(url: String?) {
        AmbientMotion.poke()
        pending?.cancel()
        if (url == this.url) return
        pending = scope.launch { delay(120); this@BackdropState.url = url }
    }

    /** Show immediately (no debounce). */
    fun showNow(url: String?) { pending?.cancel(); this.url = url }

    fun clear() = showNow(null)
}

val LocalBackdrop = staticCompositionLocalOf { BackdropState() }

/** Last user input (key event or backdrop change): ambient motion pauses while the user navigates. */
object AmbientMotion {
    @Volatile var lastInputMs: Long = 0L
        private set

    /** Called from `MainActivity.dispatchKeyEvent` and [BackdropState.show]. */
    fun poke() { lastInputMs = android.os.SystemClock.uptimeMillis() }
}

/** Provides a [BackdropState] and draws it beneath [content]. */
@Composable
fun BackdropHost(state: BackdropState = remember { BackdropState() }, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalBackdrop provides state) {
        Box(modifier.fillMaxSize().background(Tokens.background)) {
            BackdropLayer(state)
            content()
        }
    }
}

/**
 * The image + scrims (left→transparent, bottom→background).
 *
 * Fill-rate matters on TV GPUs (Chromecast measured: 6 stacked full-screen fills → p50 frame 120 ms,
 * GPU-bound). The image is drawn opaque and each scrim only covers the band where it is not fully
 * transparent (left 70 %, bottom 55 %), so most pixels are written ≤ 3×.
 */
@Composable
fun BackdropLayer(state: BackdropState, modifier: Modifier = Modifier) {
    val dim = Tokens.background.copy(alpha = 1f - 0.85f * state.intensity)
    val reduced = LocalReducedMotion.current
    // Ambient "living" backdrop (WP16 critic P2-8): slow Ken Burns 1.0 → 1.06 over 36 s, reversed.
    // Applied as the transform of the cached offscreen layer below, so each frame only re-composites
    // the existing texture (no re-raster of image + scrims). The origin sits right of centre, so the
    // left/bottom scrim edges only move outwards and keep covering the text side.
    // The drift is ~2 px/s, so it is stepped at ~12 Hz (sub-pixel steps) instead of every vsync, and
    // it pauses while the user navigates (any focus move → `show`) until 2.5 s of idle: D-pad frames
    // never compete with it, and the frame clock stays idle between steps.
    val still = reduced || PerfFlags.noKenBurns
    val kenBurns = remember { mutableFloatStateOf(1f) }
    LaunchedEffect(still) {
        if (still) { kenBurns.floatValue = 1f; return@LaunchedEffect }
        var clock = 0L // advances only while idle, so a pause freezes the frame instead of jumping
        while (true) {
            delay(KEN_BURNS_STEP_MS)
            if (android.os.SystemClock.uptimeMillis() - AmbientMotion.lastInputMs < KEN_BURNS_IDLE_MS) continue
            clock += KEN_BURNS_STEP_MS
            val t = (clock % (2L * KEN_BURNS_MS)).toFloat() / KEN_BURNS_MS
            val phase = if (t <= 1f) t else 2f - t // ping-pong 0..1..0
            val eased = phase * phase * (3f - 2f * phase) // smoothstep
            kenBurns.floatValue = 1f + (KEN_BURNS_SCALE - 1f) * eased
        }
    }
    // Offscreen layer: HWUI keeps the rasterised backdrop + scrims as a texture and only redraws it
    // when the image/crossfade changes, so focus moves elsewhere cost one textured quad, not two
    // full-screen gradient passes (Chromecast: scrims alone were p50 73 → 38 ms).
    Box(modifier.fillMaxSize().graphicsLayer {
        compositingStrategy = if (PerfFlags.noLayerCache) CompositingStrategy.Auto else CompositingStrategy.Offscreen
        val s = kenBurns.floatValue
        scaleX = s
        scaleY = s
        transformOrigin = KEN_BURNS_ORIGIN
    }.drawWithCache {
        val left = Brush.horizontalGradient(
            0f to Tokens.background,
            0.5f to Tokens.background.copy(alpha = 0.85f),
            1f to Color.Transparent,
            startX = 0f, endX = size.width * 0.7f,
        )
        val bottomTop = size.height * 0.45f
        val bottom = Brush.verticalGradient(
            0f to Color.Transparent,
            0.25f to Tokens.background.copy(alpha = 0.3f),
            0.65f to Tokens.background.copy(alpha = 0.85f),
            1f to Tokens.background,
            startY = bottomTop, endY = size.height,
        )
        onDrawWithContent {
            drawContent()
            if (PerfFlags.noScrim) return@onDrawWithContent
            drawRect(left, size = Size(size.width * 0.7f, size.height))
            drawRect(bottom, topLeft = Offset(0f, bottomTop), size = Size(size.width, size.height - bottomTop))
        }
    }) {
        Crossfade(targetState = if (PerfFlags.noBackdrop) null else state.url, animationSpec = tween(if (PerfFlags.noCrossfade || reduced) 0 else 300), label = "backdrop") { u ->
            if (u != null) {
                AsyncImage(
                    model = u,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
                // Dimming as part of the image layer instead of an extra translucent full-screen pass.
                if (state.intensity < 0.999f) Box(Modifier.fillMaxSize().background(dim))
            }
        }
    }
}

private const val KEN_BURNS_MS = 36_000
private const val KEN_BURNS_STEP_MS = 80L
private const val KEN_BURNS_IDLE_MS = 2_500L
private const val KEN_BURNS_SCALE = 1.06f
private val KEN_BURNS_ORIGIN = TransformOrigin(0.72f, 0.32f)

/** Clears the backdrop while this composable is on screen (e.g. Settings) and restores it after. */
@Composable
fun NoBackdrop() {
    val b = LocalBackdrop.current
    DisposableEffect(b) {
        val prev = b.url
        b.showNow(null)
        onDispose { b.showNow(prev) }
    }
}
