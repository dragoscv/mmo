package ro.mixai.decks.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import ro.mixai.decks.ui.Scenes.click
import ro.mixai.decks.ui.Scenes.description
import ro.mixai.decks.ui.Scenes.isInside
import ro.mixai.decks.ui.Scenes.nodes
import ro.mixai.decks.ui.Scenes.one
import ro.mixai.decks.ui.Scenes.settle
import ro.mixai.decks.ui.Scenes.tagged
import ro.mixai.decks.ui.Scenes.testTag
import ro.mixai.decks.ui.Scenes.windowRect
import ro.mixai.decks.ui.components.MORE_SHEET_MARGIN_DP
import ro.mixai.decks.ui.components.MORE_SHEET_W_DP
import ro.mixai.decks.ui.components.sheetWidthDp
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.screens.DeckPanel
import ro.mixai.decks.ui.screens.DeckTab
import ro.mixai.decks.ui.screens.DeckTags
import ro.mixai.decks.ui.screens.MixerPanel
import ro.mixai.decks.ui.screens.MixerTags
import ro.mixai.decks.ui.screens.SHEET_TRANSPORT_TOUCH_H
import ro.mixai.decks.ui.theme.LocalTouchInput

/**
 * The MORE sheets on a phone. A phone window is 320 to 412 dp wide, narrower than the 416 dp the deck's sheet takes
 * on a desktop window: there the sheet is the window minus a margin, its rows wrap, and it scrolls when it is
 * higher than the window. Rendered in 360×640 and 320×568 dp windows, Romanian and English: every control of the
 * sheet lies inside the window with the margin, none is smaller than its target size, none overlaps another, and
 * no label is cut.
 */
class MoreSheetWindowTest {
    private class Case(val name: String, val boxW: Int, val boxH: Int, val sheetTag: String, val closeTag: String, val content: @Composable (Modifier) -> Unit)

    /** Deck B with a key shift (the longest key chip) and a tempo off zero; the icon deck sits at its contract minimum. */
    private fun cases(ctl: DecksController, windowW: Int): List<Case> = buildList {
        for (tab in DeckTab.entries) {
            add(Case("deck icon, $tab tab", 220, 110, DeckTags.SHEET, DeckTags.CLOSE) { m -> DeckPanel(ctl, 1, m, PanelTier.Icon, initialTab = tab, initialMore = true) })
            // A compact deck is 340 dp wide or more: it exists on a 360 dp window, not on a 320 dp one.
            if (windowW >= 348) add(Case("deck compact, $tab tab", 340, 190, DeckTags.SHEET, DeckTags.CLOSE) { m -> DeckPanel(ctl, 1, m, PanelTier.Compact, initialTab = tab, initialMore = true) })
        }
        add(Case("mixer icon", 150, 110, MixerTags.SHEET, MixerTags.CLOSE) { m -> MixerPanel(ctl, m, PanelTier.Icon, initialMore = true) })
        add(Case("mixer compact", 200, 190, MixerTags.SHEET, MixerTags.CLOSE) { m -> MixerPanel(ctl, m, PanelTier.Compact, initialMore = true) })
    }

    private fun controller(): DecksController {
        val ctl = Scenes.controller()
        ctl.shiftKey(1, 2.0)
        ctl.setTempoFader(1, -1f)
        ctl.tick()
        return ctl
    }

    private fun overlaps(a: Rect, b: Rect): Boolean = a.left < b.right - 0.5f && b.left < a.right - 0.5f && a.top < b.bottom - 0.5f && b.top < a.bottom - 0.5f

    /** The tagged leaves of the sheet (controls and readouts), not the sheet itself. */
    private fun sheetItems(nodes: List<SemanticsNode>, sheetTag: String): List<SemanticsNode> =
        nodes.filter { it.testTag() != null && it.testTag() != sheetTag && it.isInside(sheetTag) }

