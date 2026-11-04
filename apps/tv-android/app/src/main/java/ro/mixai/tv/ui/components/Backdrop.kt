package ro.mixai.tv.ui.components

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
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
        pending?.cancel()
        if (url == this.url) return
        pending = scope.launch { delay(120); this@BackdropState.url = url }
    }

    /** Show immediately (no debounce). */
    fun showNow(url: String?) { pending?.cancel(); this.url = url }

    fun clear() = showNow(null)
}

val LocalBackdrop = staticCompositionLocalOf { BackdropState() }

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

/** The image + scrims (left→transparent, bottom→background). */
@Composable
fun BackdropLayer(state: BackdropState, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize()) {
        Crossfade(targetState = state.url, animationSpec = tween(300), label = "backdrop") { u ->
            if (u != null) {
                AsyncImage(
                    model = u,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    alpha = 0.85f * state.intensity,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
        // Left scrim keeps text readable over any image.
        Box(
            Modifier.fillMaxSize().background(
                Brush.horizontalGradient(
                    0f to Tokens.background,
                    0.35f to Tokens.background.copy(alpha = 0.85f),
                    0.7f to Tokens.background.copy(alpha = 0.25f),
                    1f to Color.Transparent,
                ),
            ),
        )
        // Bottom scrim blends rows into the background.
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to Color.Transparent,
                    0.45f to Tokens.background.copy(alpha = 0.15f),
                    0.8f to Tokens.background.copy(alpha = 0.85f),
                    1f to Tokens.background,
                ),
            ),
        )
    }
}

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
