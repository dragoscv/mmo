package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.screens.NativePanels
import ro.mixai.decks.ui.screens.effectiveLayout

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
        // Same numbers as the "minimum" block of the golden fixtures.
        val want = mapOf("classic" to (674.0 to 360.0), "performance" to (674.0 to 306.0), "library" to (674.0 to 449.0),
            "four-deck" to (1093.0 to 342.0), "ultrawide" to (1048.0 to 324.0), "stage" to (924.0 to 210.0))
        for (l in DemoPacks.presets) assertEquals(want.getValue(l.id), DemoPacks.minimumSize(l), l.id)
    }

    @Test fun phonesGetThePhoneLayoutWithFullDecksAtTabletSize() {
        val classic = DemoPacks.presets.first()
        assertEquals("phone", effectiveLayout(classic, 412f).id)
        assertEquals("classic", effectiveLayout(classic, 1280f).id)
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
