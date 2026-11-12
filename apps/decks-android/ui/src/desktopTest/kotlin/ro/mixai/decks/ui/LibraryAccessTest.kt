package ro.mixai.decks.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.InternalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import ro.mixai.decks.ui.Scenes.description
import ro.mixai.decks.ui.Scenes.nodes
import ro.mixai.decks.ui.Scenes.one
import ro.mixai.decks.ui.Scenes.settle
import ro.mixai.decks.ui.Scenes.tagged
import ro.mixai.decks.ui.Scenes.windowRect
import ro.mixai.decks.ui.components.isActivateKey
import ro.mixai.decks.ui.components.isDpadCenter
import ro.mixai.decks.ui.engine.DecksBackend
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.model.TrackRow
import ro.mixai.decks.ui.screens.DeckPanel
import ro.mixai.decks.ui.screens.DeckTags
import ro.mixai.decks.ui.screens.DecksScreen
import ro.mixai.decks.ui.screens.LIB_ROW_DP
import ro.mixai.decks.ui.screens.LIB_ROW_TOUCH_DP
import ro.mixai.decks.ui.screens.LibraryPanel
import ro.mixai.decks.ui.screens.LibraryTags
import ro.mixai.decks.ui.screens.libRowDp
import ro.mixai.decks.ui.screens.libraryRows
import ro.mixai.decks.ui.theme.LocalTouchInput

/**
 * The library for people who do not use a mouse: what assistive tech hears of a row, how big the targets are on
 * touch input, and that a D-pad's centre key activates. (Keyboard: the list is one focus stop and the arrows move
 * the selection inside it; the screen's shortcut map uses Up / Down for the library everywhere, so the rows are
 * not focus stops of their own.)
 */
class LibraryAccessTest {
    private fun SemanticsNode.state(): String? = config.getOrNull(SemanticsProperties.StateDescription)
    private fun SemanticsNode.selected(): Boolean? = config.getOrNull(SemanticsProperties.Selected)

    /** The demo engine with [n] tracks in its library (the built-in demo has four: fewer than any list shows). */
    private class BigLibrary(private val base: DemoBackend, n: Int) : DecksBackend by base {
        private val rows = List(n) { i -> TrackRow("big-$i", "demo://big/$i", "Track ${i + 1}", "MixAI", 120.0 + i % 9, "${i % 12 + 1}A", 200.0 + i) }
        override fun search(query: String, limit: Int): List<TrackRow> = rows.take(limit)
    }

    @Test fun theListShowsExactlyTheRowsThePureFunctionCounts() {
        // "Zero scroll" is proven on `libraryRows` (PanelFitTest): this is the proof that the PANEL shows that many
        // rows. 60 tracks (more than any box here holds), every tier, several heights, pointer and touch rows.
        val ctl = DecksController(BigLibrary(DemoBackend { 0.0 }, 60))
        ctl.startEngine()
        ctl.tick()
        assertEquals(60, ctl.results.size, "the library has 60 tracks")
        val boxes = listOf(
            Triple(PanelTier.Full, 560, listOf(240, 251, 322, 400)),
            Triple(PanelTier.Compact, 320, listOf(160, 199, 236)),
            Triple(PanelTier.Icon, 200, listOf(96, 130, 158)),
        )
        val seen = LinkedHashMap<String, Int>()
        for (touch in listOf(false, true)) for ((tier, w, heights) in boxes) for (h in heights) {
            val rowDp = libRowDp(touch)
            val want = libraryRows(tier, h.toDouble(), rowDp)
            val where = "$tier ${w}x$h ${if (touch) "touch" else "pointer"}"
            val scene = Scenes.scene(w + 40, h + 40, w, h, 20, 20) { m -> LibraryPanel(ctl, {}, m, tier, touch = touch) }
            try {
                val rows = scene.settle().nodes().tagged(LibraryTags.ROW).map { it.windowRect() }
                assertEquals(want, rows.size, "$where: the panel shows the rows libraryRows() counts")
                assertTrue(want in 1..59, "$where: the box holds some rows and not the whole list: $want")
                assertTrue(rows.all { it.height == rowDp.toFloat() }, "$where: every row is $rowDp dp high: ${rows.map { it.height }}")
                // Whole rows only, and as many as fit: the last one ends inside the panel with less than a row left under it.
                val bottom = 20f + h
                val last = rows.maxOf { it.bottom }
                assertTrue(last <= bottom + 0.5f, "$where: the last row ends at $last, the panel at $bottom")
                assertTrue(bottom - last < rowDp, "$where: ${bottom - last} dp are left under the last row: room for another $rowDp dp row")
            } finally {
                scene.close()
            }
            seen[where] = want
        }
        assertEquals(20, seen.size, "boxes rendered")
        assertEquals(
            listOf(8, 9, 12, 16, 5, 6, 8, 3, 4, 6, 4, 4, 5, 7, 2, 3, 3, 1, 2, 2), seen.values.toList(),
            "the row counts of these boxes (pointer: 22 dp rows, touch: 48 dp rows): $seen",
        )
    }

