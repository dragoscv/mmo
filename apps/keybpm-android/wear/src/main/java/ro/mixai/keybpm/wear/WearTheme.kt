package ro.mixai.keybpm.wear

import androidx.compose.runtime.Composable
import androidx.wear.compose.material3.ColorScheme
import androidx.wear.compose.material3.MaterialTheme
import ro.mixai.mobile.theme.Tokens

/** Wear OS is always dark: brand tokens on the Wear Material 3 scheme (same mapping as MixAI Music for Wear). */
private val WearScheme = ColorScheme(
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
    surfaceContainerLow = Tokens.sidebar,
    surfaceContainer = Tokens.card,
    surfaceContainerHigh = Tokens.sidebarAccent,
    onSurface = Tokens.foreground,
    onSurfaceVariant = Tokens.mutedForeground,
    outline = Tokens.input,
    outlineVariant = Tokens.border,
    background = Tokens.background,
    onBackground = Tokens.foreground,
    error = Tokens.destructive,
    onError = Tokens.destructiveForeground,
)

@Composable
fun WearTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = WearScheme, content = content)
}
