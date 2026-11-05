package ro.mixai.app.ui.components

import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.navigation3.ui.LocalNavAnimatedContentScope

/** Provided by AppRoot (SharedTransitionLayout around NavDisplay). Null in previews/tests. */
val LocalSharedTransitionScope = staticCompositionLocalOf<SharedTransitionScope?> { null }

/**
 * Shared-element bounds for poster → title morphs. No-op when there is no shared scope
 * (e.g. inside the player or a dialog). Use the same [key] on both screens (`posterKey(kind, id)`).
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.sharedPoster(key: String): Modifier {
    val shared = LocalSharedTransitionScope.current ?: return this
    // Every screen is composed inside a NavDisplay entry, which provides this scope.
    val animated = LocalNavAnimatedContentScope.current
    return with(shared) {
        this@sharedPoster.sharedBounds(rememberSharedContentState(key), animatedVisibilityScope = animated)
    }
}