    @Test fun onAPhoneWindowEveryControlOfASheetIsInsideTheWindowWholeAndApart() {
        val ctl = controller()
        val bad = ArrayList<String>()
        var sheets = 0
        for ((windowW, windowH) in listOf(360 to 640, 320 to 568)) for (lang in listOf("ro", "en")) for (c in cases(ctl, windowW)) {
            val where = "${windowW}x$windowH $lang: MORE of ${c.name}"
            val problems = ArrayList<String>()
            // The panel sits at the right edge, half way down: where a phone layout has deck B and the mixer.
            val scene = Scenes.scene(windowW, windowH, c.boxW, c.boxH, x = windowW - c.boxW - 4, y = 300, lang = lang, fit = { problems += it }, content = c.content)
            try {
                val nodes = scene.settle().nodes()
                sheets++
                if (problems.isNotEmpty()) bad += "$where: cut or squeezed: $problems"
                val sheet = nodes.one(c.sheetTag).windowRect()
                val margin = MORE_SHEET_MARGIN_DP.toFloat()
                // The sheet's content is 8 dp inside the sheet's outline; the outline keeps the margin to the window.
                if (sheet.left - 8f < margin - 0.5f || sheet.right + 8f > windowW - margin + 0.5f) bad += "$where: sheet $sheet leaves no ${MORE_SHEET_MARGIN_DP} dp margin in a $windowW dp window"
                if (sheet.top - 8f < margin - 0.5f || sheet.bottom + 8f > windowH - margin + 0.5f) bad += "$where: sheet $sheet is not inside the window height $windowH"
                val items = sheetItems(nodes, c.sheetTag)
                if (items.size < 10) bad += "$where: only ${items.size} controls found in the sheet"
                if (items.none { it.testTag() == c.closeTag }) bad += "$where: no close button"
                for (n in items) {
                    val r = n.windowRect()
                    if (r.left < margin - 0.5f || r.right > windowW - margin + 0.5f || r.top < margin - 0.5f || r.bottom > windowH - margin + 0.5f) {
                        bad += "$where: ${n.testTag()} at $r is outside the window"
                    }
                    // Readouts (key chip, MASTER, BPM) are 15 to 18 dp high by design; everything else is a 24 dp target.
                    val readout = n.testTag() in DeckTags.READOUTS
                    if (!readout && (r.width < 23.5f || r.height < 23.5f)) bad += "$where: ${n.testTag()} is ${r.width}x${r.height}, under the 24 dp target"
                    if (readout && (r.width < 8f || r.height < 12f)) bad += "$where: readout ${n.testTag()} is ${r.width}x${r.height}"
                }
                for (i in items.indices) for (j in i + 1 until items.size) {
                    val a = items[i]
                    val b = items[j]
                    if (a.isInside(b.testTag()!!) || b.isInside(a.testTag()!!)) continue
                    if (overlaps(a.windowRect(), b.windowRect())) bad += "$where: ${a.testTag()} ${a.windowRect()} overlaps ${b.testTag()} ${b.windowRect()}"
                }
            } finally {
                scene.close()
            }
        }
        assertEquals(2 * (6 + 4), sheets, "sheets rendered: 6 on the 360 dp window, 4 on the 320 dp one, in two languages")
        assertTrue(bad.isEmpty(), "${bad.size} problems in $sheets sheets:\n" + bad.joinToString("\n"))
    }

    private fun SemanticsNode.state(): String? = config.getOrNull(SemanticsProperties.StateDescription)

    /** The one node tagged [tag] inside the deck's sheet, and the one outside it (the panel's own). */
    private fun inAndOut(nodes: List<SemanticsNode>, tag: String, where: String): Pair<SemanticsNode, SemanticsNode> {
        val (inside, outside) = nodes.tagged(tag).partition { it.isInside(DeckTags.SHEET) }
        assertEquals(1, inside.size, "$where: one '$tag' inside the MORE sheet")
        assertEquals(1, outside.size, "$where: one '$tag' in the panel")
        return inside[0] to outside[0]
    }

