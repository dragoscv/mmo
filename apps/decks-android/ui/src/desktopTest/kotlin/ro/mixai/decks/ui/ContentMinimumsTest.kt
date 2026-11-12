package ro.mixai.decks.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.jetbrains.skia.EncodedImageFormat
import ro.mixai.decks.ui.components.LocalFitProbe
import ro.mixai.decks.ui.components.LookLine
import ro.mixai.decks.ui.components.LookText
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.LayoutDoc
import ro.mixai.decks.ui.engine.LayoutSolution
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.i18n.DesktopStrings
import ro.mixai.decks.ui.i18n.LocalStrings
import ro.mixai.decks.ui.screens.CrossfaderPanel
import ro.mixai.decks.ui.screens.DeckPanel
import ro.mixai.decks.ui.screens.DeckTab
import ro.mixai.decks.ui.screens.DecksScreen
import ro.mixai.decks.ui.screens.LibraryPanel
import ro.mixai.decks.ui.screens.MixerPanel
import ro.mixai.decks.ui.screens.NativePanels
import ro.mixai.decks.ui.screens.effectiveLayout
import ro.mixai.decks.ui.screens.layoutHostSize
import ro.mixai.decks.ui.screens.layoutRender
import ro.mixai.decks.ui.screens.withLookGap
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.DecksTheme
import ro.mixai.decks.ui.theme.SkinState

/**
 * The Compose deck / mixer / crossfader / library are sized for the Decks 1.5 panel minimums
 * (`PANEL_SPECS` = [DemoPacks.specs]), and the layout host draws every panel at the solver's tier.
 * That is a claim about the real panels, so this test RENDERS them: in the minimum box of every
 * tier, and in the boxes the layouts give on a laptop and a full-HD window, for every preset skin,
 * in English and Romanian, idle and with the busiest content. Every look control reports to
 * [LocalFitProbe] when it gets less room than it needs (a label that is cut, a target under 24 dp, a
 * squeezed row): the lists must be empty. Rendered at density 1 with the desktop default font.
 */
class ContentMinimumsTest {
    private val languages = listOf("en", "ro")

    /** Hard floor (dp) of the measured-minimum search: no panel is rendered smaller than this (or than its contract side). */
    private val SWEEP_FLOOR_DP = 40

    /** Nothing loaded: placeholders everywhere. */
    private fun emptyController(): DecksController {
        val ctl = DecksController(DemoBackend { 0.0 })
        ctl.startEngine()
        repeat(6) { ctl.tick() }
        return ctl
    }

    /** Two decks loaded, idle. */
    private fun controller(): DecksController {
        val ctl = DecksController(DemoBackend { 0.0 })
        ctl.startEngine()
        ctl.loadToDeck(0, DemoBackend.DEMO_TRACKS[0])
        ctl.loadToDeck(1, DemoBackend.DEMO_TRACKS[1])
        repeat(6) { ctl.tick() }
        return ctl
    }

    /**
     * The busiest content: deck A plays its last seconds (end-of-track chip, alert colours) with sync
     * lock (so a shifted tempo), a key shift, key lock, slip, a running loop, all eight hot cues and
     * the delete toggle on; deck B is in the headphones.
     */
    private fun busyController(): DecksController {
        val ctl = controller()
        val dur = ctl.deck(0)!!.durationSec
        for (slot in 0 until 8) {
            ctl.backend.seek(0, 20.0 + slot * 40.0)
            ctl.hotCue(0, slot)
        }
        ctl.syncLock(0)
        ctl.shiftKey(0, 2.0)
        ctl.toggleKeyLock(0)
        ctl.toggleSlip(0)
        ctl.backend.seek(0, dur - 12.0)
        ctl.togglePlay(0)
        ctl.tick()
        ctl.loopAuto(0)
        ctl.togglePfl(1)
        ctl.toggleHotCueDelete(0)
        ctl.tick()
        val d = ctl.deck(0)!!
        check(d.playing && d.syncLock && d.loopActive && d.keyLock && d.slip && d.hotCues.all { it != null }) { "busy state not reached: $d" }
        return ctl
    }

    private class Case(val name: String, val id: PanelId, val tier: PanelTier, val content: @Composable (DecksController, Modifier) -> Unit)

