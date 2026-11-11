package ro.mixai.decks.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ro.mixai.mobile.theme.Tokens

/**
 * Decks palette. Every colour comes from the generated design tokens (packages/design-tokens →
 * Tokens.kt / TokenRoles.kt in :mobile-common, mirrored by `:decks-ui:syncTokens`), re-tinted by
 * the active [DecksSkin] (WP19-18). Backed by snapshot state, so composables and Canvas draws
 * update when the skin changes; non-Compose callers (the native renderer) read the same values.
 */
object DecksColors {
    private var palette by mutableStateOf(DecksPalette(DecksSkin.default))
    private var overrides: Map<String, Color> = emptyMap()

    /** Active skin (set by [DecksTheme]). */
    var skin by mutableStateOf(DecksSkin.default)
        private set

    /** [packColors] = colour overrides of the skin's pack ([packColorOverrides]). */
    fun apply(s: DecksSkin, packColors: Map<String, Color> = emptyMap()) {
        if (s == skin && packColors == overrides) return
        skin = s
        overrides = packColors
        palette = DecksPalette(s, packColors)
    }

    val background get() = palette.background
    val surface get() = palette.surface
    val surfaceRaised get() = palette.surfaceRaised
    val sidebar get() = palette.sidebar
    val foreground get() = palette.foreground
    val muted get() = palette.muted
    val border get() = palette.border
    val input get() = palette.input
    val primary get() = palette.primary
    val onPrimary get() = palette.onPrimary
    val accent get() = palette.accent
    val ring get() = palette.ring
    val danger get() = palette.danger
    val warning get() = palette.warning
    val success get() = palette.success
    /**
     * Deck identity colours are brand-fixed (never re-hued by the accent) so A/B stay recognisable in
     * every skin; only an installed skin pack may set them explicitly (`deck-a..deck-d`).
     */
    val decks: List<Color> get() = palette.decks

    // Look roles (Decks 1.5, look.css): wells, waveform backdrop, micro labels, ON, CUE, alert.
    val well get() = palette.well
    val waveBg get() = palette.waveBg
    val faint get() = palette.faint
    val on get() = palette.on
    val onFg get() = palette.onFg
    val cueButton get() = palette.cueButton
    val alert get() = palette.alert
    val waveGrid get() = palette.waveGrid
    val waveDownbeat get() = palette.waveDownbeat
    val wavePlayhead get() = palette.wavePlayhead
    val wavePlayedAlpha get() = palette.wavePlayedAlpha

    /** Waveform band colours of deck [i] (Signature: three tones of the deck colour). */
    fun waveLow(i: Int): Color = palette.waveLow(i)
    fun waveMid(i: Int): Color = palette.waveMid(i)
    fun waveHigh(i: Int): Color = palette.waveHigh(i)

    /** PLAY colour of deck [i]: the deck colour unless the skin fixes one. */
    fun play(i: Int): Color = palette.play(i)

    /** Hot cue colour of [slot] (0-based, 8 colours). */
    fun cue(slot: Int): Color = palette.cues[slot.mod(palette.cues.size)]

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

fun decksType(scale: Float = 1f) = DecksType(
    label = TextStyle(color = DecksColors.faint, fontSize = (11 * scale).sp, fontWeight = FontWeight.Medium, letterSpacing = 0.6.sp),
    small = TextStyle(color = DecksColors.foreground, fontSize = (12 * scale).sp),
    body = TextStyle(color = DecksColors.foreground, fontSize = (14 * scale).sp),
    title = TextStyle(color = DecksColors.foreground, fontSize = (16 * scale).sp, fontWeight = FontWeight.SemiBold),
    display = TextStyle(color = DecksColors.foreground, fontSize = (22 * scale).sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace),
)

val LocalDecksType = staticCompositionLocalOf { decksType() }

/** Reduced motion flag (OS setting or skin): no continuous jog rotation, no beat pulses, no scrolling grid. */
val LocalReducedMotion = staticCompositionLocalOf { false }

/** Active skin geometry (corner radius, control height, layout). */
val LocalDecksSkin = staticCompositionLocalOf { DecksSkin.default }

/** Control / panel shapes of the skin's look (Signature: 3 dp / 2 dp; classic: from the token radius). */
fun controlShape(skin: DecksSkin) = RoundedCornerShape(skin.controlRadiusDp.dp)
fun panelShape(skin: DecksSkin) = RoundedCornerShape(skin.panelRadiusDp.dp)

@Composable
fun DecksTheme(
    reducedMotion: Boolean,
    skin: DecksSkin = DecksSkin.default,
    packColors: Map<String, Color> = emptyMap(),
    content: @Composable () -> Unit,
) {
    DecksColors.apply(skin, packColors)
    // Recomputed per skin: TextStyles capture the colours at creation time.
    val type = remember(skin, packColors) { decksType(skin.textScale) }
    CompositionLocalProvider(
        LocalReducedMotion provides (reducedMotion || skin.reducedMotion),
        LocalDecksSkin provides skin,
        LocalDecksType provides type,
        content = content,
    )
}

/** Holds the skin chosen in the UI; platforms persist [DecksSkin.encode] and restore with [DecksSkin.decode]. */
class SkinState(initial: DecksSkin, private val onChange: (DecksSkin) -> Unit = {}) {
    var skin by mutableStateOf(initial)
        private set

    /** Bumped after a pack install / removal so pack layouts and colours are re-read. */
    var packRevision by mutableStateOf(0)
        private set

    fun packsChanged() {
        packRevision++
    }

    fun select(s: DecksSkin) {
        if (s == skin) return
        skin = s
        onChange(s)
    }

    /** Next preset (keyboard shortcut / settings cycling). */
    fun cycle() {
        val i = DecksSkin.presets.indexOfFirst { it.id == skin.id }
        select(DecksSkin.presets[(i + 1).mod(DecksSkin.presets.size)])
    }
}