    @Test fun aRowSaysWhereItIsWhatItIsDoingAndOffersBothLoads() {
        val ctl = Scenes.controller() // deck A holds track 0, deck B track 1
        val played = setOf(DemoBackend.DEMO_TRACKS[2].id)
        val scene = Scenes.scene(600, 300, 560, 240, 20, 20) { m -> LibraryPanel(ctl, {}, m, PanelTier.Full, initialPlayed = played) }
        try {
            val nodes = scene.settle().nodes()
            val list = nodes.one(LibraryTags.LIST)
            assertEquals(4, list.config.getOrNull(SemanticsProperties.CollectionInfo)?.rowCount, "the list says how many tracks it has")
            val rows = nodes.tagged(LibraryTags.ROW)
            assertEquals(4, rows.size, "four demo tracks, four rows")
            rows.forEachIndexed { i, row ->
                val info = row.config.getOrNull(SemanticsProperties.CollectionItemInfo) ?: error("row $i has no position")
                assertEquals(i, info.rowIndex, "row $i knows its position")
                assertEquals(i == 0, row.selected(), "only the selected row says selected")
                assertTrue(DemoBackend.DEMO_TRACKS[i].title in row.description(), "row $i is named by its track: ${row.description()}")
                val actions = row.config.getOrNull(SemanticsActions.CustomActions).orEmpty()
                assertEquals(listOf("Load to deck A", "Load to deck B"), actions.map { it.label }, "row $i offers both loads as actions")
            }
            assertEquals("on Deck A", rows[0].state())
            assertEquals("on Deck B", rows[1].state())
            assertEquals("played", rows[2].state())
            assertEquals(null, rows[3].state(), "a row with nothing to say has no state")
            // The action does what it says: "Load to deck B" on the third row.
            val loadB = rows[2].config.getOrNull(SemanticsActions.CustomActions)!![1]
            assertTrue(loadB.action())
            repeat(8) { ctl.tick() }
            assertEquals(DemoBackend.DEMO_TRACKS[2].title, ctl.deck(1)!!.title)
            // Activating a row selects it (it does not load: loading is an explicit action).
            assertTrue(rows[3].config.getOrNull(SemanticsActions.OnClick)?.action?.invoke() == true)
            assertEquals(3, ctl.selectedRow)
        } finally {
            scene.close()
        }
        // Romanian: the same structure, translated.
        val ro = Scenes.scene(600, 300, 560, 240, 20, 20, lang = "ro") { m -> LibraryPanel(ctl, {}, m, PanelTier.Full, initialPlayed = played) }
        try {
            val rows = ro.settle().nodes().tagged(LibraryTags.ROW)
            assertEquals(listOf("Încarcă pe deck A", "Încarcă pe deck B"), rows[0].config.getOrNull(SemanticsActions.CustomActions).orEmpty().map { it.label })
            assertEquals("pe Deck A", rows[0].state())
        } finally {
            ro.close()
        }
    }

    /** Heights of the rows and sizes of the first row's load cells of a library in a [w] × [h] box. */
    private class Measured(val rowHeights: List<Float>, val cellW: Float?, val cellH: Float?, val rowsBottom: Float, val problems: List<String>)

    private fun measure(tier: PanelTier, w: Int, h: Int, touch: Boolean?, lang: String = "en"): Measured {
        val ctl = Scenes.controller()
        val problems = ArrayList<String>()
        val scene = Scenes.scene(w + 40, h + 40, w, h, 20, 20, lang = lang, fit = { problems += it }) { m ->
            // null = through the composition local, as the Android root provides it.
            if (touch == null) CompositionLocalProvider(LocalTouchInput provides true) { LibraryPanel(ctl, {}, m, tier) }
            else LibraryPanel(ctl, {}, m, tier, touch = touch)
        }
        try {
            val nodes = scene.settle().nodes()
            val rows = nodes.tagged(LibraryTags.ROW)
            val cell = nodes.tagged(LibraryTags.ROW_LOAD_A).firstOrNull()?.windowRect()
            return Measured(rows.map { it.windowRect().height }, cell?.width, cell?.height, rows.maxOfOrNull { it.windowRect().bottom } ?: 0f, problems)
        } finally {
            scene.close()
        }
    }

