package ro.mixai.decks.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import ro.mixai.decks.ui.Scenes.click
import ro.mixai.decks.ui.Scenes.isInside
import ro.mixai.decks.ui.Scenes.nodes
import ro.mixai.decks.ui.Scenes.one
import ro.mixai.decks.ui.Scenes.settle
import ro.mixai.decks.ui.Scenes.testTag
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.screens.CrossfaderPanel
import ro.mixai.decks.ui.screens.DeckPanel
import ro.mixai.decks.ui.screens.DeckTab
import ro.mixai.decks.ui.screens.DeckTags
import ro.mixai.decks.ui.screens.LibraryPanel
import ro.mixai.decks.ui.screens.LibraryTags
import ro.mixai.decks.ui.screens.MixerPanel
import ro.mixai.decks.ui.screens.MixerTags

/**
 * "Nothing is removed": a smaller arrangement moves controls behind MORE, it never drops them. This test RENDERS
 * every panel at the contract minimum of each tier (and in a few boxes the layouts really give), opens the MORE
 * sheet, and looks every control of the full panel up by its test tag in the panel or in the sheet. A control
 * that is in neither fails the test by name. The same pass writes build/control-presence.txt: where each control
 * of each arrangement is (panel / sheet / both).
 *
 * The deck's HOT CUE and LOOP tabs share one area, so a deck is rendered once per tab and the two are merged: a
 * control behind the other tab is one tap away, a control in neither is missing.
 */
class ControlPresenceTest {
    private class Found(val panel: Set<String>, val sheet: Set<String>) {
        val all: Set<String> get() = panel + sheet
        fun where(tag: String): String = when {
            tag in panel && tag in sheet -> "panel + sheet"
            tag in panel -> "panel"
            tag in sheet -> "sheet"
            else -> "MISSING"
        }
    }

    /** Tags of [content] in a [w] × [h] dp box, split by the sheet they are in (null = the panel has no sheet tag). */
    private fun found(w: Int, h: Int, sheetTag: String?, lang: String = "en", content: @Composable (Modifier) -> Unit): Found {
        val problems = ArrayList<String>()
        // The panel sits low in the window: a MORE sheet opens above it.
        val windowW = maxOf(640, w + 40)
        val scene = Scenes.scene(windowW, 720, w, h, x = (windowW - w) / 2, y = 380, lang = lang, fit = { problems += it }, content = content)
        try {
            val nodes = scene.settle().nodes()
            val panel = HashSet<String>()
            val sheet = HashSet<String>()
            for (n in nodes) {
                val tag = n.testTag() ?: continue
                if (sheetTag != null && (tag == sheetTag || n.isInside(sheetTag))) sheet += tag else panel += tag
            }
            assertTrue(problems.isEmpty(), "a ${w}x$h box ($lang) cuts something: $problems")
            return Found(panel, sheet)
        } finally {
            scene.close()
        }
    }

    private fun merge(a: Found, b: Found) = Found(a.panel + b.panel, a.sheet + b.sheet)

    private fun deck(tier: PanelTier, w: Int, h: Int, lang: String = "en"): Found {
        val ctl = Scenes.controller()
        return DeckTab.entries.map { tab -> found(w, h, DeckTags.SHEET, lang) { m -> DeckPanel(ctl, 0, m, tier, initialTab = tab, initialMore = true) } }.reduce(::merge)
    }

    private fun minimum(id: PanelId, tier: PanelTier): Pair<Int, Int> = DemoPacks.specs.getValue(id).min(tier).let { it.first.toInt() to it.second.toInt() }

    private val report = StringBuilder()

    /** Writes where each of [expected] is into the report and fails when one is in neither the panel nor the sheet. */
    private fun audit(name: String, f: Found, expected: List<String>) {
        report.append("\n## $name\n")
        for (tag in expected) report.append("$tag: ${f.where(tag)}\n")
        val missing = expected.filter { it !in f.all }
        assertTrue(missing.isEmpty(), "$name: in neither the panel nor its MORE sheet: $missing")
    }

