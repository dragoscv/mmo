package ro.mixai.decks.ui.theme

import androidx.compose.ui.graphics.Color
import ro.mixai.mobile.theme.Oklch

/**
 * Decks 1.5 look layer for Compose: the mirror of `apps/mixai/src/look/look.css` (numbers) and of
 * the `style` block of a skin (`src/look/style-vars.ts`). When the two disagree, the TS side wins.
 *
 * `signature` (default) = flat, dense, black-green "MixAI Signature"; `classic` = the 1.x look
 * (shared design tokens, glass / solid surfaces, token radii), kept as skin "Glass (classic)".
 */
const val LOOK_SIGNATURE = "signature"
const val LOOK_CLASSIC = "classic"

/**
 * What a built-in skin sets beyond the token dimensions (`PackTokens.colors` / `decks` / `style` of
 * `src/packs/builtin-skins.ts`). Keys are the TS keys: [base] = pack token key (`background`,
 * `muted-foreground`, …), [colors] = `STYLE_COLORS` key (`well`, `waveLow`, `cue1`, …), [sizes] =
 * `STYLE_SIZES` key (`panelGap`, `controlRadius`, `wavePlayedAlpha`, …).
 */
data class SkinStyle(
    val platter: Boolean? = null,
    /** `stacked` (one lane per deck) or `overlay` (every deck in one lane). */
    val waves: String = "stacked",
    val base: Map<String, Color> = emptyMap(),
    /** Deck colours a..d; empty = the brand deck colours. */
    val decks: List<Color> = emptyList(),
    val colors: Map<String, Color> = emptyMap(),
    val sizes: Map<String, Double> = emptyMap(),
)

/** Numbers of `:root[data-look="signature"]` / `.dark[data-look="signature"]` in look.css. */
object SignatureLook {
    private fun o(l: Float, c: Float, h: Float) = Oklch(l, c, h, 1f)

    /** Role overrides in dark mode (TokenRoles key → OKLCH; hue < 0 = the accent hue). */
    val dark: Map<String, Oklch> = mapOf(
        "background" to o(0.1f, 0.008f, 165f),
        "foreground" to o(0.96f, 0.006f, 165f),
        "card" to o(0.165f, 0.01f, 165f),
        "cardForeground" to o(0.96f, 0.006f, 165f),
        "popover" to o(0.195f, 0.012f, 165f),
        "popoverForeground" to o(0.96f, 0.006f, 165f),
        "secondary" to o(0.24f, 0.012f, 165f),
        "secondaryForeground" to o(0.96f, 0.006f, 165f),
        "muted" to o(0.24f, 0.012f, 165f),
        "mutedForeground" to o(0.74f, 0.012f, 165f),
        "border" to o(0.285f, 0.012f, 165f),
        "input" to o(0.32f, 0.012f, 165f),
        "primary" to o(0.8f, 0.19f, -1f),
        "primaryForeground" to o(0.16f, 0.04f, -1f),
        "accent" to o(0.27f, 0.055f, -1f),
        "accentForeground" to o(0.92f, 0.09f, -1f),
        "ring" to o(0.8f, 0.19f, -1f),
    )

    /** Recessed wells, the waveform backdrop and the third text level (dark / light). */
    val wellDark = o(0.125f, 0.008f, 165f)
    val waveBgDark = o(0.07f, 0.006f, 165f)
    val faintDark = o(0.65f, 0.012f, 165f)
    val wellLight = o(0.955f, 0.006f, 165f)
    val waveBgLight = o(0.98f, 0.004f, 165f)
    val faintLight = o(0.46f, 0.02f, 165f)

    /** Hot cues 1..8 (red, orange, blue, yellow, green, magenta, cyan, purple). */
    val cues: List<Oklch> = listOf(
        o(0.64f, 0.21f, 25f), o(0.74f, 0.17f, 55f), o(0.6f, 0.19f, 258f), o(0.86f, 0.17f, 95f),
        o(0.7f, 0.19f, 145f), o(0.65f, 0.22f, 345f), o(0.76f, 0.12f, 205f), o(0.58f, 0.21f, 300f),
    )

    const val PANEL_GAP = 2.0
    const val PANEL_RADIUS = 2f
    const val PANEL_PAD = 8f
    const val CONTROL_RADIUS = 3f
    const val WAVE_PLAYED_ALPHA = 0.4f

    /** Waveform bands = three tones of the deck colour: `color-mix(in oklch, deck 52%, black)` / deck / `42%, white`. */
    const val WAVE_LOW_MIX = 0.52f
    const val WAVE_HIGH_MIX = 0.42f
}

