package ro.mixai.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ro.mixai.app.R

// Material 3 theme mapped from the generated design tokens (Tokens.kt / TokensLight). Dark-first,
// light supported, dynamic colour OFF (brand). Space Grotesk headings + Inter body (bundled OFL
// variable fonts in res/font; licences in assets/licenses).

private fun variable(res: Int, weight: FontWeight) =
    Font(res, weight, variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)))

val InterFamily = FontFamily(
    variable(R.font.inter_variable, FontWeight.Normal),
    variable(R.font.inter_variable, FontWeight.Medium),
    variable(R.font.inter_variable, FontWeight.SemiBold),
    variable(R.font.inter_variable, FontWeight.Bold),
)

val GroteskFamily = FontFamily(
    variable(R.font.space_grotesk_variable, FontWeight.Medium),
    variable(R.font.space_grotesk_variable, FontWeight.SemiBold),
    variable(R.font.space_grotesk_variable, FontWeight.Bold),
)

private fun heading(size: Int, line: Int, w: FontWeight = FontWeight.SemiBold) =
    TextStyle(fontFamily = GroteskFamily, fontWeight = w, fontSize = size.sp, lineHeight = line.sp, letterSpacing = (-0.2).sp)

private fun body(size: Int, line: Int, w: FontWeight = FontWeight.Normal) =
    TextStyle(fontFamily = InterFamily, fontWeight = w, fontSize = size.sp, lineHeight = line.sp)

val MixaiTypography = Typography(
    displayLarge = heading(52, 58, FontWeight.Bold),
    displayMedium = heading(42, 48, FontWeight.Bold),
    displaySmall = heading(34, 40, FontWeight.Bold),
    headlineLarge = heading(30, 36),
    headlineMedium = heading(26, 32),
    headlineSmall = heading(22, 28),
    titleLarge = heading(20, 26),
    titleMedium = body(16, 22, FontWeight.SemiBold),
    titleSmall = body(14, 20, FontWeight.SemiBold),
    bodyLarge = body(16, 24),
    bodyMedium = body(14, 20),
    bodySmall = body(12, 16),
    labelLarge = body(14, 20, FontWeight.Medium),
    labelMedium = body(12, 16, FontWeight.Medium),
    labelSmall = body(11, 14, FontWeight.Medium),
)

val MixaiShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

private val DarkScheme: ColorScheme = darkColorScheme(
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
    surface = Tokens.background,
    onSurface = Tokens.foreground,
    surfaceVariant = Tokens.secondary,
    onSurfaceVariant = Tokens.mutedForeground,
    surfaceContainerLowest = Tokens.background,
    surfaceContainerLow = Tokens.sidebar,
    surfaceContainer = Tokens.card,
    surfaceContainerHigh = Tokens.sidebarAccent,
    surfaceContainerHighest = Tokens.secondary,
    inverseSurface = Tokens.foreground,
    inverseOnSurface = Tokens.background,
    error = Tokens.destructive,
    onError = Tokens.destructiveForeground,
    outline = Tokens.input,
    outlineVariant = Tokens.border,
    scrim = Tokens.background,
)

private val LightScheme: ColorScheme = lightColorScheme(
    primary = TokensLight.primary,
    onPrimary = TokensLight.primaryForeground,
    primaryContainer = TokensLight.accent,
    onPrimaryContainer = TokensLight.accentForeground,
    secondary = Tokens.brandCyan,
    onSecondary = TokensLight.foreground,
    secondaryContainer = TokensLight.secondary,
    onSecondaryContainer = TokensLight.secondaryForeground,
    tertiary = Tokens.brandMagenta,
    onTertiary = TokensLight.background,
    background = TokensLight.background,
    onBackground = TokensLight.foreground,
    surface = TokensLight.background,
    onSurface = TokensLight.foreground,
    surfaceVariant = TokensLight.secondary,
    onSurfaceVariant = TokensLight.mutedForeground,
    surfaceContainerLowest = TokensLight.card,
    surfaceContainerLow = TokensLight.sidebar,
    surfaceContainer = TokensLight.card,
    surfaceContainerHigh = TokensLight.sidebarAccent,
    surfaceContainerHighest = TokensLight.secondary,
    inverseSurface = TokensLight.foreground,
    inverseOnSurface = TokensLight.background,
    error = TokensLight.destructive,
    onError = TokensLight.destructiveForeground,
    outline = TokensLight.input,
    outlineVariant = TokensLight.border,
    scrim = TokensLight.foreground,
)

/** Extra semantic colours Material 3 has no slot for. */
@Immutable
data class MixaiColors(
    val success: Color,
    val warning: Color,
    val info: Color,
    val muted: Color,
    val card: Color,
    val border: Color,
    /** Always-dark base under backdrops/video, regardless of light/dark mode. */
    val scrimBase: Color,
    val onScrim: Color,
    val brandViolet: Color,
    val brandMagenta: Color,
    val brandCyan: Color,
    val isDark: Boolean,
)

val LocalMixaiColors = staticCompositionLocalOf {
    MixaiColors(Tokens.success, Tokens.warning, Tokens.info, Tokens.mutedForeground, Tokens.card, Tokens.border,
        Tokens.background, Tokens.foreground, Tokens.brandViolet, Tokens.brandMagenta, Tokens.brandCyanDark, true)
}

/** `mode`: "system" | "dark" | "light". */
@Composable
fun MixaiTheme(mode: String = "system", content: @Composable () -> Unit) {
    val dark = when (mode) { "dark" -> true; "light" -> false; else -> isSystemInDarkTheme() }
    val extra = if (dark) {
        MixaiColors(Tokens.success, Tokens.warning, Tokens.info, Tokens.mutedForeground, Tokens.card, Tokens.border,
            Tokens.background, Tokens.foreground, Tokens.brandVioletDark, Tokens.brandMagentaDark, Tokens.brandCyanDark, true)
    } else {
        MixaiColors(TokensLight.success, TokensLight.warning, TokensLight.info, TokensLight.mutedForeground, TokensLight.card, TokensLight.border,
            Tokens.background, Tokens.foreground, Tokens.brandViolet, Tokens.brandMagenta, Tokens.brandCyan, false)
    }
    androidx.compose.runtime.CompositionLocalProvider(LocalMixaiColors provides extra) {
        MaterialTheme(
            colorScheme = if (dark) DarkScheme else LightScheme,
            typography = MixaiTypography,
            shapes = MixaiShapes,
            content = content,
        )
    }
}

object Mixai {
    val colors: MixaiColors @Composable get() = LocalMixaiColors.current
}
