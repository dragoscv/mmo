package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.screens.NativePanels
import ro.mixai.decks.ui.screens.effectiveLayout
import ro.mixai.decks.ui.screens.layoutHostSize
import ro.mixai.decks.ui.screens.layoutRender
import ro.mixai.decks.ui.screens.tierFor
import ro.mixai.decks.ui.screens.withLookGap
import ro.mixai.decks.ui.theme.DecksSkin

/**
 * Pure-Kotlin layout checks (WP19-34). Parity with the TS/Rust solvers over the golden fixtures
 * (docs/decks/fixtures/layout-cases.json) lives in desktopTest/LayoutFixturesTest (needs file I/O).
 */
class LayoutTest {
    private val all = PanelId.entries.toSet()

    @Test fun tracksSplitByWeightAndKeepGaps() {
        val t = DemoPacks.tracks(1012.0, listOf(1.0, 1.0), 12.0)
        assertEquals(listOf(DemoPacks.Track(0.0, 500.0), DemoPacks.Track(512.0, 500.0)), t)
    }

    @Test fun nativeAppDocksPanelsItDoesNotRender() {
        val classic = DemoPacks.presets.first { it.id == "classic" }
        val s = DemoPacks.solve(classic, 1920.0, 1080.0, NativePanels)
        assertEquals(listOf(PanelId.Clock, PanelId.Automix), s.docked)
        assertTrue(s.placements.none { it.panel !in NativePanels })
        assertEquals(s.placements.first { it.panel == PanelId.Library }.rect, s.dock)
    }

    @Test fun essentialsNeverDockAndFallToIcon() {
        for (l in DemoPacks.presets + DemoPacks.phone) {
            val s = DemoPacks.solve(l, 200.0, 200.0, all)
            for (d in s.docked) assertTrue(!DemoPacks.specs.getValue(d).essential, "${l.id}: $d docked")
            assertTrue(s.placements.filter { DemoPacks.specs.getValue(it.panel).essential }.all { it.tier == PanelTier.Icon }, l.id)
        }
    }

    @Test fun placementsStayInsideTheContainerAndNeverOverlap() {
        for (l in DemoPacks.presets + DemoPacks.phone) for ((w, h) in listOf(1280.0 to 720.0, 2560.0 to 1440.0, 400.0 to 800.0)) {
            val ps = DemoPacks.solve(l, w, h, all).placements
            for (p in ps) assertTrue(p.rect.x >= 0 && p.rect.y >= 0 && p.rect.x + p.rect.w <= w + 1e-6 && p.rect.y + p.rect.h <= h + 1e-6, "${l.id} $p")
            for (i in ps.indices) for (j in i + 1 until ps.size) {
                val a = ps[i].rect
                val b = ps[j].rect
                val overlap = a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6
                assertTrue(!overlap, "${l.id} ${ps[i].panel} overlaps ${ps[j].panel}")
            }
        }
    }

    @Test fun minimumSizeMatchesTheTsValues() {
        // Same numbers as the "minimum" block of the golden fixtures (Decks 1.5 panel minimums).
        val want = mapOf("pro" to (860.0 to 596.0), "pro-vertical" to (872.0 to 584.0),
            "classic" to (674.0 to 288.0), "performance" to (674.0 to 246.0), "library" to (674.0 to 336.0),
            "four-deck" to (1093.0 to 274.0), "ultrawide" to (1048.0 to 260.0), "stage" to (924.0 to 166.0))
        for (l in DemoPacks.presets) assertEquals(want.getValue(l.id), DemoPacks.minimumSize(l), l.id)
    }