    private val cases: List<Case> = buildList {
        for (t in PanelTier.entries) {
            add(Case("deck A $t", PanelId.DeckA, t) { c, m -> DeckPanel(c, 0, m, t) })
            add(Case("deck B $t", PanelId.DeckB, t) { c, m -> DeckPanel(c, 1, m, t) })
            add(Case("mixer $t", PanelId.Mixer, t) { c, m -> MixerPanel(c, m, t) })
            add(Case("mixer with crossfader row $t", PanelId.Mixer, t) { c, m -> MixerPanel(c, m, t, withCrossfader = true) })
            add(Case("crossfader $t", PanelId.Crossfader, t) { c, m -> CrossfaderPanel(c, m, t) })
            add(Case("library $t", PanelId.Library, t) { c, m -> LibraryPanel(c, {}, m, t) })
        }
        add(Case("deck A Full, LOOP tab", PanelId.DeckA, PanelTier.Full) { c, m -> DeckPanel(c, 0, m, PanelTier.Full, initialTab = DeckTab.Loops) })
    }

    /**
     * Renders [content] in a [w] × [h] dp box and returns what the look controls reported (empty = everything fits).
     * [canvasW] × [canvasH] = the window (dp), larger than the box when a popup of the panel needs room;
     * [pixels] receives the encoded frame.
     */
    private fun problems(
        skin: DecksSkin, lang: String, w: Int, h: Int,
        canvasW: Int = w + 40, canvasH: Int = h + 40, pixels: ((ByteArray) -> Unit)? = null,
        content: @Composable (Modifier) -> Unit,
    ): List<String> {
        val found = LinkedHashSet<String>()
        val scene = ImageComposeScene(canvasW, canvasH, Density(1f)) {
            CompositionLocalProvider(LocalStrings provides DesktopStrings.forLanguage(lang), LocalFitProbe provides { found += it }) {
                DecksTheme(reducedMotion = true, skin = skin) {
                    Box(Modifier.padding(20.dp).size(w.dp, h.dp)) { content(Modifier.fillMaxSize()) }
                }
            }
        }
        try {
            scene.render(0)
            val img = scene.render(16_666_667L)
            pixels?.invoke(img.encodeToData(EncodedImageFormat.PNG)!!.bytes)
        } finally {
            scene.close()
        }
        return found.toList()
    }

    private fun minimum(c: Case): Pair<Int, Int> = DemoPacks.specs.getValue(c.id).min(c.tier).let { it.first.toInt() to it.second.toInt() }

    @Test fun everyPanelFitsTheMinimumBoxOfEveryTier() {
        val states = listOf("empty" to emptyController(), "busy" to busyController())
        val bad = ArrayList<String>()
        var renders = 0
        for (skin in DecksSkin.presets) for (lang in languages) for ((state, ctl) in states) for (c in cases) {
            val (w, h) = minimum(c)
            val p = problems(skin, lang, w, h) { m -> c.content(ctl, m) }
            renders++
            if (p.isNotEmpty()) bad += "${skin.id} $lang $state: ${c.name} in ${w}x$h: " + p.joinToString("; ")
        }
        assertEquals(DecksSkin.presets.size * languages.size * states.size * cases.size, renders)
        assertTrue(bad.isEmpty(), "${bad.size} of $renders panel renders do not fit the PANEL_SPECS minimum of their tier:\n" + bad.joinToString("\n"))
    }

    @Test fun everyPanelFitsTheBoxesItsLayoutGivesOnLaptopAndFullHdWindows() {
        val ctl = busyController()
        val bad = ArrayList<String>()
        val report = StringBuilder()
        var renders = 0
        val windows = listOf(1366 to 768, 1920 to 1080)
        // Every preset on its own layout, plus the phone layout (decks at the icon tier, 228 dp wide).
        val runs = DecksSkin.presets.flatMap { s -> windows.map { Triple(s, it.first, it.second) } } + Triple(DecksSkin.default, 480, 1000)
        for ((skin, ww, wh) in runs) {
            val layout = effectiveLayout(skin.resolveLayout(DemoPacks.presets)!!, ww.toFloat()).withLookGap(skin)
            val (hw, hh) = layoutHostSize(ww.toDouble(), wh.toDouble(), skin, layout)
            val plan = layoutRender(DemoPacks.solve(layout, hw, hh, NativePanels), setOf(PanelId.Waves))
            val hasCrossfader = layout.areas.any { it.panel == PanelId.Crossfader }
            for (p in plan.panels) {
                val t = p.tier
                val content: @Composable (Modifier) -> Unit = when (p.panel) {
                    PanelId.DeckA -> { m -> DeckPanel(ctl, 0, m, t) }
                    PanelId.DeckB -> { m -> DeckPanel(ctl, 1, m, t) }
                    PanelId.Mixer -> { m -> MixerPanel(ctl, m, t, withCrossfader = !hasCrossfader) }
                    PanelId.Crossfader -> { m -> CrossfaderPanel(ctl, m, t) }
                    PanelId.Library -> { m -> LibraryPanel(ctl, {}, m, t) }
                    else -> continue
                }
                val w = p.rect.w.toInt()
                val h = p.rect.h.toInt()
                if (skin == DecksSkin.default) report.append("${layout.id} in a ${ww}x$wh window: ${p.panel.key} ${w}x$h $t\n")
                for (lang in languages) {
                    val found = problems(skin, lang, w, h, content = content)
                    renders++
                    if (found.isNotEmpty()) bad += "${skin.id} (${layout.id}) ${ww}x$wh $lang: ${p.panel.key} $t in ${w}x$h: " + found.joinToString("; ")
                }
            }
        }
        File("build").mkdirs()
        File("build/content-layout-boxes.txt").writeText(report.toString())
        assertTrue(renders >= 150, "the layouts were rendered: $renders panel renders")
        assertTrue(bad.isEmpty(), "${bad.size} of $renders panel renders do not fit the box their layout gives:\n" + bad.joinToString("\n"))
    }

