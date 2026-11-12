package ro.mixai.decks.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.TextLayoutResult
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.jetbrains.skia.EncodedImageFormat
import ro.mixai.decks.ui.Scenes.click
import ro.mixai.decks.ui.Scenes.description
import ro.mixai.decks.ui.Scenes.nodes
import ro.mixai.decks.ui.Scenes.one
import ro.mixai.decks.ui.Scenes.settle
import ro.mixai.decks.ui.Scenes.tagged
import ro.mixai.decks.ui.Scenes.windowRect
import ro.mixai.decks.ui.screens.CONNECT_SWITCH_DP
import ro.mixai.decks.ui.screens.CONNECT_SWITCH_TOUCH_DP
import ro.mixai.decks.ui.screens.ConnectPanel
import ro.mixai.decks.ui.screens.ConnectTags
import ro.mixai.decks.ui.screens.DecksScreen
import ro.mixai.decks.ui.theme.LocalTouchInput

/**
 * The connect panel's controls-lock switch (WP19-42): it is there while connected mode is on, says what it is and
 * which way it stands in words (EN and RO), is big enough to hit, moves the controller, and keeps nothing of its
 * copy cut in a narrow panel. On the real screen it is never worse off than the party switch under it; the panel
 * has one arrangement and no scroll, so in a low phone window its lower rows get no height: what was measured for
 * each window is written to build/connect-panel-screen.txt (and the text layout numbers to build/connect-panel.txt).
 * The controller side (port calls, pump report, Connect off / on) is RemoteTest.
 */
class ConnectPanelTest {
    private fun SemanticsNode.state(): String? = config.getOrNull(SemanticsProperties.StateDescription)
    private fun SemanticsNode.toggle(): ToggleableState? = config.getOrNull(SemanticsProperties.ToggleableState)
    private fun SemanticsNode.role(): Role? = config.getOrNull(SemanticsProperties.Role)
    /** The text this node shows: its own and that of the nodes under it (a button's label is a child node). */
    private fun SemanticsNode.text(): String {
        val own = config.getOrNull(SemanticsProperties.Text)?.map { it.text }.orEmpty()
        return (own + children.map { it.text() }).filter { it.isNotEmpty() }.joinToString(" ")
    }
    private fun SemanticsNode.layout(): TextLayoutResult? {
        val out = ArrayList<TextLayoutResult>()
        config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(out)
        return out.firstOrNull()
    }

    /**
     * What is wrong with how [text] was laid out in this node, or nothing: every character is on a line, no
      * line is ellipsized or wider than the node, and the node is as high as its lines. Measured from the lines
      * themselves, not from the layout result's `didOverflowWidth`: that flag was true for the English hint in
      * the 480 dp panel with nothing cut (one line 380 px wide in a node 381 px wide, laid out with 396 px
      * offered; build/connect-panel.txt has the numbers of every case).
     */
    private fun SemanticsNode.cut(text: String): List<String> {
        val l = layout() ?: return listOf("no text layout")
        val bad = ArrayList<String>()
        val last = l.lineCount - 1
        if (l.getLineEnd(last) != text.length) bad += "the last line ends at ${l.getLineEnd(last)} of ${text.length}"
        for (i in 0..last) {
            if (l.isLineEllipsized(i)) bad += "line $i is ellipsized"
            if (l.getLineRight(i) > size.width + 0.5f) bad += "line $i is ${l.getLineRight(i)} wide in ${size.width}"
        }
        if (l.getLineBottom(last) > size.height + 0.5f) bad += "${l.lineCount} lines are ${l.getLineBottom(last)} high in ${size.height}"
        return bad
    }

    private class Words(val name: String, val hint: String, val on: String, val off: String)

    private val words = mapOf(
        "en" to Words("Lock phone controls", "Phones cannot move the decks while this is on. Song requests keep working.", "on", "off"),
        "ro" to Words("Blochează comenzile de pe telefoane", "Cât timp e pornit, telefoanele nu pot mișca deck-urile. Cererile de piese merg în continuare.", "pornit", "oprit"),
    )