    @Test fun presetsFollowTheTsOrderAndProIsTheDefault() {
        // BUILTIN_LAYOUTS + STAGE of presets.ts; DEFAULT_LAYOUT = PRO. That the constant equals the TS source and
        // the Rust `layout_default_id` is checked where files and the FFI are available (LayoutFixturesTest).
        assertEquals(
            listOf("pro", "pro-vertical", "classic", "performance", "library", "four-deck", "ultrawide", "stage"),
            DemoPacks.presets.map { it.id },
        )
        assertEquals("pro", DemoPacks.DEFAULT_LAYOUT_ID)
        assertEquals(12, PanelId.entries.size)
        assertEquals(PanelId.Waves, PanelId.of("waves"))
        assertEquals(PanelId.entries.toSet(), DemoPacks.specs.keys)
        for (l in DemoPacks.presets.take(2)) assertTrue(l.areas.any { it.panel == PanelId.Waves }, "${l.id} places the waves panel")
    }

    @Test fun proKeepsFullDecksAndTheWaveBandDownTo1366x768() {
        // Mirror of solver.test.ts "pro (default) keeps full decks, mixer and waveform band…" (Signature gap = 2).
        // These are the SOLVER's tiers (the contract shared with TypeScript and Rust), on the desktop app's host sizes;
        // the Compose panels draw them as given (`panelsAreDrawnAtTheSolversTier`).
        val pro = DemoPacks.presets.first().copy(gap = 2.0)
        fun tier(w: Double, h: Double, p: PanelId) = DemoPacks.solve(pro, w, h, all).placements.firstOrNull { it.panel == p }?.tier
        for ((w, h) in listOf(1492.0 to 929.0, 1912.0 to 1040.0)) {
            for (p in listOf(PanelId.Waves, PanelId.DeckA, PanelId.DeckB, PanelId.Mixer, PanelId.Library)) {
                assertEquals(PanelTier.Full, tier(w, h, p), "$p at ${w}x$h")
            }
        }
        assertEquals(PanelTier.Full, tier(1358.0, 728.0, PanelId.DeckA))
        assertEquals(PanelTier.Full, tier(1358.0, 728.0, PanelId.Waves))
        assertTrue(DemoPacks.solve(pro, 1358.0, 728.0, all).docked.isEmpty())
    }

    @Test fun nativeAppRendersTheWavesPanelOfTheProLayouts() {
        assertTrue(PanelId.Waves in NativePanels)
        for (l in DemoPacks.presets.take(2)) {
            val s = DemoPacks.solve(l.copy(gap = 2.0), 1492.0, 929.0, NativePanels)
            assertTrue(s.docked.isEmpty(), "${l.id}: nothing docked, got ${s.docked}")
            assertTrue(s.placements.any { it.panel == PanelId.Waves }, "${l.id}: waves placed")
        }
    }

    @Test fun panelsAreDrawnAtTheSolversTier() {
        // Decks 1.5: the Compose deck / mixer / crossfader / library are sized for the PANEL_SPECS minimums (rendered
        // in exactly those boxes by desktopTest/ContentMinimumsTest), so the host does not downgrade a tier any more.
        for (l in DemoPacks.presets + DemoPacks.phone) for ((w, h) in listOf(1350.0 to 684.0, 1904.0 to 996.0, 396.0 to 700.0)) {
            val sol = DemoPacks.solve(l.copy(gap = l.gap ?: 2.0), w, h, NativePanels)
            val plan = layoutRender(sol, setOf(PanelId.Waves))
            for (p in plan.panels) assertEquals(sol.placements.first { it.panel == p.panel }.tier, p.tier, "${l.id} ${p.panel} at ${w}x$h")
        }
        // A box the solver did not size (the dock slot under its tabs) gets the solver's own rule, tolerance included.
        assertEquals(PanelTier.Full, tierFor(PanelId.DeckA, 480.0, 250.0))
        assertEquals(PanelTier.Full, tierFor(PanelId.DeckA, 479.6, 249.6), "the solver's 0.5 dp tolerance")
        assertEquals(PanelTier.Compact, tierFor(PanelId.DeckA, 480.0, 249.0))
        assertEquals(PanelTier.Compact, tierFor(PanelId.DeckA, 479.0, 600.0))
        assertEquals(PanelTier.Icon, tierFor(PanelId.DeckB, 339.0, 189.0))
        assertEquals(PanelTier.Icon, tierFor(PanelId.Mixer, 100.0, 60.0), "under every minimum: the icon tier")
        assertEquals(PanelTier.Full, tierFor(PanelId.Library, 520.0, 240.0))
        assertEquals(PanelTier.Compact, tierFor(PanelId.Library, 519.0, 240.0))
        // Classic in a 1350×546 host: the library slot (828×170) carries the dock; under the 48 dp tab strip it is an icon-tier box.
        val classic = layoutRender(DemoPacks.solve(DemoPacks.presets.first { it.id == "classic" }, 1350.0, 546.0, NativePanels))
        assertEquals(PanelTier.Icon, classic.dockTier(PanelId.Library))
        assertEquals(PanelTier.Icon, classic.tier(PanelId.Library), "the host panel is the first dock tab")
        assertEquals(PanelTier.Full, classic.tier(PanelId.DeckA))
    }