    /**
     * MEASURES how far under its contract minimum each panel still fits (width at the minimum height, height at the
     * minimum width, default skin, busiest content) and writes build/content-minimums.txt. The search goes down to
     * where the panel stops fitting, or to the hard floor of [SWEEP_FLOOR_DP] (a panel that re-arranges itself may
     * report nothing at any size: "≤ 40" then means "no cut was found down to the floor", not "fits everywhere").
     * Asserts what the contract needs: every panel fits AT its minimum, and the measured minimum is not above it.
     */
    @Test fun measuredMinimumsAreWrittenAndNeverAboveTheContract() {
        val ctl = busyController()
        val skin = DecksSkin.default
        val report = StringBuilder(
            "panel tier: contract minimum; measured = smallest box in which no control reports a cut (desktop font, density 1, MixAI Signature, busiest content).\n" +
                "Searched one dp at a time from the contract minimum down to the first size that cuts something; the hard floor is $SWEEP_FLOOR_DP dp:\n" +
                "'<= $SWEEP_FLOOR_DP (floor)' = nothing reported down to the floor (the panel re-arranges; smaller boxes were not rendered).\n",
        )
        val above = ArrayList<String>()
        var renders = 0
        for (c in cases) {
            val (w, h) = minimum(c)
            for (lang in languages) {
                fun fits(bw: Int, bh: Int): Boolean {
                    renders++
                    return problems(skin, lang, bw, bh) { m -> c.content(ctl, m) }.isEmpty()
                }
                if (!fits(w, h)) {
                    above += "${c.name} $lang needs more than ${w}x$h"
                    report.append("${c.name} $lang: contract ${w}x$h, DOES NOT FIT\n")
                    continue
                }
                val wFloor = minOf(w, SWEEP_FLOOR_DP)
                val hFloor = minOf(h, SWEEP_FLOOR_DP)
                var mw = w
                while (mw > wFloor && fits(mw - 1, h)) mw--
                var mh = h
                while (mh > hFloor && fits(w, mh - 1)) mh--
                val wText = if (mw == wFloor && mw < w) "<= $mw (floor)" else "$mw"
                val hText = if (mh == hFloor && mh < h) "<= $mh (floor)" else "$mh"
                report.append("${c.name} $lang: contract ${w}x$h, measured width $wText (at $h high), height $hText (at $w wide)\n")
                if (mw > w || mh > h) above += "${c.name} $lang: measured ${mw}x$mh is above the contract ${w}x$h"
            }
        }
        File("build").mkdirs()
        File("build/content-minimums.txt").writeText(report.toString())
        assertTrue(renders > cases.size * languages.size * 20, "the sweep ran: $renders renders")
        assertTrue(above.isEmpty(), above.joinToString("\n"))
    }