    @Test fun theSwitchIsAbsentWhileConnectedModeIsOffAndPresentWithItsWordsWhenOn() {
        for (lang in listOf("en", "ro")) {
            val w = words.getValue(lang)
            val fake = FakeRemote()
            val ctl = DecksController(RemoteBackend(fake))
            ctl.startEngine()
            val off = Scenes.scene(900, 600, 860, 560, 20, 20, lang = lang) { m -> ConnectPanel(ctl, m) }
            try {
                val nodes = off.settle().nodes()
                assertTrue(nodes.tagged(ConnectTags.LOCK).isEmpty(), "$lang: no lock switch while connected mode is off")
                assertTrue(nodes.tagged(ConnectTags.PARTY).isEmpty(), "$lang: like the party switch")
            } finally {
                off.close()
            }
            assertTrue(ctl.setRemoteEnabled(true))
            val problems = ArrayList<String>()
            val on = Scenes.scene(900, 600, 860, 560, 20, 20, lang = lang, fit = { problems += it }) { m -> ConnectPanel(ctl, m) }
            try {
                var nodes = on.settle().nodes()
                val lock = nodes.one(ConnectTags.LOCK)
                val party = nodes.one(ConnectTags.PARTY)
                // Named, a switch, its state in words (and as a toggle state), not by colour alone.
                assertEquals(w.name, lock.description(), "$lang: the switch is named")
                assertEquals(Role.Switch, lock.role(), "$lang: announced as a switch")
                assertEquals(w.off, lock.state(), "$lang: reads off")
                assertEquals(ToggleableState.Off, lock.toggle())
                assertEquals(w.off, lock.text(), "$lang: the visible word is the state word")
                assertEquals(w.hint, nodes.one(ConnectTags.LOCK_HINT).text(), "$lang: the explanation under it")
                val name = nodes.one(ConnectTags.LOCK_NAME)
                assertTrue(name.config.getOrNull(SemanticsProperties.Text) == null, "$lang: the visible name is not spoken twice")
                // Next to the party switch: directly above its row, left-aligned with it.
                val lockR = lock.windowRect()
                val partyR = party.windowRect()
                assertTrue(lockR.bottom <= partyR.top, "$lang: the lock row $lockR is above the requests row $partyR")
                assertTrue(partyR.top - lockR.bottom < 40f, "$lang: and right above it (${partyR.top - lockR.bottom} dp between)")
                assertTrue(lockR.width >= CONNECT_SWITCH_DP && lockR.height >= CONNECT_SWITCH_DP, "$lang: target $lockR is at least $CONNECT_SWITCH_DP dp")
                assertTrue(problems.isEmpty(), "$lang: something is cut: $problems")
                // It works: a tap locks (one call with true), the words follow.
                assertTrue(lock.click(), "$lang: the switch has a click action")
                assertEquals(listOf(false, true), fake.lockCalls, "$lang: the tap told the server")
                assertTrue(ctl.controlsLocked)
                Snapshot.sendApplyNotifications()
                on.render(2 * 16_666_667L)
                on.render(3 * 16_666_667L)
                nodes = on.nodes()
                val locked = nodes.one(ConnectTags.LOCK)
                assertEquals(w.on, locked.state(), "$lang: reads on")
                assertEquals(ToggleableState.On, locked.toggle())
                assertEquals(w.on, locked.text())
                assertEquals(w.name, locked.description(), "$lang: the name does not change with the state")
                // The party switch did not move.
                assertTrue(fake.open && ctl.partyOpen, "$lang: the party switch is its own switch")
                // A second tap unlocks.
                assertTrue(locked.click())
                assertEquals(listOf(false, true, false), fake.lockCalls)
                assertFalse(ctl.controlsLocked)
            } finally {
                on.close()
            }
        }
    }

    @Test fun theSwitchFollowsALockSetElsewhereAndGrowsOnTouchInput() {
        val fake = FakeRemote()
        val ctl = DecksController(RemoteBackend(fake))
        ctl.startEngine()
        ctl.setRemoteEnabled(true)
        // Locked by the server (a report says so): the switch reads on without a tap here.
        fake.locked = true
        repeat(4) { ctl.tick() }
        assertTrue(ctl.controlsLocked)
        val pointer = Scenes.scene(900, 600, 860, 560, 20, 20) { m -> ConnectPanel(ctl, m) }
        try {
            val lock = pointer.settle().nodes().one(ConnectTags.LOCK)
            assertEquals("on", lock.state(), "a lock the server holds shows as on")
            assertEquals(ToggleableState.On, lock.toggle())
            val r = lock.windowRect()
            assertTrue(r.height >= CONNECT_SWITCH_DP && r.height < CONNECT_SWITCH_TOUCH_DP, "pointer input: ${r.height} dp high, like the panel's other buttons")
        } finally {
            pointer.close()
        }
        // Touch input: a 48 dp target.
        val touch = Scenes.scene(900, 600, 860, 560, 20, 20, lang = "ro") { m ->
            CompositionLocalProvider(LocalTouchInput provides true) { ConnectPanel(ctl, m) }
        }
        try {
            val r = touch.settle().nodes().one(ConnectTags.LOCK).windowRect()
            assertTrue(r.width >= CONNECT_SWITCH_TOUCH_DP && r.height >= CONNECT_SWITCH_TOUCH_DP, "touch input: target $r is at least $CONNECT_SWITCH_TOUCH_DP dp")
        } finally {
            touch.close()
        }
    }

