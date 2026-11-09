package ro.mixai.decks.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import ro.mixai.mobile.theme.Oklch
import ro.mixai.mobile.theme.TokenRoles

/**
 * Decks skins (WP19-18): a skin = design-token dimensions (mode, accent hue, surface, density,
 * radius, motion) + a layout preset. Colours are derived at runtime from the generated OKLCH role
 * table ([TokenRoles]) with the same OKLab → sRGB maths as packages/design-tokens `oklchToHex`, so
 * a skin can never introduce an off-palette colour.
 */
enum class DeckLayout(val key: String) {
    /** Deck A | mixer | deck B, library below (default). */
    Classic("classic"),
    /** Waveforms enlarged, jogs hidden, compact mixer — for controller users. */
    Performance("performance"),
    /** Library first, decks condensed — for set preparation. */
    Library("library");

    companion object {
        fun of(key: String?) = entries.firstOrNull { it.key == key } ?: Classic
    }
}

data class DecksSkin(
    val id: String,
    val dark: Boolean = true,
    val accent: String = TokenRoles.DEFAULT_ACCENT,
    val surface: String = "solid",
    val density: String = "comfortable",
    val radius: String = "md",
    val reducedMotion: Boolean = false,
    val layout: DeckLayout = DeckLayout.Classic,
    val highContrast: Boolean = false,
) {
    val accentHue: Float get() = TokenRoles.accentHues[accent] ?: TokenRoles.accentHues.getValue(TokenRoles.DEFAULT_ACCENT)
    val radiusDp: Int get() = TokenRoles.radiusDp[radius] ?: 10
    val controlHeightDp: Int get() = TokenRoles.controlHeightDp[density] ?: 40
    val textScale: Float get() = TokenRoles.textScale[density] ?: 1f
    val surfaceAlpha: Float get() = TokenRoles.surfaceAlpha[surface] ?: 1f

    /** Stable "k=v;…" form for preferences (no JSON dependency in commonMain). */
    fun encode(): String = listOf(
        "id" to id, "dark" to dark, "accent" to accent, "surface" to surface, "density" to density,
        "radius" to radius, "motion" to if (reducedMotion) "reduced" else "full", "layout" to layout.key,
        "contrast" to highContrast,
    ).joinToString(";") { (k, v) -> "$k=$v" }

    companion object {
        val presets: List<DecksSkin> = listOf(
            DecksSkin("nocturne"),
            DecksSkin("club", accent = "magenta", surface = "flat", density = "compact", radius = "sm", layout = DeckLayout.Performance),
            DecksSkin("booth", accent = "amber", surface = "solid", density = "comfortable", radius = "lg", highContrast = true),
            // Light + cyan/amber accents put light text on a light primary (< 4.5:1, SkinTest); violet passes.
            DecksSkin("studio", dark = false, accent = "violet", surface = "solid", radius = "md", layout = DeckLayout.Library),
            DecksSkin("emerald", accent = "emerald", surface = "glass", density = "compact"),
        )
        val default: DecksSkin get() = presets.first()

        /** Unknown or invalid fields fall back to the default; never throws. */
        fun decode(s: String?): DecksSkin {
            if (s.isNullOrBlank()) return default
            val m = s.split(';').mapNotNull { p -> p.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
            val d = presets.firstOrNull { it.id == m["id"] } ?: default
            fun pick(key: String, allowed: Collection<String>, fallback: String) = m[key]?.takeIf { it in allowed } ?: fallback
            return DecksSkin(
                id = m["id"]?.takeIf { it.isNotBlank() && it.length <= 32 } ?: d.id,
                dark = m["dark"]?.toBooleanStrictOrNull() ?: d.dark,
                accent = pick("accent", TokenRoles.accentHues.keys, d.accent),
                surface = pick("surface", TokenRoles.surfaces, d.surface),
                density = pick("density", TokenRoles.controlHeightDp.keys, d.density),
                radius = pick("radius", TokenRoles.radiusDp.keys, d.radius),
                reducedMotion = m["motion"]?.let { it == "reduced" } ?: d.reducedMotion,
                layout = m["layout"]?.let { DeckLayout.of(it) } ?: d.layout,
                highContrast = m["contrast"]?.toBooleanStrictOrNull() ?: d.highContrast,
            )
        }
    }
}

/** Resolved colours of a skin. */
class DecksPalette(skin: DecksSkin) {
    private val roles = if (skin.dark) TokenRoles.dark else TokenRoles.light
    private val hue = skin.accentHue
    private fun role(name: String): Color = roles[name]?.let { Oklab.toColor(it, hue) } ?: Color.Magenta

    val background = role("background")
    val surface = role("card").let { it.copy(alpha = skin.surfaceAlpha.coerceAtLeast(if (skin.highContrast) 1f else 0f)) }
    val surfaceRaised = role("secondary")
    val sidebar = role("sidebar")
    val foreground = role("foreground")
    val muted = if (skin.highContrast) foreground else role("mutedForeground")
    val border = if (skin.highContrast) foreground.copy(alpha = 0.6f) else role("border")
    val input = role("input")
    val primary = role("primary")
    /** Token `primary-foreground`, unless the other foreground role reads better on this primary (light mode: < 4.5:1). */
    val onPrimary = listOf(role("primaryForeground"), role("foreground")).maxBy { Oklab.contrast(it, primary) }
    val accent = role("accent")
    val ring = role("ring")
    val danger = role("destructive")
    val warning = role("warning")
    val success = role("success")
    val waveLow = role("chart4")
    val waveMid = role("chart1")
    val waveHigh = role("chart3")
}

/** OKLCH → sRGB, identical constants to packages/design-tokens/src/generate.ts `oklchToHex`. */
object Oklab {
    fun toColor(o: Oklch, accentHue: Float): Color {
        val h = if (o.h < 0f) accentHue else o.h
        val (r, g, b) = toSrgb(o.l.toDouble(), o.c.toDouble(), h.toDouble())
        return Color(r, g, b, (o.a.coerceIn(0f, 1f) * 255f).roundToInt())
    }

    /** 8-bit sRGB components, rounded like the generator. */
    fun toSrgb(l: Double, c: Double, h: Double): Triple<Int, Int, Int> {
        val hr = h * PI / 180.0
        val a = c * cos(hr)
        val bb = c * sin(hr)
        val l1 = l + 0.3963377774 * a + 0.2158037573 * bb
        val m1 = l - 0.1055613458 * a - 0.0638541728 * bb
        val s1 = l - 0.0894841775 * a - 1.291485548 * bb
        val ll = l1 * l1 * l1
        val mm = m1 * m1 * m1
        val ss = s1 * s1 * s1
        val r = 4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss
        val g = -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss
        val bl = -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss
        fun gam(x: Double): Int {
            val v = x.coerceIn(0.0, 1.0)
            val e = if (v <= 0.0031308) 12.92 * v else 1.055 * v.pow(1.0 / 2.4) - 0.055
            return (e * 255).roundToInt()
        }
        return Triple(gam(r), gam(g), gam(bl))
    }

    /** WCAG 2.x contrast ratio between two opaque colours. */
    fun contrast(a: Color, b: Color): Double {
        fun lin(c: Float): Double = if (c <= 0.04045f) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        fun lum(c: Color) = 0.2126 * lin(c.red) + 0.7152 * lin(c.green) + 0.0722 * lin(c.blue)
        val la = lum(a)
        val lb = lum(b)
        return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
    }
}
