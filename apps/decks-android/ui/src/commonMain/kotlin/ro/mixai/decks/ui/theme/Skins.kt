package ro.mixai.decks.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.math.PI
import kotlin.math.cbrt
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.LayoutDoc
import ro.mixai.decks.ui.engine.PackPort
import ro.mixai.mobile.theme.Oklch
import ro.mixai.mobile.theme.TokenRoles

/**
 * Decks skins (WP19-18, Decks 1.5 look): a skin = a look ([look]: `signature` = the flat
 * black-green default, `classic` = the 1.x look) + design-token dimensions (mode, accent hue,
 * surface, density, radius, motion) + a layout ([layoutId], WP19-34). Colours are derived at
 * runtime from the generated OKLCH role table ([TokenRoles]) with the same OKLab → sRGB maths as
 * packages/design-tokens `oklchToHex`; the Signature look replaces the dark roles with the numbers
 * of look.css ([SignatureLook]); a built-in skin adds its style ([BuiltinSkins]); an installed
 * `.mixaipack` skin ([packId]) may override individual roles with colours that decks-packs has
 * already validated and resolved to sRGB.
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
    /** Base look: [LOOK_SIGNATURE] (default, as `styleLook` of style-vars.ts) or [LOOK_CLASSIC]. */
    val look: String = LOOK_SIGNATURE,
) {
    val accentHue: Float get() = TokenRoles.accentHues[accent] ?: TokenRoles.accentHues.getValue(TokenRoles.DEFAULT_ACCENT)
    val radiusDp: Int get() = TokenRoles.radiusDp[radius] ?: 10
    val controlHeightDp: Int get() = TokenRoles.controlHeightDp[density] ?: 40
    val textScale: Float get() = TokenRoles.textScale[density] ?: 1f
    /** The Signature look is flat: panels are always opaque. */
    val surfaceAlpha: Float get() = if (signature) 1f else TokenRoles.surfaceAlpha[surface] ?: 1f

    val signature: Boolean get() = look != LOOK_CLASSIC

    /** Style of a built-in skin (Mainroom, Crate, Pilot); null for the plain looks. */
    val style: SkinStyle? get() = BuiltinSkins.style(id)

    private fun size(key: String): Double? = style?.sizes?.get(key)

    /** Panel corner radius (dp): `--panel-radius` (Signature 2), token radius × 1.2 in the classic look. */
    val panelRadiusDp: Float get() = size("panelRadius")?.toFloat() ?: if (signature) SignatureLook.PANEL_RADIUS else radiusDp * 1.2f

    /** Control corner radius (dp): `--ctl-radius` (Signature 3), token radius × 0.8 in the classic look. */
    val controlRadiusDp: Float get() = size("controlRadius")?.toFloat() ?: if (signature) SignatureLook.CONTROL_RADIUS else radiusDp * 0.8f

    /** Padding inside a panel (dp): `--panel-pad` (Signature 8), 10 in the classic look. */
    val panelPadDp: Float get() = size("panelPad")?.toFloat() ?: if (signature) SignatureLook.PANEL_PAD else 10f

    /** Gap between layout panels (dp) for layouts without their own gap: `--panel-gap` (Signature 2, classic 12). */
    val panelGapDp: Double get() = size("panelGap") ?: if (signature) SignatureLook.PANEL_GAP else DemoPacks.DEFAULT_GAP

    /** Opacity of the already-played part of a waveform (`--wave-played-alpha`; 1 = not dimmed). */
    val wavePlayedAlpha: Float get() = size("wavePlayedAlpha")?.toFloat() ?: if (signature) SignatureLook.WAVE_PLAYED_ALPHA else 1f

    /** Every deck in one waveform lane (`style.waves = "overlay"`) instead of one lane per deck. */
    val wavesOverlay: Boolean get() = style?.waves == "overlay"

    /** Stable "k=v;…" form for preferences (no JSON dependency in commonMain). */
    fun encode(): String = listOf(
        "id" to id, "dark" to dark, "accent" to accent, "surface" to surface, "density" to density,
        "radius" to radius, "motion" to if (reducedMotion) "reduced" else "full", "layout" to layoutId,
        "contrast" to highContrast, "pack" to (packId ?: ""), "look" to look,
    ).joinToString(";") { (k, v) -> "$k=$v" }

    /**
     * The layout to show from [available] (built-ins first, then pack layouts). Decks 1.3 stored a
     * pack layout by its bare id: it maps to the namespaced id when exactly one pack layout carries
        * it (same rule as `remapLegacyRef` in pack-layouts.ts). Anything unknown → [DEFAULT_LAYOUT].
     */
    fun resolveLayout(available: List<LayoutDoc>): LayoutDoc? {
        available.firstOrNull { it.id == layoutId }?.let { return it }
        val hits = available.filter { it.id.contains('/') && it.id.substringAfterLast('/') == layoutId }
        if (hits.size == 1) return hits[0]
        return available.firstOrNull { it.id == DEFAULT_LAYOUT } ?: available.firstOrNull()
    }

    companion object {
        /**
         * Layout the Compose apps open on: Pro, the contract default (`DEFAULT_LAYOUT.id` of presets.ts
         * = [DemoPacks.DEFAULT_LAYOUT_ID], checked against the fixtures). The Compose deck / mixer /
         * library are the Decks 1.5 strips sized for the `PANEL_SPECS` minimums (rendered in the minimum
         * box of every tier by desktopTest/ContentMinimumsTest), so the solver's tiers are drawn as given.
         */
        const val DEFAULT_LAYOUT = "pro"

        /** The default layout of Decks ≤ 1.4 (`CLASSIC.id` of presets.ts): a pre-1.5 save on it moves to [DEFAULT_LAYOUT] once. */
        const val LEGACY_DEFAULT_LAYOUT = "classic"

        /** Accent of the Signature default (`SIGNATURE_PREFS` of look.ts): green = ON. */
        const val SIGNATURE_ACCENT = "emerald"

        val presets: List<DecksSkin> = listOf(
            // MixAI Signature (default): black-green, flat, dense; `SIGNATURE_PREFS` of look.ts on [DEFAULT_LAYOUT].
            DecksSkin("signature", accent = SIGNATURE_ACCENT, surface = "flat", density = "compact", radius = "sm"),
            // Familiar skins, same tokens and layouts as builtin-skins.ts (styles in [BuiltinSkins]; the values and
            // the `style.layout` of each are compared with the TS file by desktopTest/BuiltinSkinsDriftTest):
            // Mainroom `pro`, Crate `pro-vertical`, Pilot `pro`.
            DecksSkin("mainroom", accent = SIGNATURE_ACCENT, surface = "flat", density = "compact", radius = "sm", layoutId = "pro"),
            DecksSkin("crate", accent = SIGNATURE_ACCENT, surface = "flat", density = "compact", radius = "sm", layoutId = "pro-vertical"),
            DecksSkin("pilot", accent = SIGNATURE_ACCENT, surface = "flat", density = "compact", radius = "sm", layoutId = "pro"),
            // The Decks 1.x look (`ro.mixai.skin.glass-classic`): glass panels, violet accent, roomy controls, 1.x layout.
            DecksSkin("glass-classic", accent = "violet", surface = "glass", density = "comfortable", radius = "lg",
                layoutId = "classic", look = LOOK_CLASSIC),
            DecksSkin("club", accent = "magenta", surface = "flat", density = "compact", radius = "sm", layoutId = "performance",
                look = LOOK_CLASSIC),
            DecksSkin("booth", accent = "amber", surface = "solid", density = "comfortable", radius = "lg", highContrast = true,
                layoutId = "classic", look = LOOK_CLASSIC),
            // Light + cyan/amber accents put light text on a light primary (< 4.5:1, SkinTest); violet passes.
            DecksSkin("studio", dark = false, accent = "violet", surface = "solid", radius = "md", layoutId = "library",
                look = LOOK_CLASSIC),
            DecksSkin("emerald", accent = "emerald", surface = "glass", density = "compact", layoutId = "classic",
                look = LOOK_CLASSIC),
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
            val packId = m["pack"]?.takeIf { packIdRe.matches(it) && it.length <= 100 }
            // No `look` key = saved by Decks ≤ 1.4: move once to the Signature look (as `migrateLookOnce` of
            // look.ts). A non-default accent was a choice and is kept, and so is a chosen layout. `classic` was
            // the default layout up to 1.4, so a save that names it is an install that never chose: it moves to
            // [DEFAULT_LAYOUT] (Pro), as the desktop app does (`migrateDefaultLayout` of layout-store.ts). Once
            // only: the first save by 1.5 writes the `look` key, and a layout picked after that is kept, Classic
            // included. The old look stays available as the skin "Glass (classic)", which opens on Classic.
            if (m["look"] !in setOf(LOOK_SIGNATURE, LOOK_CLASSIC)) {
                return default.copy(
                    accent = m["accent"]?.takeIf { it in TokenRoles.accentHues.keys && it != TokenRoles.DEFAULT_ACCENT } ?: default.accent,
                    layoutId = m["layout"]?.takeIf { validLayoutId(it) && it != LEGACY_DEFAULT_LAYOUT } ?: default.layoutId,
                    reducedMotion = m["motion"] == "reduced",
                    highContrast = m["contrast"]?.toBooleanStrictOrNull() ?: false,
                    packId = packId,
                )
            }
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
                packId = packId,
                look = m.getValue("look"),
            )
        }
    }
}

