package ro.mixai.decks.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue
import org.jetbrains.skia.EncodedImageFormat
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.DemoPacks
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
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.DecksTheme
import ro.mixai.decks.ui.theme.DecksSkin

/**
 * Headless renders to PNG (demo engine, two decks loaded, deck A playing): the full Decks screen, and
 * every panel alone in the minimum box of each tier. Output dir: system property `decks.shotDir`
 * (defaults to build/screenshots). These are for looking at; what must hold is asserted in
 * ContentMinimumsTest.
 */
class ScreenshotTest {
    private val dir: File get() = File(System.getProperty("decks.shotDir") ?: "build/screenshots").apply { mkdirs() }

    /** Two decks loaded; deck A plays with a hot cue, deck B has a lower tempo and a 4-beat loop. */
    private fun scene(clock: () -> Double): DecksController {
        val ctl = DecksController(DemoBackend(clock))
        ctl.startEngine()
        ctl.loadToDeck(0, DemoBackend.DEMO_TRACKS[0])
        ctl.loadToDeck(1, DemoBackend.DEMO_TRACKS[1])
        repeat(6) { ctl.tick() }
        ctl.togglePlay(0)
        ctl.hotCue(0, 0)
        ctl.setTempoFader(1, -0.2f)
        ctl.dispatch(ro.mixai.decks.ui.model.MidiAction("deck", "auto_loop", deck = 1, pressed = true, beats = 4.0))
        return ctl
    }

    private fun shot(lang: String, width: Int, height: Int, name: String, skin: DecksSkin = DecksSkin.default, frames: Int = 40) {
        var now = 0.0
        val ctl = scene { now }
        val scene = ImageComposeScene(width, height, Density(1f)) {
            CompositionLocalProvider(LocalStrings provides DesktopStrings.forLanguage(lang)) {
                DecksTheme(reducedMotion = false, skin = skin) { DecksScreen(ctl, autoFocus = false) }
            }
        }
        var t = 0L
        repeat(frames) {
            now += 1.0 / 60
            t += 16_666_667L
            scene.render(t)
        }
        val img = scene.render(t + 16_666_667L)
        val out = File(dir, name)
        out.writeBytes(img.encodeToData(EncodedImageFormat.PNG)!!.bytes)
        scene.close()
        assertTrue(out.length() > 10_000, "screenshot too small: ${out.length()}")
    }

    @Test fun wideEnglish() = shot("en", 1600, 1000, "decks-desktop-en.png")

    @Test fun narrowRomanian() = shot("ro", 480, 1000, "decks-phone-ro.png")

    @Test fun everySkin() {
        for (s in DecksSkin.presets) shot("en", 1600, 1000, "decks-skin-${s.id}.png", s)
    }

    /** The default layout (Pro) for every preset skin on a laptop and a full-HD window. */
    @Test fun proOnLaptopAndFullHdPerSkin() {
        for (s in DecksSkin.presets) for ((w, h) in listOf(1366 to 768, 1920 to 1080)) {
            shot("en", w, h, "decks-pro-${s.id}-${w}x$h.png", s.copy(layoutId = "pro"), frames = 12)
        }
        // Romanian on the laptop size: the longest labels in the tightest default boxes.
        shot("ro", 1366, 768, "decks-pro-signature-1366x768-ro.png", DecksSkin.default, frames = 12)
    }

    /**
     * Renders [content] alone in a [w] × [h] dp box at 2 px per dp (a 12 dp margin on the window background).
     * [canvasW] × [canvasH] = the window in dp, larger than the box when a popup of the panel needs room.
     */
    private fun panelShot(
        name: String, skin: DecksSkin, lang: String, w: Int, h: Int,
        canvasW: Int = w + 24, canvasH: Int = h + 24, content: @Composable (Modifier) -> Unit,
    ) {
        val scene = ImageComposeScene(canvasW * 2, canvasH * 2, Density(2f)) {
            CompositionLocalProvider(LocalStrings provides DesktopStrings.forLanguage(lang)) {
                DecksTheme(reducedMotion = true, skin = skin) {
                    Box(Modifier.fillMaxSize().background(DecksColors.background).padding(12.dp)) {
                        Box(Modifier.size(w.dp, h.dp)) { content(Modifier.fillMaxSize()) }
                    }
                }
            }
        }
        scene.render(0)
        val img = scene.render(16_666_667L)
        val out = File(File(dir, "panels").apply { mkdirs() }, name)
        out.writeBytes(img.encodeToData(EncodedImageFormat.PNG)!!.bytes)
        scene.close()
        assertTrue(out.length() > 1_000, "panel shot too small: ${out.length()}")
    }