    /** Tiers the app draws for [skin] in a [w] × [h] window: solver → [layoutRender], inside the host the shell leaves. */
    private fun rendered(skin: DecksSkin, w: Double, h: Double): Map<PanelId, PanelTier?> {
        val layout = effectiveLayout(skin.resolveLayout(DemoPacks.presets)!!, w.toFloat()).withLookGap(skin)
        val (hw, hh) = layoutHostSize(w, h, skin, layout)
        val plan = layoutRender(DemoPacks.solve(layout, hw, hh, NativePanels))
        return listOf(PanelId.DeckA, PanelId.DeckB, PanelId.Mixer, PanelId.Crossfader).associateWith { plan.tier(it) }
    }

    @Test fun defaultLayoutIsProWithCompactDecksOnALaptopWindowAndFullDecksOnFullHd() {
        assertEquals("pro", DecksSkin.DEFAULT_LAYOUT)
        assertEquals(DemoPacks.DEFAULT_LAYOUT_ID, DecksSkin.DEFAULT_LAYOUT, "the Compose apps open on the contract default")
        assertEquals(DecksSkin.DEFAULT_LAYOUT, DecksSkin.default.layoutId)
        // 1366×768: the shell (60 dp status bar, paddings) leaves a 1350×684 host; Pro's decks are 552×239 there, one
        // step under the 250 dp a full deck needs, the mixer 242×203, the crossfader row 34 dp.
        val laptop = rendered(DecksSkin.default, 1366.0, 768.0)
        assertEquals(PanelTier.Compact, laptop[PanelId.DeckA])
        assertEquals(PanelTier.Compact, laptop[PanelId.DeckB])
        assertEquals(PanelTier.Compact, laptop[PanelId.Mixer])
        assertEquals(PanelTier.Icon, laptop[PanelId.Crossfader])
        // 1920×1080: decks 780×349, mixer 341×297, crossfader row 50 dp.
        val hd = rendered(DecksSkin.default, 1920.0, 1080.0)
        assertEquals(PanelTier.Full, hd[PanelId.DeckA])
        assertEquals(PanelTier.Full, hd[PanelId.DeckB])
        assertEquals(PanelTier.Full, hd[PanelId.Mixer])
        assertEquals(PanelTier.Compact, hd[PanelId.Crossfader])
    }

    @Test fun everySignaturePresetRendersDecksAndMixerAboveTheIconTier() {
        // Mainroom / Pilot use `pro` and Crate `pro-vertical`, as in builtin-skins.ts (compared in BuiltinSkinsDriftTest).
        for (s in DecksSkin.presets.filter { it.signature }) for ((w, h) in listOf(1366.0 to 768.0, 1920.0 to 1080.0)) {
            val t = rendered(s, w, h)
            for (p in listOf(PanelId.DeckA, PanelId.DeckB, PanelId.Mixer)) {
                assertNotEquals(PanelTier.Icon, t[p], "${s.id} (${s.layoutId}): $p at ${w}x$h")
                assertTrue(t[p] != null, "${s.id}: $p is placed")
            }
        }
        assertEquals(listOf("pro", "pro", "pro-vertical", "pro"), listOf("signature", "mainroom", "crate", "pilot").map { id -> DecksSkin.presets.first { it.id == id }.layoutId })
    }

