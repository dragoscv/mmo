package ro.mixai.decks.ui

import androidx.compose.ui.graphics.Color
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.PackPort
import ro.mixai.decks.ui.engine.PackStyleUi
import ro.mixai.decks.ui.engine.PackSummaryUi
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.DecksPalette
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.Oklab
import ro.mixai.decks.ui.theme.SkinState
import ro.mixai.decks.ui.theme.packColorOverrides
import ro.mixai.mobile.theme.TokenRoles
import ro.mixai.mobile.theme.Tokens

class SkinTest {
    private fun Color.opaqueOn(bg: Color): Color {
        val a = alpha
        return Color(red * a + bg.red * (1 - a), green * a + bg.green * (1 - a), blue * a + bg.blue * (1 - a), 1f)
    }

    @Test fun runtimeOklchMatchesGeneratedTokens() {
        // The classic look (dark, violet) must reproduce the build-time Tokens.kt exactly (same maths, same rounding).
        val classic = DecksSkin.presets.first { it.id == "glass-classic" }
        assertEquals(TokenRoles.DEFAULT_ACCENT, classic.accent)
        val p = DecksPalette(classic.copy(surface = "flat"))
        for ((name, want) in listOf("background" to Tokens.background, "primary" to Tokens.primary, "foreground" to Tokens.foreground,
            "ring" to Tokens.ring, "warning" to Tokens.warning)) {
            val got = when (name) {
                "background" -> p.background; "primary" -> p.primary; "foreground" -> p.foreground
                "ring" -> p.ring; else -> p.warning
            }
            assertEquals(DecksColors.rgb(want), DecksColors.rgb(got), "role $name")
        }
    }

    @Test fun everyPresetMeetsWcagAaForText() {
        for (s in DecksSkin.presets) {
            val p = DecksPalette(s)
            val bg = p.background
            val surf = p.surface.opaqueOn(bg)
            assertTrue(Oklab.contrast(p.foreground, bg) >= 7.0, "${s.id}: body text on background")
            assertTrue(Oklab.contrast(p.foreground, surf) >= 4.5, "${s.id}: body text on panels")
            assertTrue(Oklab.contrast(p.muted, surf) >= 4.5, "${s.id}: labels on panels")
            assertTrue(Oklab.contrast(p.onPrimary, p.primary) >= 4.5, "${s.id}: text on primary buttons")
            assertTrue(Oklab.contrast(p.ring, surf) >= 3.0, "${s.id}: focus ring (non-text 3:1)")
        }
    }

    @Test fun boothIsHighContrast() {
        val booth = DecksPalette(DecksSkin.presets.first { it.id == "booth" })
        val noct = DecksPalette(DecksSkin.default)
        val bg = booth.background
        assertTrue(Oklab.contrast(booth.muted, bg) > Oklab.contrast(noct.muted, noct.background))
        assertEquals(1f, booth.surface.alpha)
    }

    @Test fun accentHueRetintsPrimaryButNotDeckColours() {
        val a = DecksPalette(DecksSkin("x", accent = "violet"))
        val b = DecksPalette(DecksSkin("x", accent = "amber"))
        assertTrue(a.primary != b.primary)
        assertEquals(a.background, b.background)
        DecksColors.apply(DecksSkin("x", accent = "amber"))
        assertEquals(Tokens.brandDeckA, DecksColors.deck(0))
        DecksColors.apply(DecksSkin.default)
    }

    @Test fun encodeDecodeRoundTripsAndRejectsJunk() {
        for (s in DecksSkin.presets) assertEquals(s, DecksSkin.decode(s.encode()))
        val junk = DecksSkin.decode("id=club;accent=neon;radius=xxl;dark=maybe;layout=?;look=classic")
        val club = DecksSkin.presets.first { it.id == "club" }
        assertEquals(club.accent, junk.accent)
        assertEquals(club.radius, junk.radius)
        assertEquals(club.dark, junk.dark)
        // An invalid layout id falls back to the preset's own layout.
        assertEquals(club.layoutId, junk.layoutId)
        assertNull(junk.packId)
        assertEquals(DecksSkin.default, DecksSkin.decode(null))
        assertEquals(DecksSkin.default, DecksSkin.decode("garbage"))
    }