/**
 * Colour overrides of an installed skin pack: pack token key (`primary`, `background`, `deck-a`, …)
 * → colour, plus the `style.colors` of a manifest-v2 pack under `style.<key>` (`style.well`,
 * `style.waveLow`, …; pack token keys never contain a dot). Empty when there is no port, no pack id
 * or the pack is gone. The other style fields of a pack (sizes, look, layout, waves) are not applied yet.
 */
fun packColorOverrides(port: PackPort?, packId: String?): Map<String, Color> {
    if (port == null || packId == null) return emptyMap()
    val pack = runCatching { port.list().firstOrNull { it.id == packId } }.getOrNull() ?: return emptyMap()
    val out = LinkedHashMap<String, Color>()
    for ((k, argb) in pack.colors) out[k] = Color(argb.toInt())
    for ((k, argb) in pack.style?.colors.orEmpty()) out[PACK_STYLE_PREFIX + k] = Color(argb.toInt())
    return out
}

/** Prefix of a pack's `style.colors` entries inside [packColorOverrides]. */
const val PACK_STYLE_PREFIX = "style."

/** Resolved colours of a skin; [overrides] = [packColorOverrides] (pack token key → colour). */
class DecksPalette(skin: DecksSkin, private val overrides: Map<String, Color> = emptyMap()) {
    private val signature = skin.signature
    private val dark = skin.dark
    private val style: SkinStyle? = skin.style
    /** look.css only re-colours the dark mode; the light Signature look keeps the token roles. */
    private val lookRoles: Map<String, Oklch> = if (signature && skin.dark) SignatureLook.dark else emptyMap()
    private val roles = if (skin.dark) TokenRoles.dark else TokenRoles.light
    private val hue = skin.accentHue
    private fun token(name: String): Color = (lookRoles[name] ?: roles[name])?.let { Oklab.toColor(it, hue) } ?: Color.Magenta
    /** Installed pack → built-in skin style → look → design tokens. */
    private fun role(name: String, pack: String): Color = overrides[pack] ?: style?.base?.get(pack) ?: token(name)
    /** A `style.colors` entry (`STYLE_COLORS` key of style-vars.ts): installed pack first, then the built-in skin. */
    private fun styled(key: String): Color? = overrides[PACK_STYLE_PREFIX + key] ?: style?.colors?.get(key)
    private fun look(onDark: Oklch, onLight: Oklch): Color = Oklab.toColor(if (dark) onDark else onLight, hue)

