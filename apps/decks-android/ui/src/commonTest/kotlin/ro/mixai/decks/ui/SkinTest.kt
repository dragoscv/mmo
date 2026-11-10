package ro.mixai.decks.ui

import androidx.compose.ui.graphics.Color
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.DecksPalette
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.Oklab
import ro.mixai.decks.ui.theme.SkinState
import ro.mixai.mobile.theme.TokenRoles
import ro.mixai.mobile.theme.Tokens

class SkinTest {
    private fun Color.opaqueOn(bg: Color): Color {
        val a = alpha
        return Color(red * a + bg.red * (1 - a), green * a + bg.green * (1 - a), blue * a + bg.blue * (1 - a), 1f)
    }

    @Test fun runtimeOklchMatchesGeneratedTokens() {
        // Default skin (dark, violet) must reproduce the build-time Tokens.kt exactly (same maths, same rounding).
        val p = DecksPalette(DecksSkin.default.copy(surface = "flat"))
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
        val junk = DecksSkin.decode("id=club;accent=neon;radius=xxl;dark=maybe;layout=?")
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
            val s = DecksSkin.decode("id=nocturne;layout=$key")
            assertEquals(key, s.layoutId)
            assertEquals(key, s.resolveLayout(DemoPacks.presets)?.id)
        }
        // A bare pack-local id maps to the namespaced pack layout when it is unique.
        val pack = DemoPacks.presets.first { it.id == "stage" }.copy(id = "com.example.bundle.x/festival")
        val all = DemoPacks.presets + pack
        assertEquals(pack.id, DecksSkin.decode("layout=festival").resolveLayout(all)?.id)
        assertEquals(pack.id, DecksSkin.decode("layout=com.example.bundle.x/festival").resolveLayout(all)?.id)
        assertEquals("classic", DecksSkin.decode("layout=missing").resolveLayout(all)?.id)
        assertEquals("classic", DecksSkin.decode("layout=../evil").layoutId)
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
