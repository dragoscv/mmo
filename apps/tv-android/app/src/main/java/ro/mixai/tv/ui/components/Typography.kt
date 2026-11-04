package ro.mixai.tv.ui.components

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Typography
import ro.mixai.tv.ui.theme.Tokens

// TV type scale (WP16-17) derived from the 10-foot root font (`Tokens.ROOT_FONT_SP` = 24 px on a
// 1080p canvas ≈ 16 sp at 1.5x density). Every step is a ratio of that root so a token change
// rescales the whole UI. Wired into MixaiTheme (`MaterialTheme.typography`).
object TvType {
    /** Root body size in sp (24 px on a 1920×1080 dp canvas at density 1.5 → 16 sp). */
    val root: Float = Tokens.ROOT_FONT_SP * (2f / 3f)

    private fun s(ratio: Float): TextUnit = (root * ratio).sp
    private fun style(ratio: Float, weight: FontWeight, lineRatio: Float = 1.25f, tracking: Float = 0f) =
        TextStyle(fontSize = s(ratio), fontWeight = weight, lineHeight = s(ratio * lineRatio), letterSpacing = tracking.em)

    val display = style(3.5f, FontWeight.Bold, 1.1f, -0.02f)
    val displayMedium = style(2.75f, FontWeight.Bold, 1.1f, -0.02f)
    val displaySmall = style(2.25f, FontWeight.SemiBold, 1.15f, -0.01f)
    val headline = style(2.0f, FontWeight.SemiBold, 1.2f, -0.01f)
    val headlineMedium = style(1.75f, FontWeight.SemiBold, 1.2f)
    val headlineSmall = style(1.5f, FontWeight.SemiBold, 1.2f)
    val title = style(1.375f, FontWeight.SemiBold)
    val titleMedium = style(1.125f, FontWeight.Medium)
    val titleSmall = style(1.0f, FontWeight.Medium)
    val body = style(1.0f, FontWeight.Normal, 1.4f)
    val bodyMedium = style(0.9375f, FontWeight.Normal, 1.4f)
    val bodySmall = style(0.8125f, FontWeight.Normal, 1.35f)
    val label = style(0.875f, FontWeight.Medium, 1.2f, 0.01f)
    val labelMedium = style(0.8125f, FontWeight.Medium, 1.2f, 0.02f)
    val labelSmall = style(0.6875f, FontWeight.SemiBold, 1.2f, 0.04f)

    /** tv-material [Typography] built from the scale above. */
    val material: Typography = Typography(
        displayLarge = display,
        displayMedium = displayMedium,
        displaySmall = displaySmall,
        headlineLarge = headline,
        headlineMedium = headlineMedium,
        headlineSmall = headlineSmall,
        titleLarge = title,
        titleMedium = titleMedium,
        titleSmall = titleSmall,
        bodyLarge = body,
        bodyMedium = bodyMedium,
        bodySmall = bodySmall,
        labelLarge = label,
        labelMedium = labelMedium,
        labelSmall = labelSmall,
    )
}