    val background = role("background", "background")
    val surface = role("card", "card").let { c ->
        if ("card" in overrides || style?.base?.containsKey("card") == true) c
        else c.copy(alpha = skin.surfaceAlpha.coerceAtLeast(if (skin.highContrast) 1f else 0f))
    }
    val surfaceRaised = role("secondary", "secondary")
    val sidebar = token("sidebar")
    val foreground = role("foreground", "foreground")
    val muted = if (skin.highContrast) foreground else role("mutedForeground", "muted-foreground")
    val border = if (skin.highContrast) foreground.copy(alpha = 0.6f) else styled("line") ?: role("border", "border")
    val input = role("input", "input")
    val primary = role("primary", "primary")
    /** Token `primary-foreground`, unless the other foreground role reads better on this primary (light mode: < 4.5:1). */
    val onPrimary = listOf(role("primaryForeground", "primary-foreground"), foreground).maxBy { Oklab.contrast(it, primary) }
    val accent = role("accent", "accent")
    val ring = role("ring", "ring")
    val danger = role("destructive", "destructive")
    val warning = role("warning", "warning")
    val success = role("success", "success")

    /** Deck identity colours: brand-fixed unless a skin or a pack sets `deck-a..deck-d` (or `decks.a..d`). */
    val decks: List<Color> = listOf("deck-a", "deck-b", "deck-c", "deck-d")
        .zip(listOf(ro.mixai.mobile.theme.Tokens.brandDeckA, ro.mixai.mobile.theme.Tokens.brandDeckB,
            ro.mixai.mobile.theme.Tokens.brandDeckC, ro.mixai.mobile.theme.Tokens.brandDeckD))
        .mapIndexed { i, (k, brand) -> overrides[k] ?: style?.decks?.getOrNull(i) ?: brand }

    // ---- look roles (look.css "semantic control colours"; the classic look keeps its 1.x picks) ----