    @Test fun theSheetOfAnIconDeckCarriesItsOwnCueAndPlay() {
        // The reviewed bug: the sheet of an icon deck opens over that deck's own CUE / PLAY and a tap outside the
        // sheet only closes it, so stopping the deck took two taps. The sheet now starts with a CUE and a PLAY.
        // The deck sits at the top of the window (deck B of a phone layout): no room above, the sheet opens below
        // the header, over the transport row.
        for ((windowW, windowH) in listOf(360 to 640, 320 to 568)) for (lang in listOf("ro", "en")) {
            val where = "${windowW}x$windowH $lang"
            val ctl = controller()
            val problems = ArrayList<String>()
            val scene = Scenes.scene(windowW, windowH, 220, 110, x = windowW - 224, y = 20, lang = lang, fit = { problems += it }) { m ->
                DeckPanel(ctl, 1, m, PanelTier.Icon, initialMore = true)
            }
            try {
                var nodes = scene.settle().nodes()
                val sheet = nodes.one(DeckTags.SHEET).windowRect()
                val (play, panelPlay) = inAndOut(nodes, DeckTags.PLAY, where)
                val (cue, panelCue) = inAndOut(nodes, DeckTags.CUE, where)
                // Why they are needed: the open sheet lies over the panel's own transport row.
                assertTrue(overlaps(sheet, panelPlay.windowRect()) && overlaps(sheet, panelCue.windowRect()), "$where: the sheet $sheet covers the deck's own CUE / PLAY")
                // The same controls: name, state and role of the panel's own.
                assertEquals(panelPlay.description(), play.description(), "$where: PLAY is named like the panel's")
                assertEquals(panelCue.description(), cue.description(), "$where: CUE is named like the panel's")
                assertEquals(panelPlay.state(), play.state())
                assertEquals(panelPlay.config.getOrNull(SemanticsProperties.Role), play.config.getOrNull(SemanticsProperties.Role))
                // First in the sheet: nothing of the sheet is above them, CUE is left of PLAY, and they do not touch.
                val items = sheetItems(nodes, DeckTags.SHEET)
                val top = items.minOf { it.windowRect().top }
                assertTrue(play.windowRect().top <= top + 0.5f && cue.windowRect().top <= top + 0.5f, "$where: CUE and PLAY are the first row of the sheet")
                assertTrue(cue.windowRect().right <= play.windowRect().left, "$where: CUE is left of PLAY")
                for (n in listOf(cue, play)) {
                    val r = n.windowRect()
                    assertTrue(r.width >= 47.5f && r.height >= 23.5f, "$where: ${n.testTag()} is ${r.width}x${r.height}")
                    assertTrue(r.left >= MORE_SHEET_MARGIN_DP - 0.5f && r.right <= windowW - MORE_SHEET_MARGIN_DP + 0.5f, "$where: ${n.testTag()} at $r is inside the window")
                }
                assertTrue(problems.isEmpty(), "$where: cut or squeezed: $problems")
                // They work: PLAY in the sheet starts deck B, and the button says so.
                assertEquals(false, ctl.deck(1)!!.playing)
                assertTrue(play.click(), "$where: the sheet's PLAY has a click action")
                ctl.tick()
                assertEquals(true, ctl.deck(1)!!.playing, "$where: the sheet's PLAY started deck B")
                assertEquals(false, ctl.deck(0)!!.playing, "$where: deck A was not touched")
                Snapshot.sendApplyNotifications()
                scene.render(2 * 16_666_667L)
                scene.render(3 * 16_666_667L)
                nodes = scene.nodes()
                val on = if (lang == "ro") "pornit" else "on"
                val pause = if (lang == "ro") "Pauză Deck B" else "Pause Deck B"
                val (playing, panelPlaying) = inAndOut(nodes, DeckTags.PLAY, where)
                assertEquals(listOf(on, on), listOf(playing.state(), panelPlaying.state()), "$where: both PLAY buttons read on")
                assertEquals(pause, playing.description(), "$where: the sheet's PLAY is now the pause button")
                // One tap stops the deck while the sheet is open: CUE in the sheet (back to the cue point, stopped).
                assertTrue(inAndOut(nodes, DeckTags.CUE, where).first.click(), "$where: the sheet's CUE has a click action")
                ctl.tick()
                assertEquals(false, ctl.deck(1)!!.playing, "$where: the sheet's CUE stopped deck B")
                // And PLAY toggles: on, then off again.
                assertTrue(playing.click())
                ctl.tick()
                assertEquals(true, ctl.deck(1)!!.playing)
                assertTrue(playing.click())
                ctl.tick()
                assertEquals(false, ctl.deck(1)!!.playing, "$where: a second press of the sheet's PLAY pauses")
            } finally {
                scene.close()
            }
        }
        // A sheet opened from the transport row (compact deck) opens beside its own row: it has no second transport.
        val ctl = controller()
        val compact = Scenes.scene(360, 640, 340, 190, x = 16, y = 300) { m -> DeckPanel(ctl, 1, m, PanelTier.Compact, initialMore = true) }
        try {
            val nodes = compact.settle().nodes()
            assertTrue(nodes.one(DeckTags.SYNC_LOCK).isInside(DeckTags.SHEET), "the compact deck's sheet is open")
            assertEquals(listOf(false), nodes.tagged(DeckTags.PLAY).map { it.isInside(DeckTags.SHEET) }, "compact: PLAY only in the panel")
            assertEquals(listOf(false), nodes.tagged(DeckTags.CUE).map { it.isInside(DeckTags.SHEET) }, "compact: CUE only in the panel")
        } finally {
            compact.close()
        }
        // Touch input: the two buttons of the sheet are 48 dp high, and the sheet still fits a 320 dp window.
        val touch = Scenes.scene(320, 568, 220, 110, x = 96, y = 20, lang = "ro") { m ->
            CompositionLocalProvider(LocalTouchInput provides true) { DeckPanel(ctl, 1, m, PanelTier.Icon, initialMore = true) }
        }
        try {
            val nodes = touch.settle().nodes()
            for (tag in listOf(DeckTags.CUE, DeckTags.PLAY)) {
                val r = inAndOut(nodes, tag, "touch").first.windowRect()
                assertEquals(SHEET_TRANSPORT_TOUCH_H.toFloat(), r.height, "touch: $tag in the sheet is 48 dp high")
                assertTrue(r.width >= 48f && r.left >= MORE_SHEET_MARGIN_DP - 0.5f && r.right <= 320 - MORE_SHEET_MARGIN_DP + 0.5f, "touch: $tag at $r")
            }
        } finally {
            touch.close()
        }
    }