    @Test fun legacyLayoutValuesMapToBuiltinPresets() {
        // Decks 1.3 stored layout=classic|performance|library (the old DeckLayout enum keys).
        for (key in listOf("classic", "performance", "library")) {
            val s = DecksSkin.decode("id=glass-classic;layout=$key;look=classic")
            assertEquals(key, s.layoutId)
            assertEquals(key, s.resolveLayout(DemoPacks.presets)?.id)
        }
        // Saved by Decks <= 1.4 (no look key): the saved layout is kept. Unlike the desktop app, `classic` is NOT
        // moved to Pro: the Compose panels still have their 1.4 content (DecksSkin.DEFAULT_LAYOUT).
        assertEquals("performance", DecksSkin.decode("id=nocturne;layout=performance").layoutId)
        assertEquals("classic", DecksSkin.decode("id=nocturne;layout=classic").layoutId)
        assertEquals("pro", DecksSkin.decode("id=nocturne;layout=pro").layoutId, "Pro stays selectable")
        // A bare pack-local id maps to the namespaced pack layout when it is unique.
        val pack = DemoPacks.presets.first { it.id == "stage" }.copy(id = "com.example.bundle.x/festival")
        val all = DemoPacks.presets + pack
        assertEquals(pack.id, DecksSkin.decode("layout=festival").resolveLayout(all)?.id)
        assertEquals(pack.id, DecksSkin.decode("layout=com.example.bundle.x/festival").resolveLayout(all)?.id)
        // Unknown / invalid ids fall back to the default layout of the Compose apps.
        assertEquals(DecksSkin.DEFAULT_LAYOUT, DecksSkin.decode("layout=missing").resolveLayout(all)?.id)
        assertEquals(DecksSkin.DEFAULT_LAYOUT, DecksSkin.decode("layout=../evil").layoutId)
        val withPack = DecksSkin.default.copy(layoutId = pack.id, packId = "com.example.bundle.x")
        assertEquals(withPack, DecksSkin.decode(withPack.encode()))
    }

    @Test fun packColourOverridesReplaceRoles() {
        val red = Color(0xFFFF0000.toInt())
        val cyan = Color(0xFF00E5FF.toInt())
        val p = DecksPalette(DecksSkin.default, mapOf("primary" to red, "deck-a" to cyan, "card" to red))
        assertEquals(red, p.primary)
        assertEquals(cyan, p.decks[0])
        assertEquals(Tokens.brandDeckB, p.decks[1])
        assertEquals(1f, p.surface.alpha, "an explicit pack card colour is kept as given")
        DecksColors.apply(DecksSkin.default, mapOf("deck-a" to cyan))
        assertEquals(cyan, DecksColors.deck(0))
        DecksColors.apply(DecksSkin.default)
        assertEquals(Tokens.brandDeckA, DecksColors.deck(0))
    }

    @Test fun installedV2PackStyleColoursReachTheLookRoles() {
        val pack = PackSummaryUi(
            id = "com.example.skin.x", name = "X", version = "1.0.0", kind = "skin", author = "Me", trust = "unsigned",
            mode = null, accent = null, colors = mapOf("primary" to 0xFF112233), layouts = emptyList(), manifestV = 2,
            style = PackStyleUi(colors = mapOf("on" to 0xFF00FF00, "waveLow" to 0xFF0000FF, "cue" to 0xFFFFAA00)),
        )
        val port = object : PackPort by DemoPacks {
            override fun list(): List<PackSummaryUi> = listOf(pack)
        }
        val plain = DecksPalette(DecksSkin.default)
        val p = DecksPalette(DecksSkin.default, packColorOverrides(port, pack.id))
        assertEquals(Color(0xFF112233.toInt()), p.primary, "pack token colour")
        assertEquals(Color(0xFF00FF00.toInt()), p.on, "style.colors.on")
        assertEquals(Color(0xFF0000FF.toInt()), p.waveLow(0), "style.colors.waveLow")
        assertEquals(Color(0xFF0000FF.toInt()), p.waveLow(1), "a fixed band colour, not a deck tone")
        assertEquals(Color(0xFFFFAA00.toInt()), p.cueButton, "style.colors.cue")
        assertEquals(plain.well, p.well, "style colours the pack does not set keep the look's value")
        assertEquals(plain.waveMid(0), p.waveMid(0))
        assertTrue(packColorOverrides(port, "com.example.skin.other").isEmpty(), "unknown pack id")
        assertTrue(packColorOverrides(null, pack.id).isEmpty())
    }