/**
 * Styles of the built-in skins, same values as `src/packs/builtin-skins.ts` (the one TS file where
 * colour literals are allowed; this is its Kotlin mirror). Every literal is written exactly as the
 * TS file writes it (`#rrggbb` or `oklch(L C H)`), and desktopTest/BuiltinSkinsDriftTest reads the
 * TS file and fails on any difference: change the TS file first, then this one. Skin ids here are
 * the last segment of the TS pack ids (`ro.mixai.skin.mainroom` → `mainroom`). Neutral names, no
 * logos, no artwork of the products these skins are familiar to.
 */
object BuiltinSkins {
    /**
     * An opaque colour literal of builtin-skins.ts: `#rrggbb` (exactly six hex digits) or
     * `oklch(L C H)` with plain numbers (converted with the token maths, [Oklab.toSrgb]). Anything
     * else throws: a typo must fail the tests, not shift the channels.
     */
    fun color(s: String): Color {
        if (s.startsWith("oklch(") && s.endsWith(")")) {
            val p = s.substring(6, s.length - 1).split(' ').filter { it.isNotEmpty() }.map { it.toDoubleOrNull() }
            require(p.size == 3 && p.all { it != null }) { "oklch(L C H) expected, got '$s'" }
            val (r, g, b) = Oklab.toSrgb(p[0]!!, p[1]!!, p[2]!!)
            return Color(r, g, b, 255)
        }
        require(s.length == 7 && s[0] == '#' && s.drop(1).all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
            "#rrggbb expected, got '$s'"
        }
        val v = s.substring(1).toInt(16)
        return Color((v shr 16) and 0xFF, (v shr 8) and 0xFF, v and 0xFF, 255)
    }

    private fun colors(vararg p: Pair<String, String>): Map<String, Color> = p.associate { it.first to color(it.second) }

    private fun decks(a: String, b: String, c: String, d: String) = listOf(color(a), color(b), color(c), color(d))

    /** Mainroom: black window, flat neutral greys, one blue for ON, waveform in blue tones, square corners. */
    private val mainroom = SkinStyle(
        waves = "stacked",
        base = colors(
            "background" to "#000000", "foreground" to "#ffffff", "card" to "#1e1e1e", "card-foreground" to "#ffffff",
            "popover" to "#232323", "popover-foreground" to "#ffffff", "secondary" to "#2b2b2b",
            "secondary-foreground" to "#ffffff", "muted" to "#2b2b2b", "muted-foreground" to "#b4b4b4",
            "border" to "#3d3d3d", "input" to "#4a4a4a", "primary" to "#1470e6", "primary-foreground" to "#ffffff",
            "accent" to "#1d4468", "accent-foreground" to "#ffffff", "ring" to "#4d9bff",
        ),
        decks = decks("#dfe7f2", "#dfe7f2", "#dfe7f2", "#dfe7f2"),
        colors = colors(
            "well" to "#111111", "waveBg" to "#000000", "line" to "#3d3d3d", "faint" to "#9c9c9c", "on" to "#1470e6",
            "onFg" to "#ffffff", "play" to "#46a85c", "playFg" to "#04120a", "cue" to "#eab651", "alert" to "#f0453d",
            "waveLow" to "#0d55d6", "waveMid" to "#3f9cec", "waveHigh" to "#e4f0fb", "waveGrid" to "#8a8a8a",
            "waveDownbeat" to "#e0443c", "wavePlayhead" to "#e6edf2", "wavePlayheadCap" to "#e72727",
            "cue1" to "#e0507f", "cue2" to "#d08a5e", "cue3" to "#6f9ed6", "cue4" to "#cdb84e",
            "cue5" to "#8fb86c", "cue6" to "#9a80c8", "cue7" to "#7fb4c6", "cue8" to "#5cb884",
        ),
        sizes = mapOf("panelGap" to 2.0, "panelRadius" to 0.0, "controlRadius" to 2.0, "padRadius" to 2.0, "wavePlayedAlpha" to 1.0),
    )