    @Test fun onTouchInputRowsAndLoadCellsAre48DpAndWithAPointerTheyStayDense() {
        assertEquals(listOf(22, 48), listOf(libRowDp(false), libRowDp(true)))
        assertEquals(listOf(22, 48), listOf(LIB_ROW_DP, LIB_ROW_TOUCH_DP))
        for ((tier, box) in listOf(PanelTier.Full to (520 to 240), PanelTier.Compact to (320 to 160))) {
            val (w, h) = box
            // Pointer / keyboard: the dense table of the desktop look.
            val dense = measure(tier, w, h, touch = false)
            assertTrue(dense.rowHeights.isNotEmpty() && dense.rowHeights.all { it == 22f }, "$tier dense rows are 22 dp: ${dense.rowHeights}")
            assertEquals(24f to 18f, dense.cellW to dense.cellH, "$tier dense load cell")
            // Touch: 48 dp rows, 48 dp load cells, and still only whole rows inside the panel.
            for (lang in listOf("en", "ro")) {
                val touch = measure(tier, w, h, touch = true, lang = lang)
                val want = minOf(4, libraryRows(tier, h.toDouble(), LIB_ROW_TOUCH_DP))
                assertEquals(want, touch.rowHeights.size, "$tier touch $lang: whole 48 dp rows that fit ${w}x$h")
                assertTrue(want >= 2 && touch.rowHeights.all { it >= 48f }, "$tier touch rows are 48 dp or more: ${touch.rowHeights}")
                assertTrue(touch.cellW!! >= 48f && touch.cellH!! >= 48f, "$tier touch load cell is ${touch.cellW}x${touch.cellH}")
                assertTrue(touch.rowsBottom <= 20f + h + 0.5f, "$tier touch: the last row ends inside the panel (${touch.rowsBottom} of ${20 + h})")
                assertTrue(touch.problems.isEmpty(), "$tier touch $lang cuts something: ${touch.problems}")
            }
        }
        // The icon tier has no load column; its rows still grow on touch.
        val icon = measure(PanelTier.Icon, 200, 130, touch = true)
        assertEquals(listOf(48f, 48f), icon.rowHeights, "icon tier on touch: two 48 dp rows in 130 dp")
        assertEquals(null, icon.cellW, "the icon tier has no load cells")
        // The mode comes from the composition local the platform root provides (Android: a touch screen is present).
        val viaLocal = measure(PanelTier.Full, 520, 240, touch = null)
        assertTrue(viaLocal.rowHeights.isNotEmpty() && viaLocal.rowHeights.all { it >= 48f }, "LocalTouchInput switches the rows: ${viaLocal.rowHeights}")
    }

    @OptIn(InternalComposeUiApi::class)
    private fun ImageComposeScene.press(key: Key, t: Long): Boolean {
        val down = sendKeyEvent(KeyEvent(key, KeyEventType.KeyDown))
        sendKeyEvent(KeyEvent(key, KeyEventType.KeyUp))
        render(t)
        return down
    }

    /** [key] down and up with modifier keys held; true = the key-down was consumed by something in the scene. */
    @OptIn(InternalComposeUiApi::class)
    private fun ImageComposeScene.chord(key: Key, t: Long, ctrl: Boolean = false, alt: Boolean = false, meta: Boolean = false, shift: Boolean = false): Boolean {
        val down = sendKeyEvent(KeyEvent(key, KeyEventType.KeyDown, isCtrlPressed = ctrl, isMetaPressed = meta, isAltPressed = alt, isShiftPressed = shift))
        sendKeyEvent(KeyEvent(key, KeyEventType.KeyUp, isCtrlPressed = ctrl, isMetaPressed = meta, isAltPressed = alt, isShiftPressed = shift))
        render(t)
        return down
    }

    private fun ImageComposeScene.focus(tag: String, t: Long) {
        val node = nodes().one(tag)
        assertTrue(node.config.getOrNull(SemanticsActions.RequestFocus)?.action?.invoke() == true, "$tag takes focus")
        render(t)
        assertEquals(true, nodes().one(tag).config.getOrNull(SemanticsProperties.Focused), "$tag is focused")
    }