    @Test fun signatureIsTheDefaultLookWithTheLookCssNumbers() {
        val d = DecksSkin.default
        assertEquals("signature", d.id)
        assertTrue(d.signature && d.dark)
        assertEquals("emerald", d.accent)
        assertEquals("classic", d.layoutId)
        // look.css geometry: panel radius 2, control radius 3, panel pad 8, panel gap 2, flat (opaque) panels.
        assertEquals(2f, d.panelRadiusDp)
        assertEquals(3f, d.controlRadiusDp)
        assertEquals(8f, d.panelPadDp)
        assertEquals(2.0, d.panelGapDp)
        assertEquals(1f, d.surfaceAlpha)
        val p = DecksPalette(d)
        fun rgb(l: Double, c: Double, h: Double) = Oklab.toSrgb(l, c, h).let { (r, g, b) -> ((r shl 16) or (g shl 8) or b).toUInt() }
        // .dark[data-look="signature"]: background, card, secondary, border, foreground, muted-foreground, primary (accent hue 160).
        assertEquals(rgb(0.1, 0.008, 165.0), DecksColors.rgb(p.background))
        assertEquals(rgb(0.165, 0.01, 165.0), DecksColors.rgb(p.surface))
        assertEquals(rgb(0.24, 0.012, 165.0), DecksColors.rgb(p.surfaceRaised))
        assertEquals(rgb(0.285, 0.012, 165.0), DecksColors.rgb(p.border))
        assertEquals(rgb(0.96, 0.006, 165.0), DecksColors.rgb(p.foreground))
        assertEquals(rgb(0.74, 0.012, 165.0), DecksColors.rgb(p.muted))
        assertEquals(rgb(0.8, 0.19, 160.0), DecksColors.rgb(p.primary))
        assertEquals(p.primary, p.on, "green = every ON state")
        // Deck identity stays cyan / magenta (brand tokens); the waveform is three tones of the deck colour.
        assertEquals(Tokens.brandDeckA, p.decks[0])
        assertEquals(Tokens.brandDeckB, p.decks[1])
        assertEquals(Tokens.brandDeckA, p.waveMid(0))
        assertTrue(Oklab.toLab(p.waveLow(0)).first < Oklab.toLab(p.waveMid(0)).first, "low band is darker")
        assertTrue(Oklab.toLab(p.waveHigh(0)).first > Oklab.toLab(p.waveMid(0)).first, "high band is lighter")
        assertTrue(p.waveMid(0) != p.waveMid(1), "bands follow the deck")
        assertEquals(8, p.cues.toSet().size, "eight distinct hot cue colours")
    }

    @Test fun classicLookIsKeptAsASkinAndLegacyPrefsMoveToSignatureOnce() {
        val glass = DecksSkin.presets.first { it.id == "glass-classic" }
        assertTrue(!glass.signature)
        assertEquals("classic", glass.layoutId)
        assertEquals(12.0, glass.panelGapDp)
        assertEquals(TokenRoles.radiusDp.getValue("lg") * 1.2f, glass.panelRadiusDp)
        assertTrue(DecksPalette(glass).surface.alpha < 1f, "glass panels are translucent")
        // Decks 1.4 default (no look key) -> the Signature look on the layout it had; a chosen accent survives, violet (the old default) does not.
        assertEquals(DecksSkin.default, DecksSkin.decode("id=nocturne;dark=true;accent=violet;surface=solid;density=comfortable;radius=md;motion=full;layout=classic;contrast=false;pack="))
        assertEquals("amber", DecksSkin.decode("id=booth;accent=amber;layout=classic").accent)
        assertEquals("signature", DecksSkin.decode("id=booth;accent=amber;layout=classic").id)
        // Once saved by 1.5 the choice sticks, including going back to the classic look.
        assertEquals(glass, DecksSkin.decode(glass.encode()))
    }

