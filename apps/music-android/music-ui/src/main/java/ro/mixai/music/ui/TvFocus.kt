package ro.mixai.music.ui

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import ro.mixai.mobile.theme.Tokens

// 10-foot / D-pad support for MixAI Music on Android TV and Google TV (WP17-45). One focus treatment
// for every clickable surface: accent ring (Tokens.FOCUS_RING_DP) + slight scale (CARD_SCALE_FOCUSED),
// the same constants MixAI TV uses, drawn with Material 3 so phone + TV share one component tree.

/** True on a leanback device (Android TV / Google TV) or when the UI mode is television. */
fun Context.isTvDevice(): Boolean =
    packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
        (resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_TELEVISION

/** Provided once at the root (MusicRoot); screens read it to switch D-pad-specific behaviour. */
val LocalTvMode = staticCompositionLocalOf { false }

@Composable
fun rememberIsTv(): Boolean {
    val ctx = LocalContext.current
    return remember(ctx) { ctx.isTvDevice() }
}

/**
 * `clickable` with a visible focus state: ring + scale while focused (D-pad, keyboard). Touch input
 * never focuses these, so phones look unchanged.
 */
@Composable
fun Modifier.focusClickable(
    enabled: Boolean = true,
    shape: Shape = MaterialTheme.shapes.small,
    role: Role? = null,
    onClickLabel: String? = null,
    scaleOnFocus: Boolean = true,
    onClick: () -> Unit,
): Modifier {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val ring = MaterialTheme.colorScheme.primary
    return this
        .scale(if (focused && scaleOnFocus) Tokens.CARD_SCALE_FOCUSED else 1f)
        .then(if (focused) Modifier.border(Tokens.FOCUS_RING_DP.dp, ring, shape) else Modifier)
        .clickable(interactionSource = source, indication = androidx.compose.material3.ripple(), enabled = enabled, role = role, onClickLabel = onClickLabel, onClick = onClick)
}