    /** Every panel in the minimum box of each tier (`PANEL_SPECS`), and in the boxes Pro gives on a laptop window. */
    @Test fun panelsAtTheirMinimumBoxes() {
        var now = 0.0
        val ctl = scene { now }
        // Deck A: a few more hot cues, key lock, a running loop; deck B in the headphones; one track already played.
        for (slot in 1..4) {
            now += 21.0
            ctl.tick()
            ctl.hotCue(0, slot)
        }
        ctl.toggleKeyLock(0)
        ctl.togglePfl(1)
        ctl.setEq(0, ro.mixai.decks.ui.engine.Band.LOW, -9f)
        ctl.setFilter(1, 0.4f)
        ctl.changeCrossfader(-0.35f)
        ctl.tick()
        val played = setOf(DemoBackend.DEMO_TRACKS[2].id)
        fun min(id: PanelId, t: PanelTier) = DemoPacks.specs.getValue(id).min(t).let { it.first.toInt() to it.second.toInt() }
        val skin = DecksSkin.default
        for (t in PanelTier.entries) {
            val key = t.key
            min(PanelId.DeckA, t).let { (w, h) ->
                panelShot("deckA-$key-min.png", skin, "en", w, h) { m -> DeckPanel(ctl, 0, m, t) }
                panelShot("deckB-$key-min-ro.png", skin, "ro", w, h) { m -> DeckPanel(ctl, 1, m, t) }
            }
            min(PanelId.Mixer, t).let { (w, h) -> panelShot("mixer-$key-min.png", skin, "en", w, h) { m -> MixerPanel(ctl, m, t) } }
            min(PanelId.Crossfader, t).let { (w, h) -> panelShot("crossfader-$key-min.png", skin, "en", w, h) { m -> CrossfaderPanel(ctl, m, t) } }
            min(PanelId.Library, t).let { (w, h) -> panelShot("library-$key-min.png", skin, "en", w, h) { m -> LibraryPanel(ctl, {}, m, t, initialPlayed = played) } }
        }
        panelShot("deckA-full-min-loops.png", skin, "en", 480, 250) { m -> DeckPanel(ctl, 0, m, PanelTier.Full, initialTab = DeckTab.Loops) }
        // The MORE sheets (popups): what the compact / icon deck and the compact mixer have no room for inline.
        panelShot("deckA-compact-min-more.png", skin, "en", 340, 190, canvasW = 460, canvasH = 440) { m -> DeckPanel(ctl, 0, m, PanelTier.Compact, initialMore = true) }
        panelShot("deckB-icon-min-more-ro.png", skin, "ro", 220, 110, canvasW = 460, canvasH = 360) { m -> DeckPanel(ctl, 1, m, PanelTier.Icon, initialMore = true) }
        panelShot("mixer-compact-min-more.png", skin, "en", 200, 190, canvasW = 380, canvasH = 440) { m -> MixerPanel(ctl, m, PanelTier.Compact, initialMore = true) }
        // The same sheets in a phone-wide window (360 and 320 dp): the sheet is the window minus a margin and its rows wrap.
        panelShot("deckB-icon-more-360-ro.png", skin, "ro", 220, 110, canvasW = 360, canvasH = 430) { m -> DeckPanel(ctl, 1, m, PanelTier.Icon, initialMore = true) }
        panelShot("deckB-icon-more-320-ro.png", skin, "ro", 220, 110, canvasW = 320, canvasH = 500) { m -> DeckPanel(ctl, 1, m, PanelTier.Icon, initialMore = true) }
        panelShot("mixer-icon-more-320-ro.png", skin, "ro", 150, 110, canvasW = 320, canvasH = 320) { m -> MixerPanel(ctl, m, PanelTier.Icon, initialMore = true) }
        // The icon library in Romanian (crate steps, short search, glyph scan, A / B) and the touch rows (48 dp).
        panelShot("library-icon-min-ro.png", skin, "ro", 200, 96) { m -> LibraryPanel(ctl, {}, m, PanelTier.Icon, initialPlayed = played) }
        panelShot("library-compact-touch.png", skin, "en", 320, 160) { m -> LibraryPanel(ctl, {}, m, PanelTier.Compact, initialPlayed = played, touch = true) }
        // Pro on a 1366×768 window: decks 552×239 (compact tier), mixer 241×203, crossfader 241×33; on 1920×1080: 780×349, 341×297.
        panelShot("deckA-pro-laptop.png", skin, "en", 552, 239) { m -> DeckPanel(ctl, 0, m, PanelTier.Compact) }
        panelShot("mixer-pro-laptop.png", skin, "en", 241, 203) { m -> MixerPanel(ctl, m, PanelTier.Compact) }
        panelShot("crossfader-pro-laptop.png", skin, "en", 241, 33) { m -> CrossfaderPanel(ctl, m, PanelTier.Icon) }
        panelShot("deckA-pro-fullhd.png", skin, "en", 780, 349) { m -> DeckPanel(ctl, 0, m, PanelTier.Full) }
        panelShot("mixer-pro-fullhd.png", skin, "en", 341, 297) { m -> MixerPanel(ctl, m, PanelTier.Full) }
        // The look-alike skins and the classic look on the full deck and mixer.
        for (id in listOf("mainroom", "crate", "pilot", "glass-classic", "studio")) {
            val s = DecksSkin.presets.first { it.id == id }
            panelShot("deckA-full-min-$id.png", s, "en", 480, 250) { m -> DeckPanel(ctl, 0, m, PanelTier.Full) }
            panelShot("mixer-full-min-$id.png", s, "en", 240, 250) { m -> MixerPanel(ctl, m, PanelTier.Full) }
        }
    }
}