    @Test fun aKeyWithCtrlAltOrMetaIsNotTheListsAndPlainEnterStillLoads() {
        // The reviewed bug: the focused list consumed Enter whatever was held, so Ctrl+Enter (play deck B, a shortcut
        // of the screen) was dead while the list had focus. The parent here stands for the screen: it records every
        // key-down the list let through, with the modifiers it arrived with.
        val frame = 16_666_667L
        val ctl = Scenes.controller() // deck A holds track 0, deck B track 1
        val passed = ArrayList<String>()
        val scene = Scenes.scene(600, 300, 560, 240, 20, 20) { m ->
            Box(
                m.onKeyEvent { e ->
                    if (e.type == KeyEventType.KeyDown) {
                        val held = listOfNotNull("ctrl".takeIf { e.isCtrlPressed }, "alt".takeIf { e.isAltPressed }, "meta".takeIf { e.isMetaPressed }, "shift".takeIf { e.isShiftPressed })
                        val name = when (e.key) {
                            Key.Enter -> "Enter"
                            Key.NumPadEnter -> "NumPadEnter"
                            Key.DirectionDown -> "Down"
                            Key.MoveHome -> "Home"
                            else -> "other"
                        }
                        passed += (held + name).joinToString("+")
                    }
                    false
                },
            ) { LibraryPanel(ctl, {}, Modifier.fillMaxSize(), PanelTier.Full) }
        }
        fun titles() = listOf(ctl.deck(0)!!.title, ctl.deck(1)!!.title)
        val tracks = DemoBackend.DEMO_TRACKS.map { it.title }
        try {
            scene.settle()
            scene.focus(LibraryTags.LIST, 2 * frame)
            assertTrue(scene.press(Key.DirectionDown, 3 * frame) && scene.press(Key.DirectionDown, 4 * frame), "plain Down is the list's")
            assertEquals(2, ctl.selectedRow)
            assertTrue(passed.isEmpty(), "plain arrows stay in the list: $passed")
            // Ctrl+Enter: not consumed by the list (the parent gets it, with Ctrl held), and nothing is loaded.
            // What the parent received is the proof; what the scene returns for a key nobody consumed is not asserted.
            scene.chord(Key.Enter, 5 * frame, ctrl = true)
            assertEquals(listOf("ctrl+Enter"), passed, "Ctrl+Enter reached the parent handler")
            scene.chord(Key.NumPadEnter, 6 * frame, ctrl = true)
            scene.chord(Key.Enter, 7 * frame, alt = true)
            scene.chord(Key.Enter, 8 * frame, meta = true)
            // With Shift as well: still a chord of the screen.
            scene.chord(Key.Enter, 9 * frame, ctrl = true, shift = true)
            // The other keys of the list follow the same rule.
            scene.chord(Key.DirectionDown, 10 * frame, ctrl = true)
            scene.chord(Key.MoveHome, 11 * frame, alt = true)
            assertEquals(listOf("ctrl+Enter", "ctrl+NumPadEnter", "alt+Enter", "meta+Enter", "ctrl+shift+Enter", "ctrl+Down", "alt+Home"), passed)
            repeat(8) { ctl.tick() }
            assertEquals(listOf(tracks[0], tracks[1]), titles(), "no chord loaded anything")
            assertEquals(2, ctl.selectedRow, "no chord moved the selection")
            assertEquals(true, scene.nodes().one(LibraryTags.LIST).config.getOrNull(SemanticsProperties.Focused), "the list still has the focus")
            // Plain Enter is still the list's: it loads the selected row on deck A and does not reach the parent.
            assertTrue(scene.chord(Key.Enter, 12 * frame), "plain Enter is consumed by the list")
            repeat(8) { ctl.tick() }
            assertEquals(listOf(tracks[2], tracks[1]), titles(), "Enter loaded the selected track on deck A")
            // Shift is not a shortcut modifier here: Shift+Enter loads on deck B.
            assertTrue(scene.press(Key.DirectionDown, 13 * frame))
            assertTrue(scene.chord(Key.Enter, 14 * frame, shift = true), "Shift+Enter is consumed by the list")
            repeat(8) { ctl.tick() }
            assertEquals(listOf(tracks[2], tracks[3]), titles(), "Shift+Enter loaded the selected track on deck B")
            assertEquals(7, passed.size, "plain Enter and Shift+Enter did not reach the parent: $passed")
        } finally {
            scene.close()
        }
    }