    /** Crate: warm dark grey with black wells, spectrum waveform (bass red, mids green, treble blue), platter. */
    private val crate = SkinStyle(
        platter = true,
        waves = "stacked",
        base = colors(
            "background" to "#1b1a19", "foreground" to "#f4f3f1", "card" to "#2a2928", "card-foreground" to "#f4f3f1",
            "popover" to "#201f1e", "popover-foreground" to "#f4f3f1", "secondary" to "#090909",
            "secondary-foreground" to "#f4f3f1", "muted" to "#090909", "muted-foreground" to "#b5b3b0",
            "border" to "#444341", "input" to "#545250", "primary" to "#0a7ac6", "primary-foreground" to "#ffffff",
            "accent" to "#004e81", "accent-foreground" to "#ffffff", "ring" to "#35a2ea",
        ),
        decks = decks("#3aaaf2", "#3aaaf2", "#3aaaf2", "#3aaaf2"),
        colors = colors(
            "well" to "#050505", "waveBg" to "#000000", "line" to "#444341", "faint" to "#a09e9c", "on" to "#0a7ac6",
            "onFg" to "#ffffff", "play" to "#0a7ac6", "playFg" to "#ffffff", "cue" to "#d8d6d3", "alert" to "#ff3b30",
            "waveLow" to "#e0262c", "waveMid" to "#2fca4c", "waveHigh" to "#4f97ff", "waveGrid" to "#9a9a9a",
            "waveDownbeat" to "#ffffff", "wavePlayhead" to "#ffffff", "wavePlayheadCap" to "#ffffff",
            "cue1" to "#d8001c", "cue2" to "#ff7a00", "cue3" to "#1f5ee0", "cue4" to "#ffbb00",
            "cue5" to "#00ae00", "cue6" to "#e01ba2", "cue7" to "#8a45e0", "cue8" to "#16b9d4",
        ),
        sizes = mapOf("panelGap" to 3.0, "panelRadius" to 3.0, "controlRadius" to 3.0, "padRadius" to 3.0, "wavePlayedAlpha" to 1.0),
    )

    /**
     * Pilot: blue-grey chrome, deck A blue / deck B red, both waveforms in one band, platter. ON is a
     * neutral light fill (the two deck colours are the only hues on the decks). The tinted greys are
     * `oklch()` in the TS file and are kept in that form here.
     */
    private val pilot = SkinStyle(
        platter = true,
        waves = "overlay",
        base = colors(
            "background" to "oklch(0.209 0.006 271)", "foreground" to "oklch(0.944 0.003 286)",
            "card" to "oklch(0.306 0.009 277)", "card-foreground" to "oklch(0.944 0.003 286)",
            "popover" to "oklch(0.277 0.007 275)", "popover-foreground" to "oklch(0.944 0.003 286)",
            "secondary" to "oklch(0.261 0.008 275)", "secondary-foreground" to "oklch(0.944 0.003 286)",
            "muted" to "oklch(0.261 0.008 275)", "muted-foreground" to "oklch(0.777 0.006 286)",
            "border" to "oklch(0.414 0.01 278)", "input" to "oklch(0.473 0.011 280)",
            "primary" to "oklch(0.874 0.003 286)", "primary-foreground" to "oklch(0.188 0.004 286)",
            "accent" to "oklch(0.373 0.01 278)", "accent-foreground" to "#ffffff", "ring" to "#45b4dc",
        ),
        decks = decks("#33add9", "#f76b7a", "#1fbda4", "#ee7d4f"),
        colors = colors(
            "well" to "oklch(0.188 0.004 286)", "waveBg" to "oklch(0.177 0.004 265)", "line" to "oklch(0.191 0.006 271)",
            "faint" to "oklch(0.713 0.006 286)", "on" to "oklch(0.874 0.003 286)", "onFg" to "oklch(0.188 0.004 286)",
            "playFg" to "oklch(0.16 0.004 271)", "cue" to "oklch(0.877 0.004 286)", "alert" to "#f4525a",
            "waveGrid" to "oklch(0.573 0.006 275)", "waveDownbeat" to "oklch(0.861 0.007 277)",
            "wavePlayhead" to "oklch(0.861 0.007 277)", "wavePlayheadCap" to "oklch(0.861 0.007 277)",
            "cue1" to "#e01410", "cue2" to "#dc9410", "cue3" to "#3a46f0", "cue4" to "#d6d200",
            "cue5" to "#0fd216", "cue6" to "#de18d6", "cue7" to "#12cfd8", "cue8" to "#a22ae6",
        ),
        sizes = mapOf(
            "panelGap" to 4.0, "panelRadius" to 3.0, "controlRadius" to 2.0, "padRadius" to 2.0, "controlHeight" to 26.0,
            "wavePlayedAlpha" to 1.0,
        ),
    )

    val styles: Map<String, SkinStyle> = mapOf("mainroom" to mainroom, "crate" to crate, "pilot" to pilot)

    fun style(id: String): SkinStyle? = styles[id]
}