    @Test fun nothingOfTheLockRowIsCutInANarrowPanel() {
        // The phone layout gives the panel the window width: 320 dp is the narrowest window the apps support.
        val lines = LinkedHashMap<String, Int>()
        val report = StringBuilder("# ConnectPanelTest.nothingOfTheLockRowIsCutInANarrowPanel: the hint line per panel width\n")
        for (lang in listOf("en", "ro")) for (width in listOf(320, 360, 480)) {
            val where = "$lang ${width}dp"
            val w = words.getValue(lang)
            val fake = FakeRemote()
            val ctl = DecksController(RemoteBackend(fake))
            ctl.startEngine()
            ctl.setRemoteEnabled(true)
            val problems = ArrayList<String>()
            val scene = Scenes.scene(width, 1200, width - 16, 1180, 8, 8, lang = lang, fit = { problems += it }) { m -> ConnectPanel(ctl, m) }
            try {
                val nodes = scene.settle().nodes()
                val lock = nodes.one(ConnectTags.LOCK)
                val name = nodes.one(ConnectTags.LOCK_NAME)
                val hint = nodes.one(ConnectTags.LOCK_HINT)
                val party = nodes.one(ConnectTags.PARTY)
                val panel = Rect(8f, 8f, (width - 8).toFloat(), 1188f)
                for (n in listOf(lock, name, hint)) {
                    val r = n.windowRect()
                    assertTrue(r.left >= panel.left - 0.5f && r.right <= panel.right + 0.5f && r.top >= panel.top && r.bottom <= panel.bottom, "$where: ${n.config.getOrNull(SemanticsProperties.TestTag)} at $r is inside the panel $panel")
                }
                // The explanation wraps instead of being cut: every character is on a line that fits the node.
                val l = hint.layout() ?: error("$where: no text layout for the hint")
                report.append(
                    "$where: node ${hint.size.width}x${hint.size.height} at ${hint.windowRect()}, lines ${l.lineCount}, " +
                        "widest line ${(0 until l.lineCount).maxOf { l.getLineRight(it) }}, lines bottom ${l.getLineBottom(l.lineCount - 1)}, " +
                        "layout size ${l.size.width}x${l.size.height}, paragraph ${l.multiParagraph.width}x${l.multiParagraph.height}, " +
                        "didOverflowWidth ${l.didOverflowWidth}, didOverflowHeight ${l.didOverflowHeight}, " +
                        "last line ends ${l.getLineEnd(l.lineCount - 1)} of ${w.hint.length}; switch ${lock.windowRect()}; party ${party.windowRect()}\n",
                )
                assertEquals(w.hint, hint.text(), "$where: the whole sentence")
                assertEquals(emptyList(), hint.cut(w.hint), "$where: the hint is cut")
                lines[where] = l.lineCount
                // The row grows with its texts and pushes the requests row down: name over hint, nothing overlaps.
                assertTrue(name.windowRect().bottom <= hint.windowRect().top + 0.5f, "$where: the name ${name.windowRect()} is above the hint ${hint.windowRect()}")
                assertTrue(name.size.height >= 14, "$where: the name has at least one line (${name.size.height} px)")
                val rowBottom = maxOf(lock.windowRect().bottom, hint.windowRect().bottom)
                assertTrue(rowBottom <= party.windowRect().top, "$where: the lock row ends at $rowBottom, the requests row starts at ${party.windowRect().top}")
                assertTrue(lock.windowRect().right <= hint.windowRect().left, "$where: the switch is left of its texts")
                assertTrue(lock.size.width >= CONNECT_SWITCH_DP && lock.size.height >= CONNECT_SWITCH_DP, "$where: the switch is ${lock.size.width}x${lock.size.height}, not squeezed")
                assertEquals(w.off, lock.text(), "$where: the switch shows its state word")
                assertTrue(problems.isEmpty(), "$where: something is cut: $problems")
            } finally {
                scene.close()
                java.io.File("build").mkdirs()
                java.io.File("build/connect-panel.txt").writeText(report.toString())
            }
        }
        assertEquals(6, lines.size, "panels rendered")
        // The test can see wrapping: the sentence needs more lines in the narrow panel than in the wide one.
        for (lang in listOf("en", "ro")) {
            assertTrue(lines.getValue("$lang 320dp") >= 2, "$lang: the hint wraps at 320 dp: $lines")
            assertTrue(lines.getValue("$lang 320dp") > lines.getValue("$lang 480dp") || lines.getValue("$lang 480dp") >= 2, "$lang: fewer lines with more room: $lines")
        }
    }