    @Test fun familiarSkinsCarryTheBuiltinSkinValues() {
        // Colour VALUES are compared with builtin-skins.ts itself in desktopTest/BuiltinSkinsDriftTest; here: that
        // the palette roles pick them up. Layouts: see DecksSkin.DEFAULT_LAYOUT (TS: pro / pro-vertical / pro).
        val want = mapOf("mainroom" to "classic", "crate" to "pro-vertical", "pilot" to "classic")
        for ((id, layout) in want) {
            val s = DecksSkin.presets.first { it.id == id }
            assertTrue(s.signature, id)
            assertEquals(layout, s.layoutId, id)
            assertTrue(s.style != null, "$id has a style")
        }
        fun rgb(c: Color) = DecksColors.rgb(c).toString(16).padStart(6, '0')
        val mainroom = DecksPalette(DecksSkin.presets.first { it.id == "mainroom" })
        assertEquals("000000", rgb(mainroom.background))
        assertEquals("1470e6", rgb(mainroom.primary))
        assertEquals("0d55d6", rgb(mainroom.waveLow(0)))
        assertEquals(mainroom.waveLow(0), mainroom.waveLow(1), "fixed band colours, not deck tones")
        assertEquals("46a85c", rgb(mainroom.play(0)))
        assertEquals(0f, DecksSkin.presets.first { it.id == "mainroom" }.panelRadiusDp)
        val crate = DecksPalette(DecksSkin.presets.first { it.id == "crate" })
        assertEquals(listOf("e0262c", "2fca4c", "4f97ff"), listOf(rgb(crate.waveLow(0)), rgb(crate.waveMid(0)), rgb(crate.waveHigh(0))))
        assertEquals("d8001c", rgb(crate.cues[0]))
        assertEquals(3.0, DecksSkin.presets.first { it.id == "crate" }.panelGapDp)
        val pilotSkin = DecksSkin.presets.first { it.id == "pilot" }
        val pilot = DecksPalette(pilotSkin)
        assertEquals(listOf("33add9", "f76b7a"), listOf(rgb(pilot.decks[0]), rgb(pilot.decks[1])))
        assertTrue(pilotSkin.wavesOverlay)
        assertEquals(pilot.decks[1], pilot.waveMid(1), "Pilot keeps deck-tone bands")
        assertEquals(4.0, pilotSkin.panelGapDp)
        // Pilot's ON is a neutral light fill (not a hue), with dark text on it.
        val (_, a, b) = Oklab.toLab(pilot.on)
        assertTrue(kotlin.math.hypot(a, b) < 0.01, "neutral ON")
        assertTrue(Oklab.contrast(pilot.onFg, pilot.on) >= 4.5)
    }

    @Test fun skinDimensionsComeFromTokens() {
        val club = DecksSkin.presets.first { it.id == "club" }
        assertEquals(TokenRoles.controlHeightDp.getValue("compact"), club.controlHeightDp)
        assertEquals(TokenRoles.radiusDp.getValue("sm"), club.radiusDp)
        assertTrue(club.textScale < 1f)
    }

    @Test fun skinStateCyclesAndPersists() {
        val saved = mutableListOf<String>()
        val st = SkinState(DecksSkin.default) { saved += it.encode() }
        repeat(DecksSkin.presets.size) { st.cycle() }
        assertEquals(DecksSkin.default, st.skin)
        assertEquals(DecksSkin.presets.size, saved.size)
        st.select(st.skin)
        assertEquals(DecksSkin.presets.size, saved.size, "re-selecting the same skin does not write")
    }
}