    @Test fun everyDeckControlIsInThePanelOrItsMoreSheetAtEveryTier() {
        val expected = DeckTags.CONTROLS + DeckTags.READOUTS
        assertEquals(45, DeckTags.CONTROLS.size, "the audited control list: 29 controls, 8 pads, 8 loop sizes")
        for (lang in listOf("en", "ro")) for (tier in PanelTier.entries) {
            val (w, h) = minimum(PanelId.DeckA, tier)
            val f = deck(tier, w, h, lang)
            audit("deck $tier ${w}x$h $lang", f, expected)
            when (tier) {
                // The full deck has no sheet: everything is in the panel (and the two readouts only it has).
                PanelTier.Full -> {
                    assertTrue(f.sheet.isEmpty() && DeckTags.MORE !in f.panel, "a full deck has no MORE: ${f.sheet}")
                    assertTrue(DeckTags.ELAPSED in f.panel, "elapsed time on the full deck")
                }
                PanelTier.Compact -> {
                    assertTrue(DeckTags.SYNC in f.panel && DeckTags.KEY in f.panel && DeckTags.MASTER in f.sheet, "compact: ${f.panel}")
                    // Its MORE is in the transport row: the sheet opens beside that row and repeats no transport.
                    assertTrue(DeckTags.PLAY !in f.sheet && DeckTags.CUE !in f.sheet, "compact: no second CUE / PLAY in the sheet: ${f.sheet}")
                }
                // The icon minimum has CUE and PLAY only: SYNC, the key chip and the seek strip must be in the sheet.
                PanelTier.Icon -> {
                    assertTrue(DeckTags.SYNC !in f.panel && DeckTags.SYNC in f.sheet, "icon minimum: SYNC is in the sheet")
                    assertTrue(DeckTags.KEY !in f.panel && DeckTags.KEY in f.sheet, "icon minimum: the key chip is in the sheet")
                    assertTrue(DeckTags.SEEK !in f.panel && DeckTags.SEEK in f.sheet, "icon minimum: the seek strip is in the sheet")
                    assertTrue(DeckTags.PLAY in f.panel && DeckTags.CUE in f.panel && DeckTags.REMAIN in f.panel && DeckTags.BPM in f.panel)
                    // Its MORE is in the header: the open sheet covers the transport row, so the sheet has CUE and PLAY too.
                    assertEquals("panel + sheet", f.where(DeckTags.PLAY), "icon minimum $lang: PLAY is also in the sheet")
                    assertEquals("panel + sheet", f.where(DeckTags.CUE), "icon minimum $lang: CUE is also in the sheet")
                }
            }
        }
        // Boxes the layouts really give: Pro on a 1366×768 window (compact tier, wide: no MORE at all), the phone
        // layout (icon tier by width, tall: SYNC and the overview are in the panel), and a box under the icon minimum.
        val laptop = deck(PanelTier.Compact, 552, 239)
        audit("deck Compact 552x239 (Pro on a laptop)", laptop, expected)
        assertTrue(laptop.sheet.isEmpty() && DeckTags.MASTER in laptop.panel, "everything inline, MASTER included")
        val phone = deck(PanelTier.Icon, 228, 298)
        audit("deck Icon 228x298 (phone layout)", phone, expected)
        assertTrue(DeckTags.SYNC in phone.panel && DeckTags.SYNC !in phone.sheet, "the phone deck has SYNC in its transport row, once")
        assertTrue(DeckTags.PLAY in phone.sheet && DeckTags.CUE in phone.sheet, "the phone deck's sheet (MORE in the header) has CUE and PLAY: ${phone.sheet}")
        val forced = deck(PanelTier.Icon, 220, 90)
        audit("deck Icon 220x90 (under the icon minimum)", forced, expected)
        assertTrue(DeckTags.PLAY in forced.sheet && DeckTags.CUE in forced.sheet, "so has the sheet of a deck under the icon minimum: ${forced.sheet}")
        File("build").mkdirs()
        File("build/control-presence-deck.txt").writeText(report.toString())
    }

    @Test fun aDeckUnderTheIconMinimumShowsTheRemainingTimeFirst() {
        // No room for a readout row. 220 dp wide: the header line holds the BPM and the remaining time.
        val both = deck(PanelTier.Icon, 220, 90)
        assertTrue(DeckTags.REMAIN in both.panel && DeckTags.BPM in both.panel, "both readouts in the header: ${both.panel}")
        // 190 dp wide: only one fits beside a 40 dp title: the remaining time stays, the BPM is in the sheet.
        val one = deck(PanelTier.Icon, 190, 90)
        assertTrue(DeckTags.REMAIN in one.panel, "the remaining time stays in the panel: ${one.panel}")
        assertTrue(DeckTags.BPM !in one.panel && DeckTags.BPM in one.sheet, "the BPM moved to the sheet: panel ${one.panel}")
    }