    /** Where the panel's switches are on the real screen in a window, panel opened from the status bar. */
    private class OnScreen(val chip: Rect, val lock: Rect, val name: Rect, val hint: Rect, val party: Rect, val window: Rect) {
        private fun inside(r: Rect): Boolean = r.left >= -0.5f && r.top >= -0.5f && r.right <= window.right + 0.5f && r.bottom <= window.bottom + 0.5f

        /** A whole target: at least [min] dp each way and inside the window. A node squeezed to nothing is not "inside". */
        fun whole(r: Rect, min: Int): Boolean = r.width >= min - 0.5f && r.height >= min - 0.5f && inside(r)
        val lockWhole: Boolean get() = whole(lock, CONNECT_SWITCH_DP)
        val partyWhole: Boolean get() = whole(party, CONNECT_SWITCH_DP)
        /** The explanation: every line of it (its height is at least one 12 sp line) and inside the window. */
        val hintWhole: Boolean get() = hint.height >= 12f && hint.width >= 40f && inside(hint)
        /** Height (dp) the lock row adds above the requests row: the row itself and the 8 dp between the rows. */
        val added: Float get() = party.top - minOf(lock.top, name.top)
        private fun size(r: Rect) = "${r.width}x${r.height} at (${r.left}, ${r.top})"
        fun line(): String = "chip ${size(chip)}; lock ${size(lock)} whole=$lockWhole; hint ${size(hint)} whole=$hintWhole; party ${size(party)} whole=$partyWhole"
    }

    private fun onScreen(w: Int, h: Int, lang: String): OnScreen {
        val ctl = DecksController(RemoteBackend(FakeRemote()))
        ctl.startEngine()
        assertTrue(ctl.setRemoteEnabled(true))
        val chipName = if (lang == "ro") "Conectare" else "Connect"
        val scene = Scenes.scene(w, h, w, h, lang = lang) { _ -> DecksScreen(ctl, autoFocus = false) }
        try {
            val frame = 16_666_667L
            repeat(4) { scene.render(it * frame) }
            val chip = scene.nodes().firstOrNull { it.description() == chipName && it.role() == Role.Button }
                ?: error("${w}x$h $lang: no status-bar chip named '$chipName'")
            assertTrue(chip.click(), "${w}x$h $lang: the chip has a click action")
            Snapshot.sendApplyNotifications()
            repeat(4) { scene.render((4 + it) * frame) }
            val nodes = scene.nodes()
            return OnScreen(
                chip.windowRect(), nodes.one(ConnectTags.LOCK).windowRect(), nodes.one(ConnectTags.LOCK_NAME).windowRect(),
                nodes.one(ConnectTags.LOCK_HINT).windowRect(), nodes.one(ConnectTags.PARTY).windowRect(), Rect(0f, 0f, w.toFloat(), h.toFloat()),
            )
        } finally {
            scene.close()
        }
    }

