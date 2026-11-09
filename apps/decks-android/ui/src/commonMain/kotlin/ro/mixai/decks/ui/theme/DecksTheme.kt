package ro.mixai.decks.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import ro.mixai.mobile.theme.Tokens

/**
 * Dark-first Decks palette. Every colour comes from the generated design tokens
 * (packages/design-tokens → Tokens.kt, mirrored at build time by `:decks-ui:syncTokens`);
 * no literal colours here.
 */
object DecksColors {
    val background = Tokens.background
    val surface = Tokens.card
    val surfaceRaised = Tokens.secondary
    val sidebar = Tokens.sidebar
    val foreground = Tokens.foreground
    val muted = Tokens.mutedForeground
    val border = Tokens.border
    val input = Tokens.input
    val primary = Tokens.primary
    val onPrimary = Tokens.primaryForeground
    val accent = Tokens.accent
    val ring = Tokens.ring
    val danger = Tokens.destructive
    val warning = Tokens.warning
    val success = Tokens.success
    val decks = listOf(Tokens.brandDeckA, Tokens.brandDeckB, Tokens.brandDeckC, Tokens.brandDeckD)
    val waveLow = Tokens.chart4
    val waveMid = Tokens.chart1
    val waveHigh = Tokens.chart3

    fun deck(i: Int): Color = decks[i.coerceIn(0, decks.lastIndex)]

    /** Camelot key colour ("8A" → keyMinor[7]); muted when unknown. */
    fun key(camelot: String?): Color {
        val c = camelot?.trim()?.uppercase() ?: return muted
        val n = c.dropLast(1).toIntOrNull() ?: return muted
        if (n !in 1..12) return muted
        return if (c.endsWith("A")) Tokens.keyMinor[n - 1] else Tokens.keyMajor[n - 1]
    }

    /** 0xRRGGBB for the native renderer. */
    fun rgb(c: Color): UInt {
        val r = (c.red * 255f + 0.5f).toInt().coerceIn(0, 255)
        val g = (c.green * 255f + 0.5f).toInt().coerceIn(0, 255)
        val b = (c.blue * 255f + 0.5f).toInt().coerceIn(0, 255)
        return ((r shl 16) or (g shl 8) or b).toUInt()
    }
}

data class DecksType(
    val label: TextStyle,
    val small: TextStyle,
    val body: TextStyle,
    val title: TextStyle,
    val display: TextStyle,
)

val LocalDecksType = staticCompositionLocalOf {
    DecksType(
        label = TextStyle(color = DecksColors.muted, fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.6.sp),
        small = TextStyle(color = DecksColors.foreground, fontSize = 12.sp),
        body = TextStyle(color = DecksColors.foreground, fontSize = 14.sp),
        title = TextStyle(color = DecksColors.foreground, fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
        display = TextStyle(color = DecksColors.foreground, fontSize = 22.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace),
    )
}

/** Reduced motion flag (OS setting): no continuous jog rotation, no beat pulses, no scrolling grid. */
val LocalReducedMotion = staticCompositionLocalOf { false }

@Composable
fun DecksTheme(reducedMotion: Boolean, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalReducedMotion provides reducedMotion, content = content)
}