    @Test fun moreSheetsShowEverythingWholeAndAreReallyDrawn() {
        // What a compact / icon deck and a compact / icon mixer have no room for is behind MORE (a popup, here in a
        // window wide enough for its full width; phone windows are in MoreSheetWindowTest): its controls and labels
        // must fit too, in both languages and every skin.
        val ctl = busyController()
        class Sheet(val name: String, val w: Int, val h: Int, val content: @Composable (Modifier, Boolean) -> Unit)
        val sheets = listOf(
            Sheet("deck compact", 340, 190) { m, open -> DeckPanel(ctl, 0, m, PanelTier.Compact, initialMore = open) },
            Sheet("deck icon", 220, 110) { m, open -> DeckPanel(ctl, 1, m, PanelTier.Icon, initialMore = open) },
            Sheet("mixer compact", 200, 190) { m, open -> MixerPanel(ctl, m, PanelTier.Compact, initialMore = open) },
            Sheet("mixer icon", 150, 110) { m, open -> MixerPanel(ctl, m, PanelTier.Icon, initialMore = open) },
        )
        val bad = ArrayList<String>()
        for (skin in DecksSkin.presets) for (lang in languages) for (s in sheets) {
            val p = problems(skin, lang, s.w, s.h, canvasW = 520, canvasH = 520) { m -> s.content(m, true) }
            if (p.isNotEmpty()) bad += "${skin.id} $lang: MORE of ${s.name}: " + p.joinToString("; ")
        }
        assertTrue(bad.isEmpty(), "${bad.size} MORE sheets cut something:\n" + bad.joinToString("\n"))
        // An empty list proves nothing if the popup is not part of the rendered scene: the frame with the sheet open
        // must differ from the frame with it closed.
        for (s in sheets) {
            var closed = ByteArray(0)
            var open = ByteArray(0)
            problems(DecksSkin.default, "en", s.w, s.h, canvasW = 520, canvasH = 520, pixels = { closed = it }) { m -> s.content(m, false) }
            problems(DecksSkin.default, "en", s.w, s.h, canvasW = 520, canvasH = 520, pixels = { open = it }) { m -> s.content(m, true) }
            assertTrue(closed.isNotEmpty() && !closed.contentEquals(open), "MORE of ${s.name}: the open sheet is drawn")
        }
    }

    @Test fun aReadoutLineIsExactlyAsHighAsItsLineHeight() {
        // The text engine lays 24 dp digits with `line-height: 1` out 32 dp high (the font's own ascent and descent).
        // LookLine centres that on a line box of the style's line height, so a 24 dp readout row holds 24 dp digits
        // and the row arithmetic of PanelFit.kt is what is drawn.
        val heights = LinkedHashMap<Float, Int>()
        val sizes = listOf(11f, 15f, 18f, 24f, 28f)
        val found = problems(DecksSkin.default, "en", 300, 300) { m ->
            Column(m) {
                for (px in sizes) LookLine("126", LookText.num(px, DecksColors.foreground), Modifier.onSizeChanged { heights[px] = it.height })
            }
        }
        assertEquals(sizes.map { it.toInt() }, sizes.map { heights[it] })
        assertTrue(found.isEmpty(), "a line with room for its line box reports nothing: $found")
        val cut = problems(DecksSkin.default, "en", 300, 300) { m ->
            Box(m) { Box(Modifier.height(20.dp)) { LookLine("126", LookText.num(24f, DecksColors.foreground)) } }
        }
        assertTrue(cut.any { "126" in it }, "24 dp digits in a 20 dp row are reported: $cut")
        // A name that ends in an ellipsis is not a cut; a value that must show whole is.
        val narrow = problems(DecksSkin.default, "en", 300, 300) { m ->
            Column(m) {
                LookLine("A very long track title", LookText.style(12f, DecksColors.foreground), Modifier.width(40.dp), fit = false)
                LookLine("124.00", LookText.num(11f, DecksColors.foreground), Modifier.width(12.dp))
            }
        }
        assertEquals(listOf("text \"124.00\" is cut"), narrow)
    }