    @Test fun theDeckSheetHasSyncAndTheKeyWhenTheIconDeckHasNone() {
        // The reviewed bug: an icon deck at 220×110 had no SYNC tap anywhere (its sheet had the lock toggle only).
        val ctl = controller()
        val scene = Scenes.scene(360, 640, 220, 110, x = 136, y = 300, lang = "ro") { m -> DeckPanel(ctl, 1, m, PanelTier.Icon, initialMore = true) }
        try {
            val nodes = scene.settle().nodes()
            val sync = nodes.one(DeckTags.SYNC)
            assertTrue(sync.isInside(DeckTags.SHEET), "SYNC is in the sheet")
            assertTrue(nodes.one(DeckTags.KEY).isInside(DeckTags.SHEET), "the key chip is in the sheet")
            assertTrue(nodes.one(DeckTags.SEEK).isInside(DeckTags.SHEET), "the seek strip is in the sheet")
            // It is the real control: activating it syncs deck B to deck A's tempo (126 → 124 BPM).
            val before = ctl.deck(1)!!.effectiveBpm!!
            assertTrue(sync.config.getOrNull(SemanticsActions.OnClick)?.action?.invoke() == true, "SYNC has a click action")
            ctl.tick()
            val after = ctl.deck(1)!!.effectiveBpm!!
            assertTrue(before != after && kotlin.math.abs(after - 124.0) < 1e-6, "deck B follows deck A after SYNC: $before → $after")
        } finally {
            scene.close()
        }
    }

    @Test fun onADesktopWindowTheSheetKeepsItsWidth() {
        assertEquals(416.0, sheetWidthDp(MORE_SHEET_W_DP, 1366.0))
        assertEquals(344.0, sheetWidthDp(MORE_SHEET_W_DP, 360.0), "a 360 dp phone: the window minus 8 dp on each side")
        assertEquals(304.0, sheetWidthDp(MORE_SHEET_W_DP, 320.0))
        assertEquals(416.0, sheetWidthDp(MORE_SHEET_W_DP, null), "window size unknown: the preferred width")
        assertEquals(0.0, sheetWidthDp(MORE_SHEET_W_DP, 10.0), "never negative")
        val ctl = controller()
        val scene = Scenes.scene(1366, 768, 340, 190, x = 500, y = 400) { m -> DeckPanel(ctl, 0, m, PanelTier.Compact, initialMore = true) }
        try {
            val sheet = scene.settle().nodes().one(DeckTags.SHEET).windowRect()
            assertEquals(400f, sheet.width, "400 dp of controls inside a 416 dp sheet")
        } finally {
            scene.close()
        }
    }

    @Test fun aSheetHigherThanTheWindowScrolls() {
        // A landscape phone / a split-screen window: 360×200 dp. The icon deck's sheet is about 280 dp high.
        val ctl = controller()
        val scene = Scenes.scene(360, 200, 220, 110, x = 136, y = 80, lang = "ro") { m -> DeckPanel(ctl, 1, m, PanelTier.Icon, initialMore = true) }
        try {
            var nodes = scene.settle().nodes()
            val scroller = nodes.firstOrNull { it.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange) != null && it.children.any { c -> c.testTag() == DeckTags.SHEET } }
                ?: error("the sheet has no vertical scroll container")
            val range = scroller.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange)!!
            assertTrue(range.maxValue() > 0f, "the sheet is higher than its view: scroll range ${range.maxValue()}")
            val view = scroller.windowRect()
            assertTrue(view.top >= MORE_SHEET_MARGIN_DP - 0.5f && view.bottom <= 200 - MORE_SHEET_MARGIN_DP + 0.5f, "the sheet's view $view is inside the 200 dp window")
            assertTrue(nodes.one(DeckTags.CLOSE).windowRect().bottom > view.bottom, "the close button starts below the view")
            // Scroll to the end (the action animates: give it frames) and the last control is in view.
            assertTrue(scroller.config.getOrNull(SemanticsActions.ScrollBy)?.action?.invoke(0f, range.maxValue()) == true, "the sheet scrolls")
            var t = 16_666_667L
            repeat(240) {
                t += 16_666_667L
                scene.render(t)
            }
            nodes = scene.nodes()
            val close = nodes.one(DeckTags.CLOSE).windowRect()
            assertTrue(close.top >= view.top - 0.5f && close.bottom <= view.bottom + 0.5f, "after scrolling, the close button $close is inside the view $view")
        } finally {
            scene.close()
        }
    }
}