    @Test fun crossfaderRowFitsTheFaderInEveryPresetSkinOnBothWindowSizes() {
        // The crossfader panel needs 28 dp at its icon tier (a 24 dp fader + 2 × 2 padding).
        val iconH = DemoPacks.specs.getValue(PanelId.Crossfader).icon.second
        assertEquals(28.0, iconH)
        for (s in DecksSkin.presets) for ((w, h) in listOf(1366.0 to 768.0, 1920.0 to 1080.0)) {
            val layout = effectiveLayout(s.resolveLayout(DemoPacks.presets)!!, w.toFloat()).withLookGap(s)
            val (hw, hh) = layoutHostSize(w, h, s, layout)
            val cf = DemoPacks.solve(layout, hw, hh, NativePanels).placements.firstOrNull { it.panel == PanelId.Crossfader } ?: continue
            assertTrue(cf.rect.h + DemoPacks.FIT_TOLERANCE >= iconH, "${s.id} ${w}x$h: crossfader row ${cf.rect.h} dp")
        }
    }

    @Test fun dockedWavesPanelLeavesTheDockWhenTheScreenShowsTheStrip() {
        // Vertical waves: the waves column is 7/39 of the width and needs 200 dp, so it docks on a narrow window.
        val vertical = DemoPacks.presets.first { it.id == "pro-vertical" }.copy(gap = 2.0)
        val narrow = DemoPacks.solve(vertical, 984.0, 700.0, NativePanels)
        assertEquals(listOf(PanelId.Waves), narrow.docked)
        val plain = layoutRender(narrow)
        assertTrue(PanelId.Waves in plain.tabs && plain.dock != null, "without the strip, waves is a dock tab")
        assertNull(plain.tier(PanelId.Waves), "…so no waveform is on screen until the tab is picked")
        val withStrip = layoutRender(narrow, setOf(PanelId.Waves))
        assertNull(withStrip.dock, "waves is shown in the strip: nothing left to dock")
        assertTrue(withStrip.tabs.isEmpty())
        assertEquals(narrow.placements.map { it.panel }, withStrip.panels.map { it.panel }, "the dock host goes back to its own slot")
        // Wide enough: the panel is placed and there is no dock.
        val wide = layoutRender(DemoPacks.solve(vertical, 1350.0, 700.0, NativePanels))
        assertTrue(wide.tier(PanelId.Waves) != null && wide.dock == null)
        // Panels this app does not have keep their tab even when the strip takes the waves.
        val classic = layoutRender(DemoPacks.solve(DemoPacks.presets.first { it.id == "classic" }, 1350.0, 546.0, NativePanels), setOf(PanelId.Waves))
        assertEquals(listOf(PanelId.Library, PanelId.Clock, PanelId.Automix), classic.tabs)
    }

    @Test fun phonesGetThePhoneLayoutWithFullDecksAtTabletSize() {
        val pro = DemoPacks.presets.first()
        assertEquals("phone", effectiveLayout(pro, 412f).id)
        assertEquals("pro", effectiveLayout(pro, 1280f).id)
        val s = DemoPacks.solve(DemoPacks.phone, 412.0, 800.0, NativePanels)
        assertTrue(s.docked.isEmpty() || s.docked == listOf(PanelId.Library), "${s.docked}")
    }

    @Test fun layoutJsonIsTheCanonicalShape() {
        val stage = DemoPacks.presets.first { it.id == "stage" }
        assertEquals(
            """{"v":1,"id":"stage","name":"Stage","columns":[5,2,5],"rows":[9,2],"areas":[{"panel":"deckA","col":0,"row":0,"rowSpan":2},""" +
                """{"panel":"mixer","col":1,"row":0},{"panel":"crossfader","col":1,"row":1},{"panel":"deckB","col":2,"row":0,"rowSpan":2}]}""",
            stage.toJson(),
        )
    }
}