    @Test fun theFitProbeSeesAPanelThatIsTooSmall() {
        // The three tests above pass on empty lists: prove the lists fill up when a panel is really squeezed.
        val ctl = busyController()
        val skin = DecksSkin.default
        val deck = problems(skin, "en", 400, 200) { m -> DeckPanel(ctl, 0, m, PanelTier.Full) }
        assertTrue(deck.isNotEmpty(), "a full deck in 400x200 (minimum 480x250) must report")
        // 170×150 would NOT report: the mixer re-arranges (no knob column, no sends) and everything it then draws fits.
        // 108 dp wide leaves 21 dp per channel: under the 24 dp a fader needs, in any arrangement.
        val mixer = problems(skin, "en", 108, 150) { m -> MixerPanel(ctl, m, PanelTier.Full) }
        assertTrue(mixer.any { "needs 24x" in it }, "a full mixer 108 dp wide (minimum 240) must report its faders: $mixer")
        val crossfader = problems(skin, "en", 140, 20) { m -> CrossfaderPanel(ctl, m, PanelTier.Icon) }
        assertTrue(crossfader.isNotEmpty(), "an icon crossfader 20 dp high (minimum 28) must report")
        val library = problems(skin, "en", 150, 96) { m -> LibraryPanel(ctl, {}, m, PanelTier.Compact) }
        assertTrue(library.isNotEmpty(), "a compact library 150 dp wide (minimum 320) must report")
        // Three dp under the measured height of the full deck (243, build/content-minimums.txt): the pads drop under 24 dp.
        val pads = problems(skin, "en", 480, 240) { m -> DeckPanel(ctl, 0, m, PanelTier.Full) }
        assertTrue(pads.any { "needs 24x24" in it }, "pads under 24 dp are reported: $pads")
    }

    /**
     * Renders the real screen at [w] × [h] with the status-bar buttons the desktop app has (set
     * recording, skin, layout, pack import) and returns the layout in use and the solver result it drew.
     */
    private fun solved(skin: DecksSkin, w: Int, h: Int): Pair<LayoutDoc, LayoutSolution> {
        val ctl = controller()
        val skins = SkinState(skin)
        var got: Pair<LayoutDoc, LayoutSolution>? = null
        val scene = ImageComposeScene(w, h, Density(1f)) {
            CompositionLocalProvider(LocalStrings provides DesktopStrings.forLanguage("en")) {
                DecksTheme(reducedMotion = true, skin = skin) {
                    DecksScreen(
                        ctl, autoFocus = false, skins = skins, recordPath = { "set.wav" }, onImportPack = {},
                        onLayoutSolved = { l, s -> got = l to s },
                    )
                }
            }
        }
        var t = 0L
        repeat(4) {
            t += 16_666_667L
            scene.render(t)
        }
        scene.close()
        return got ?: error("the screen never reported a layout")
    }

    @Test fun realScreenOpensOnProAndDrawsDecksAndMixerAboveTheIconTier() {
        for ((w, h) in listOf(1366 to 768, 1920 to 1080)) {
            val (layout, sol) = solved(DecksSkin.default, w, h)
            assertEquals("pro", layout.id, "the default layout on screen")
            assertEquals(DecksSkin.DEFAULT_LAYOUT, layout.id)
            assertTrue(sol.docked.isEmpty(), "nothing docked at ${w}x$h: ${sol.docked}")
            val plan = layoutRender(sol)
            for (p in listOf(PanelId.DeckA, PanelId.DeckB, PanelId.Mixer)) {
                val tier = plan.tier(p)
                assertTrue(tier == PanelTier.Full || tier == PanelTier.Compact, "$p renders $tier at ${w}x$h")
            }
            if (h == 1080) assertEquals(PanelTier.Full, plan.tier(PanelId.DeckA), "full decks on a 1080p window")
            // The pure model used by LayoutTest (window minus the shell chrome) is what the screen really gives.
            val (hw, hh) = layoutHostSize(w.toDouble(), h.toDouble(), DecksSkin.default, layout)
            val model = DemoPacks.solve(layout, hw, hh, NativePanels)
            val real = sol.placements.first { it.panel == PanelId.DeckA }.rect
            val want = model.placements.first { it.panel == PanelId.DeckA }.rect
            assertTrue(kotlin.math.abs(real.h - want.h) <= 1.0 && kotlin.math.abs(real.w - want.w) <= 1.0, "deck A at ${w}x$h: screen $real, model $want")
        }
    }

    @Test fun verticalWavesOnANarrowWindowKeepsAWaveformOnScreen() {
        // Crate's layout: the waves column docks under ~1120 dp; the screen then shows the strip and drops the tab.
        val crate = DecksSkin.presets.first { it.id == "crate" }
        val (layout, sol) = solved(crate, 1000, 800)
        assertTrue(layout.id == "pro-vertical", layout.id)
        assertTrue(PanelId.Waves in sol.docked, "waves is docked at 1000 dp: ${sol.docked}")
        // After the strip appeared the host is shorter by the strip + one row gap than without it.
        val noStrip = layoutHostSize(1000.0, 800.0, crate, layout).second
        val hostH = sol.placements.maxOf { it.rect.y + it.rect.h }
        assertTrue(hostH < noStrip - 80.0, "the strip takes room above the panels: host $hostH dp, without a strip $noStrip dp")
    }
}