    @Test fun onTheRealScreenTheLockSwitchIsNeverWorseOffThanThePartySwitch() {
        // The panel opens under the status bar and pushes the layout down; nothing scrolls, and the panel has one
        // arrangement for every width. The row of the three pairing cards (176 dp each) decides how far down the
        // two switches land: in a window that is not high enough for it, the party switch gets no height at all,
        // and so does the lock switch above it once the window is lower still. This test (a) requires the whole
        // lock switch and its explanation in the windows of [must], (b) requires in EVERY window that the lock
        // switch is whole when the party switch is (it sits right above it: never worse off), and (c) writes what
        // it measured to build/connect-panel-screen.txt: every window, those where a switch is not whole included,
        // and per width where the two switches end in a window high enough for everything, with the height the
        // lock row adds above the party switch (the party switch and the request list start that much lower than
        // before the lock row existed).
        // The panel is opened through the chip's click action: in the windows under 700 dp the chip itself is
        // squeezed to zero width in the status bar (its size is in the report).
        val must = listOf(1440 to 900, 1366 to 768, 1024 to 768, 960 to 600, 800 to 600, 480 to 1000, 412 to 915)
        val alsoMeasured = listOf(393 to 852, 360 to 800, 360 to 640, 320 to 568)
        val report = StringBuilder("# ConnectPanelTest.onTheRealScreenTheLockSwitchIsNeverWorseOffThanThePartySwitch (connected mode on, panel open)\n")
        val bad = ArrayList<String>()
        var whole = 0
        var notWhole = 0
        var partyNotWhole = 0
        for (lang in listOf("en", "ro")) for ((w, h) in must + alsoMeasured) {
            val s = onScreen(w, h, lang)
            val where = "${w}x$h $lang"
            val required = (w to h) in must
            report.append("$where${if (required) "" else " (measured only)"}: ${s.line()}\n")
            if (s.lockWhole) whole++ else notWhole++
            if (!s.partyWhole) partyNotWhole++
            if (s.partyWhole && !s.lockWhole) bad += "$where: the party switch is whole, the lock switch above it is not: ${s.line()}"
            if (s.lockWhole && !s.hintWhole) bad += "$where: the switch is there, its explanation is not: ${s.line()}"
            if (required && !s.lockWhole) bad += "$where: the lock switch is not whole: ${s.line()}"
        }
        report.append("lock switch whole in $whole of ${whole + notWhole} windows; party switch not whole in $partyNotWhole\n")
        // A window high enough for the whole panel: where the switches end, and what the lock row costs in height.
        report.append("## in a 2000 dp high window (y of the lower edge; the panel needs its padding and the screen padding under it)\n")
        for (lang in listOf("en", "ro")) for (w in listOf(1366, 800, 480, 412, 393, 360, 320)) {
            val s = onScreen(w, 2000, lang)
            val where = "${w}dp $lang"
            report.append("$where: lock switch ends at ${s.lock.bottom}, hint at ${s.hint.bottom}, party switch at ${s.party.bottom}; the lock row adds ${s.added} dp\n")
            if (!s.lockWhole || !s.hintWhole || !s.partyWhole) bad += "$where: not whole in a 2000 dp high window: ${s.line()}"
            // One arrangement: the switch (44 dp) or its two texts, whichever is higher, plus the 8 dp between rows.
            if (s.added < CONNECT_SWITCH_DP + 8 - 0.5f || s.added > 100f) bad += "$where: the lock row adds ${s.added} dp"
        }
        java.io.File("build").mkdirs()
        java.io.File("build/connect-panel-screen.txt").writeText(report.toString() + bad.joinToString("\n", prefix = "## problems (${bad.size})\n"))
        assertEquals(2 * (must.size + alsoMeasured.size), whole + notWhole, "windows measured")
        assertTrue(bad.isEmpty(), "${bad.size} problems:\n" + bad.joinToString("\n"))
    }

    @Test fun picturesOfThePanelWithTheLockRow() {
        // For looking at (build/screenshots/panels/connect-*.png, 1 px per dp), like ScreenshotTest's panel shots:
        // the panel alone with connected mode on, unlocked and locked, at a desktop width and at a phone width.
        val dir = File("build/screenshots/panels").apply { mkdirs() }
        for ((lang, width, locked) in listOf(Triple("en", 860, false), Triple("ro", 860, true), Triple("ro", 412, true))) {
            val ctl = DecksController(RemoteBackend(FakeRemote()))
            ctl.startEngine()
            assertTrue(ctl.setRemoteEnabled(true))
            ctl.changeControlsLocked(locked)
            repeat(24) { ctl.tick() }
            val height = if (width < 500) 900 else 500
            val scene = Scenes.scene(width + 16, height + 16, width, height, 8, 8, lang = lang) { m -> ConnectPanel(ctl, m) }
            try {
                scene.render(0)
                val image = scene.render(16_666_667L)
                val out = File(dir, "connect-$width-${if (locked) "locked" else "unlocked"}-$lang.png")
                out.writeBytes(image.encodeToData(EncodedImageFormat.PNG)!!.bytes)
                assertTrue(out.length() > 1_000, "picture too small: ${out.length()} bytes")
            } finally {
                scene.close()
            }
        }
    }
}