    /** Recessed wells (`--well`). */
    val well = styled("well") ?: if (signature) look(SignatureLook.wellDark, SignatureLook.wellLight) else surfaceRaised
    /** Waveform backdrop (`--wave-bg`). */
    val waveBg = styled("waveBg") ?: if (signature) look(SignatureLook.waveBgDark, SignatureLook.waveBgLight) else background
    /** Third text level: micro labels (`--fg-faint`). */
    val faint = if (skin.highContrast) foreground
        else styled("faint") ?: if (signature) look(SignatureLook.faintDark, SignatureLook.faintLight) else muted
    /** ON state of toggles (`--on` / `--on-fg`): one accent for every ON state. */
    val on = styled("on") ?: primary
    val onFg = styled("onFg") ?: onPrimary
    /** CUE button (`--cue-btn`) and end-of-track alert (`--alert`). */
    val cueButton = styled("cue") ?: warning
    val alert = styled("alert") ?: danger
    /** PLAY: the skin's fixed colour (`--skin-play`), else the deck colour. */
    private val playFixed = styled("play")
    fun play(deck: Int): Color = playFixed ?: decks[deck.coerceIn(0, decks.lastIndex)]

    /** Beatgrid, downbeat and playhead on every waveform (`--wave-grid`, `--wave-downbeat`, `--wave-playhead`). */
    val waveGrid = styled("waveGrid")?.copy(alpha = 0.45f) ?: if (signature) foreground.copy(alpha = 0.22f) else border
    val waveDownbeat = (styled("waveDownbeat") ?: foreground).copy(alpha = if (style != null) 0.8f else 0.55f)
    val wavePlayhead = styled("wavePlayhead") ?: if (signature) foreground else danger
    val wavePlayedAlpha = skin.wavePlayedAlpha

    /**
     * Waveform bands per deck. Signature: three tones of the deck colour (`color-mix(in oklch, deck 52%, black)`,
     * the deck colour, `color-mix(in oklch, deck 42%, white)`); a skin may fix them (`--skin-wave-low|mid|high`);
     * the classic look keeps the 1.x chart tokens.
     */
    private val bands: List<Triple<Color, Color, Color>> = decks.map { deck ->
        Triple(
            styled("waveLow") ?: if (signature) Oklab.mix(deck, Color.Black, SignatureLook.WAVE_LOW_MIX) else token("chart4"),
            styled("waveMid") ?: if (signature) deck else token("chart1"),
            styled("waveHigh") ?: if (signature) Oklab.mix(deck, Color.White, SignatureLook.WAVE_HIGH_MIX) else token("chart3"),
        )
    }
    fun waveLow(deck: Int): Color = bands[deck.coerceIn(0, bands.lastIndex)].first
    fun waveMid(deck: Int): Color = bands[deck.coerceIn(0, bands.lastIndex)].second
    fun waveHigh(deck: Int): Color = bands[deck.coerceIn(0, bands.lastIndex)].third

    /** Hot cues 1..8 (`--cue-1..8`); the classic look borrowed the four deck colours. */
    val cues: List<Color> = List(8) { i ->
        styled("cue${i + 1}") ?: if (signature) Oklab.toColor(SignatureLook.cues[i], hue) else decks[i % 4]
    }
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
        return labToSrgb(l, c * cos(hr), c * sin(hr))
    }

    /** OKLab (L, a, b) → 8-bit sRGB. */
    fun labToSrgb(l: Double, a: Double, bb: Double): Triple<Int, Int, Int> {
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

    /** sRGB colour → OKLab (L, a, b); the inverse of [labToSrgb] (Ottosson's matrices). Alpha is ignored. */
    fun toLab(c: Color): Triple<Double, Double, Double> {
        fun lin(v: Float): Double = if (v <= 0.04045f) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)
        val r = lin(c.red)
        val g = lin(c.green)
        val b = lin(c.blue)
        val l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        val m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        val s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return Triple(
            0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
        )
    }

    /**
     * CSS `color-mix(in oklch, a <share>, b)` for an achromatic [b] (black / white: its hue is
     * "missing", so lightness and chroma interpolate and the hue of [a] is kept), which is a
     * straight line in OKLab. Opaque result.
     */
    fun mix(a: Color, b: Color, share: Float): Color {
        val (l1, a1, b1) = toLab(a)
        val (l2, a2, b2) = toLab(b)
        val t = share.coerceIn(0f, 1f).toDouble()
        val (r, g, bl) = labToSrgb(l1 * t + l2 * (1 - t), a1 * t + a2 * (1 - t), b1 * t + b2 * (1 - t))
        return Color(r, g, bl, 255)
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
