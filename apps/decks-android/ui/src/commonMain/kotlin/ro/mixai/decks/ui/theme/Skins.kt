package ro.mixai.decks.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import ro.mixai.decks.ui.engine.LayoutDoc
import ro.mixai.decks.ui.engine.PackPort
import ro.mixai.mobile.theme.Oklch
import ro.mixai.mobile.theme.TokenRoles

/**
 * Decks skins (WP19-18): a skin = design-token dimensions (mode, accent hue, surface, density,
 * radius, motion) + a layout ([layoutId], WP19-34). Colours are derived at runtime from the
 * generated OKLCH role table ([TokenRoles]) with the same OKLab → sRGB maths as
 * packages/design-tokens `oklchToHex`; an installed `.mixaipack` skin ([packId]) may override
 * individual roles with colours that decks-packs has already validated and resolved to sRGB.
 */
data class DecksSkin(
    val id: String,
    val dark: Boolean = true,
    val accent: String = TokenRoles.DEFAULT_ACCENT,
    val surface: String = "solid",
    val density: String = "comfortable",
    val radius: String = "md",
    val reducedMotion: Boolean = false,
    /** Built-in layout id (`classic`, `performance`, …) or a pack layout `<packId>/<layoutId>`. */
    val layoutId: String = DEFAULT_LAYOUT,
    val highContrast: Boolean = false,
    /** Installed skin pack whose colour overrides apply on top of the roles (null = none). */
    val packId: String? = null,
) {
    val accentHue: Float get() = TokenRoles.accentHues[accent] ?: TokenRoles.accentHues.getValue(TokenRoles.DEFAULT_ACCENT)
    val radiusDp: Int get() = TokenRoles.radiusDp[radius] ?: 10
    val controlHeightDp: Int get() = TokenRoles.controlHeightDp[density] ?: 40
    val textScale: Float get() = TokenRoles.textScale[density] ?: 1f
    val surfaceAlpha: Float get() = TokenRoles.surfaceAlpha[surface] ?: 1f

    /** Stable "k=v;…" form for preferences (no JSON dependency in commonMain). */
    fun encode(): String = listOf(
        "id" to id, "dark" to dark, "accent" to accent, "surface" to surface, "density" to density,
        "radius" to radius, "motion" to if (reducedMotion) "reduced" else "full", "layout" to layoutId,
        "contrast" to highContrast, "pack" to (packId ?: ""),
    ).joinToString(";") { (k, v) -> "$k=$v" }

    /**
     * The layout to show from [available] (built-ins first, then pack layouts). Decks 1.3 stored a
     * pack layout by its bare id: it maps to the namespaced id when exactly one pack layout carries
     * it (same rule as `remapLegacyRef` in pack-layouts.ts). Anything unknown → classic.
     */
    fun resolveLayout(available: List<LayoutDoc>): LayoutDoc? {
        available.firstOrNull { it.id == layoutId }?.let { return it }
        val hits = available.filter { it.id.contains('/') && it.id.substringAfterLast('/') == layoutId }
        if (hits.size == 1) return hits[0]
        return available.firstOrNull { it.id == DEFAULT_LAYOUT } ?: available.firstOrNull()
    }

    companion object {
        const val DEFAULT_LAYOUT = "classic"

        val presets: List<DecksSkin> = listOf(
            DecksSkin("nocturne"),
            DecksSkin("club", accent = "magenta", surface = "flat", density = "compact", radius = "sm", layoutId = "performance"),
            DecksSkin("booth", accent = "amber", surface = "solid", density = "comfortable", radius = "lg", highContrast = true),
            // Light + cyan/amber accents put light text on a light primary (< 4.5:1, SkinTest); violet passes.
            DecksSkin("studio", dark = false, accent = "violet", surface = "solid", radius = "md", layoutId = "library"),
            DecksSkin("emerald", accent = "emerald", surface = "glass", density = "compact"),
        )
        val default: DecksSkin get() = presets.first()

        private val slug = Regex("^[a-z0-9][a-z0-9.-]{0,63}$")
        private val packIdRe = Regex("^[a-z0-9]+(\\.[a-z0-9-]+){1,6}$")

        /** Built-in / user layout slug, or `<packId>/<slug>` (pack layouts). */
        fun validLayoutId(s: String): Boolean {
            val i = s.lastIndexOf('/')
            return if (i < 0) slug.matches(s) else packIdRe.matches(s.substring(0, i)) && s.length <= 170 && slug.matches(s.substring(i + 1))
        }

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
                // Legacy values classic | performance | library are the built-in preset ids.
                layoutId = m["layout"]?.takeIf { validLayoutId(it) } ?: d.layoutId,
                highContrast = m["contrast"]?.toBooleanStrictOrNull() ?: d.highContrast,
                packId = m["pack"]?.takeIf { packIdRe.matches(it) && it.length <= 100 },
            )
        }
    }
}

/**
 * Colour overrides of an installed skin pack: pack token key (`primary`, `background`, `deck-a`, …)
 * → colour. Empty when there is no port, no pack id or the pack is gone.
 */
fun packColorOverrides(port: PackPort?, packId: String?): Map<String, Color> {
    if (port == null || packId == null) return emptyMap()
    val pack = runCatching { port.list().firstOrNull { it.id == packId } }.getOrNull() ?: return emptyMap()
    return pack.colors.mapValues { (_, argb) -> Color(argb.toInt()) }
}

/** Resolved colours of a skin; [overrides] = [packColorOverrides] (pack token key → colour). */
class DecksPalette(skin: DecksSkin, private val overrides: Map<String, Color> = emptyMap()) {
    private val roles = if (skin.dark) TokenRoles.dark else TokenRoles.light
    private val hue = skin.accentHue
    private fun token(name: String): Color = roles[name]?.let { Oklab.toColor(it, hue) } ?: Color.Magenta
    private fun role(name: String, pack: String): Color = overrides[pack] ?: token(name)

    val background = role("background", "background")
    val surface = role("card", "card").let { c ->
        if ("card" in overrides) c else c.copy(alpha = skin.surfaceAlpha.coerceAtLeast(if (skin.highContrast) 1f else 0f))
    }
    val surfaceRaised = role("secondary", "secondary")
    val sidebar = token("sidebar")
    val foreground = role("foreground", "foreground")
    val muted = if (skin.highContrast) foreground else role("mutedForeground", "muted-foreground")
    val border = if (skin.highContrast) foreground.copy(alpha = 0.6f) else role("border", "border")
    val input = role("input", "input")
    val primary = role("primary", "primary")
    /** Token `primary-foreground`, unless the other foreground role reads better on this primary (light mode: < 4.5:1). */
    val onPrimary = listOf(role("primaryForeground", "primary-foreground"), foreground).maxBy { Oklab.contrast(it, primary) }
    val accent = role("accent", "accent")
    val ring = role("ring", "ring")
    val danger = role("destructive", "destructive")
    val warning = role("warning", "warning")
    val success = role("success", "success")
    val waveLow = token("chart4")
    val waveMid = token("chart1")
    val waveHigh = token("chart3")
    /** Deck identity colours: brand-fixed unless a pack sets `deck-a..deck-d` (or `decks.a..d`). */
    val decks: List<Color> = listOf("deck-a", "deck-b", "deck-c", "deck-d")
        .zip(listOf(ro.mixai.mobile.theme.Tokens.brandDeckA, ro.mixai.mobile.theme.Tokens.brandDeckB,
            ro.mixai.mobile.theme.Tokens.brandDeckC, ro.mixai.mobile.theme.Tokens.brandDeckD))
        .map { (k, brand) -> overrides[k] ?: brand }
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