    @Test fun theLoopInAndOutButtonsSetAManualLoop() {
        val ctl = Scenes.controller()
        val scene = Scenes.scene(640, 400, 480, 250, 20, 20) { m -> DeckPanel(ctl, 0, m, PanelTier.Full, initialTab = DeckTab.Loops) }
        try {
            val nodes = scene.settle().nodes()
            ctl.backend.seek(0, 30.0)
            assertTrue(nodes.one(DeckTags.LOOP_IN).click(), "IN has a click action")
            ctl.backend.seek(0, 38.0)
            assertTrue(nodes.one(DeckTags.LOOP_OUT).click(), "OUT has a click action")
            ctl.tick()
            val d = ctl.deck(0)!!
            assertTrue(d.loopActive && d.loopStartSec == 30.0 && d.loopEndSec == 38.0, "IN at 30 s, OUT at 38 s: $d")
        } finally {
            scene.close()
        }
    }

    @Test fun everyMixerControlIsInThePanelOrItsMoreSheetAtEveryTier() {
        val ctl = Scenes.controller()
        for (tier in PanelTier.entries) {
            val (w, h) = minimum(PanelId.Mixer, tier)
            val f = found(w, h, MixerTags.SHEET) { m -> MixerPanel(ctl, m, tier, initialMore = true) }
            audit("mixer $tier ${w}x$h", f, MixerTags.CONTROLS)
            if (tier == PanelTier.Full) assertTrue(f.sheet.isEmpty(), "a full mixer has no MORE: ${f.sheet}")
            else assertTrue(MixerTags.MORE in f.panel && MixerTags.CLOSE in f.sheet, "$tier mixer: the sheet is open")
            // The layout without a crossfader area: the fader is a row of the mixer.
            val withRow = found(w, h, MixerTags.SHEET) { m -> MixerPanel(ctl, m, tier, withCrossfader = true, initialMore = true) }
            audit("mixer with crossfader row $tier ${w}x$h", withRow, MixerTags.CONTROLS + MixerTags.CROSSFADER)
            val (cw, ch) = minimum(PanelId.Crossfader, tier)
            audit("crossfader $tier ${cw}x$ch", found(cw, ch, null) { m -> CrossfaderPanel(ctl, m, tier) }, listOf(MixerTags.CROSSFADER))
        }
        File("build").mkdirs()
        File("build/control-presence-mixer.txt").writeText(report.toString())
    }

    @Test fun everyLibraryControlIsInTheToolbarAtEveryTier() {
        val ctl = Scenes.controller()
        for (lang in listOf("en", "ro")) for (tier in PanelTier.entries) {
            val (w, h) = minimum(PanelId.Library, tier)
            val f = found(w, h, null, lang) { m -> LibraryPanel(ctl, {}, m, tier) }
            audit("library $tier ${w}x$h $lang", f, LibraryTags.CONTROLS)
            assertTrue(LibraryTags.ROW in f.panel, "$tier library shows rows")
            // The load cells inside the rows are a pointer shortcut of the two toolbar buttons; the icon tier has no load column.
            assertEquals(tier != PanelTier.Icon, LibraryTags.ROW_LOAD_A in f.panel, "$tier: load cells in the rows")
        }
        // From 900 dp the crate list is a column: its rows replace the two crate steps.
        val wide = found(960, 300, null) { m -> LibraryPanel(ctl, {}, m, PanelTier.Full) }
        audit("library Full 960x300 (crate column)", wide, LibraryTags.CONTROLS - setOf(LibraryTags.CRATE_PREV, LibraryTags.CRATE_NEXT) + LibraryTags.CRATE)
        assertTrue(LibraryTags.CRATE_PREV !in wide.panel, "the column replaces the stepper")
        // Without a folder picker (a platform that has none) there is no scan button; everything else stays.
        val noScan = found(200, 96, null) { m -> LibraryPanel(ctl, null, m, PanelTier.Icon) }
        assertTrue(LibraryTags.SCAN !in noScan.panel && LibraryTags.CRATE_NEXT in noScan.panel)
        File("build").mkdirs()
        File("build/control-presence-library.txt").writeText(report.toString())
    }
}
