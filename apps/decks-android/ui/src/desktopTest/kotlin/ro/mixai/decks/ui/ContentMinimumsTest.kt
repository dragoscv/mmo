package ro.mixai.decks.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.LayoutDoc
import ro.mixai.decks.ui.engine.LayoutSolution
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.i18n.DesktopStrings
import ro.mixai.decks.ui.i18n.LocalStrings
import ro.mixai.decks.ui.screens.CROSSFADER_FADER_ONLY_DP
import ro.mixai.decks.ui.screens.CrossfaderPanel
import ro.mixai.decks.ui.screens.DeckPanel
import ro.mixai.decks.ui.screens.DecksScreen
import ro.mixai.decks.ui.screens.MixerPanel
import ro.mixai.decks.ui.screens.NativePanels
import ro.mixai.decks.ui.screens.contentMinimum
import ro.mixai.decks.ui.screens.layoutHostSize
import ro.mixai.decks.ui.screens.layoutRender
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.DecksTheme
import ro.mixai.decks.ui.theme.SkinState

/**
 * The content minimums of LayoutHost (`contentMinimum`) are claims about what the Compose panels
 * need; this test MEASURES the real panels (natural size, no height limit) for every preset skin,
 * and renders the real screen to check the tiers the default layout ends up with.
 */
class ContentMinimumsTest {
    private fun controller(): DecksController {
        val ctl = DecksController(DemoBackend { 0.0 })
        ctl.startEngine()
        ctl.loadToDeck(0, DemoBackend.DEMO_TRACKS[0])
        ctl.loadToDeck(1, DemoBackend.DEMO_TRACKS[1])
        repeat(6) { ctl.tick() }
        return ctl
    }

    /** Natural size (dp at density 1) of [content]; [width] fixes the width, the height is never limited. */
    private fun natural(skin: DecksSkin, width: Int?, content: @Composable () -> Unit): IntSize {
        var size = IntSize.Zero
        val scene = ImageComposeScene(2400, 2400, Density(1f)) {
            CompositionLocalProvider(LocalStrings provides DesktopStrings.forLanguage("en")) {
                DecksTheme(reducedMotion = true, skin = skin) {
                    Box(
                        Modifier.wrapContentSize(Alignment.TopStart, unbounded = true)
                            .then(if (width != null) Modifier.width(width.dp) else Modifier)
                            .onSizeChanged { size = it },
                    ) { content() }
                }
            }
        }
        scene.render(0)
        scene.close()
        return size
    }

    @Test fun panelContentFitsTheMinimumsLayoutHostClaims() {
        val ctl = controller()
        val report = StringBuilder()
        val bad = ArrayList<String>()
        fun check(what: String, got: IntSize, min: Pair<Double, Double>, widthToo: Boolean) {
            report.append("$what: ${got.width}x${got.height} (minimum ${min.first.toInt()}x${min.second.toInt()})\n")
            if (got.height > min.second || (widthToo && got.width > min.first)) bad += "$what needs ${got.width}x${got.height}, minimum says ${min.first.toInt()}x${min.second.toInt()}"
        }
        for (skin in DecksSkin.presets) for (tier in listOf(PanelTier.Full, PanelTier.Compact)) {
            val deck = contentMinimum(PanelId.DeckA, tier)!!
            check("${skin.id} deck $tier", natural(skin, deck.first.toInt()) { DeckPanel(ctl, 0, Modifier, tier) }, deck, widthToo = false)
            val mixer = contentMinimum(PanelId.Mixer, tier)!!
            check("${skin.id} mixer $tier", natural(skin, null) { MixerPanel(ctl, Modifier, tier) }, mixer, widthToo = true)
            val cf = contentMinimum(PanelId.Crossfader, tier)!!
            check("${skin.id} crossfader $tier", natural(skin, cf.first.toInt()) { CrossfaderPanel(ctl, Modifier, tier) }, cf, widthToo = false)
        }
        for (skin in DecksSkin.presets) {
            check("${skin.id} crossfader Icon", natural(skin, 180) { CrossfaderPanel(ctl, Modifier, PanelTier.Icon) }, 180.0 to CROSSFADER_FADER_ONLY_DP, widthToo = false)
        }
        File("build").mkdirs()
        File("build/content-minimums.txt").writeText(report.toString())
        assertTrue(bad.isEmpty(), "${bad.size} panel(s) need more room than contentMinimum says:\n" + bad.joinToString("\n"))
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

    @Test fun realScreenRendersTheDefaultLayoutAboveTheIconTier() {
        for ((w, h) in listOf(1366 to 768, 1920 to 1080)) {
            val (layout, sol) = solved(DecksSkin.default, w, h)
            assertTrue(layout.id == DecksSkin.DEFAULT_LAYOUT, "default layout on screen, got ${layout.id}")
            val plan = layoutRender(sol)
            for (p in listOf(PanelId.DeckA, PanelId.DeckB, PanelId.Mixer)) {
                val tier = plan.tier(p)
                assertTrue(tier == PanelTier.Full || tier == PanelTier.Compact, "$p renders $tier at ${w}x$h")
            }
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
