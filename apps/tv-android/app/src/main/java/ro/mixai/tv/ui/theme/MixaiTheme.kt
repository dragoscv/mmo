package ro.mixai.tv.ui.theme

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Border
import androidx.tv.material3.CardBorder
import androidx.tv.material3.CardColors
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.CardScale
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.SurfaceDefaults
import androidx.tv.material3.darkColorScheme

/** Material colour scheme mapped from the generated design tokens (WP6-03). */
@Composable
fun MixaiTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Tokens.primary,
            onPrimary = Tokens.primaryForeground,
            primaryContainer = Tokens.accent,
            onPrimaryContainer = Tokens.accentForeground,
            secondary = Tokens.brandCyanDark,
            onSecondary = Tokens.background,
            secondaryContainer = Tokens.secondary,
            onSecondaryContainer = Tokens.secondaryForeground,
            tertiary = Tokens.brandMagentaDark,
            onTertiary = Tokens.background,
            background = Tokens.background,
            onBackground = Tokens.foreground,
            surface = Tokens.card,
            onSurface = Tokens.cardForeground,
            surfaceVariant = Tokens.secondary,
            onSurfaceVariant = Tokens.mutedForeground,
            inverseSurface = Tokens.foreground,
            inverseOnSurface = Tokens.background,
            error = Tokens.destructive,
            onError = Tokens.destructiveForeground,
            border = Tokens.border,
            borderVariant = Tokens.input,
            scrim = Tokens.background,
        ),
    ) {
        Surface(colors = SurfaceDefaults.colors(containerColor = Tokens.background, contentColor = Tokens.foreground)) {
            content()
        }
    }
}

/** Shared 10-foot focus constants (docs/design-system.md §6). */
object MixaiFocus {
    val ringWidth = Tokens.FOCUS_RING_DP.dp
    val scale = Tokens.CARD_SCALE_FOCUSED
    val cardShape = RoundedCornerShape(12.dp)
}

@Composable
fun mixaiCardBorder(): CardBorder = CardDefaults.border(
    focusedBorder = Border(BorderStroke(MixaiFocus.ringWidth, Tokens.ring), shape = MixaiFocus.cardShape),
)

@Composable
fun mixaiCardScale(): CardScale = CardDefaults.scale(focusedScale = MixaiFocus.scale)

@Composable
fun mixaiCardColors(): CardColors = CardDefaults.colors(
    containerColor = Tokens.card,
    contentColor = Tokens.cardForeground,
    focusedContainerColor = Tokens.accent,
    focusedContentColor = Tokens.accentForeground,
)