    @Test fun ctrlEnterPlaysDeckBWhileTheLibraryListHasFocus() {
        // The same on the real screen: its shortcut map handles what bubbles up from the focused list.
        val frame = 16_666_667L
        val ctl = Scenes.controller()
        val scene = Scenes.scene(1366, 768, 1366, 768) { _ -> DecksScreen(ctl, autoFocus = false) }
        try {
            var t = 0L
            fun next(): Long {
                t += frame
                return t
            }
            repeat(4) { scene.render(next()) }
            scene.focus(LibraryTags.LIST, next())
            assertEquals(listOf(false, false), listOf(ctl.deck(0)!!.playing, ctl.deck(1)!!.playing))
            assertTrue(scene.chord(Key.Enter, next(), ctrl = true), "the screen handles Ctrl+Enter that came up from the list")
            ctl.tick()
            assertEquals(listOf(false, true), listOf(ctl.deck(0)!!.playing, ctl.deck(1)!!.playing), "Ctrl+Enter started deck B, not deck A")
            assertEquals(DemoBackend.DEMO_TRACKS[0].title, ctl.deck(0)!!.title, "and loaded nothing on deck A")
            // The list keeps the focus and its own keys: Down twice, then Enter loads that row on deck A.
            assertEquals(true, scene.nodes().one(LibraryTags.LIST).config.getOrNull(SemanticsProperties.Focused))
            scene.press(Key.DirectionDown, next())
            scene.press(Key.DirectionDown, next())
            assertEquals(2, ctl.selectedRow)
            assertTrue(scene.chord(Key.Enter, next()), "plain Enter is consumed")
            repeat(8) { scene.render(next()) }
            assertEquals(DemoBackend.DEMO_TRACKS[2].title, ctl.deck(0)!!.title, "Enter loaded the selected track on deck A")
            assertTrue(ctl.deck(1)!!.playing, "and deck B kept playing")
            // Ctrl+Enter again: deck B pauses.
            assertTrue(scene.chord(Key.Enter, next(), ctrl = true))
            ctl.tick()
            assertFalse(ctl.deck(1)!!.playing, "a second Ctrl+Enter paused deck B")
        } finally {
            scene.close()
        }
    }

    @Test fun theCentreKeyOfADpadActivatesAButtonAndLoadsTheSelectedTrack() {
        assertTrue(isDpadCenter(Key.DirectionCenter) && isActivateKey(Key.DirectionCenter) && isActivateKey(Key.Enter) && isActivateKey(Key.Spacebar))
        assertFalse(isActivateKey(Key.Unknown), "an unmapped key activates nothing")
        assertFalse(isActivateKey(Key.A))
        val frame = 16_666_667L
        // A push button: PLAY of deck A.
        val ctl = Scenes.controller()
        val deck = Scenes.scene(520, 300, 480, 250, 20, 20) { m -> DeckPanel(ctl, 0, m, PanelTier.Full) }
        try {
            deck.settle()
            deck.focus(DeckTags.PLAY, 2 * frame)
            assertFalse(ctl.deck(0)!!.playing)
            deck.press(Key.Unknown, 3 * frame)
            ctl.tick()
            assertFalse(ctl.deck(0)!!.playing, "an unknown key does not press PLAY")
            assertTrue(deck.press(Key.DirectionCenter, 4 * frame), "the focused button handles D-pad centre")
            ctl.tick()
            assertTrue(ctl.deck(0)!!.playing, "D-pad centre pressed PLAY")
            deck.press(Key.Enter, 5 * frame)
            ctl.tick()
            assertFalse(ctl.deck(0)!!.playing, "Enter pressed it again")
        } finally {
            deck.close()
        }
        // The library list: Down moves the selection, D-pad centre loads the selected row on deck A.
        val ctl2 = Scenes.controller()
        val lib = Scenes.scene(600, 300, 560, 240, 20, 20) { m -> LibraryPanel(ctl2, {}, m, PanelTier.Full) }
        try {
            lib.settle()
            lib.focus(LibraryTags.LIST, 2 * frame)
            assertTrue(lib.press(Key.DirectionDown, 3 * frame))
            lib.press(Key.DirectionDown, 4 * frame)
            assertEquals(2, ctl2.selectedRow, "two presses of Down: the third row")
            assertEquals(true, lib.nodes().tagged(LibraryTags.ROW)[2].config.getOrNull(SemanticsProperties.Selected))
            assertTrue(lib.press(Key.DirectionCenter, 5 * frame), "the list handles D-pad centre")
            repeat(8) { ctl2.tick() }
            assertEquals(DemoBackend.DEMO_TRACKS[2].title, ctl2.deck(0)!!.title, "the selected track is on deck A")
        } finally {
            lib.close()
        }
    }
}
