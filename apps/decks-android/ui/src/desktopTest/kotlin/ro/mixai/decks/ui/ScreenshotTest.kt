package ro.mixai.decks.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.unit.Density
import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue
import org.jetbrains.skia.EncodedImageFormat
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.i18n.DesktopStrings
import ro.mixai.decks.ui.i18n.LocalStrings
import ro.mixai.decks.ui.screens.DecksScreen
import ro.mixai.decks.ui.theme.DecksTheme

/**
 * Headless render of the full Decks screen (demo engine, two decks loaded, playing) to PNG.
 * Output dir: system property `decks.shotDir` (defaults to build/screenshots).
 */
class ScreenshotTest {
    private fun shot(lang: String, width: Int, height: Int, name: String) {
        var now = 0.0
        val ctl = DecksController(DemoBackend { now })
        ctl.startEngine()
        ctl.loadToDeck(0, DemoBackend.DEMO_TRACKS[0])
        ctl.loadToDeck(1, DemoBackend.DEMO_TRACKS[1])
        repeat(6) { ctl.tick() }
        ctl.togglePlay(0)
        ctl.hotCue(0, 0)
        ctl.setTempoFader(1, -0.2f)
        ctl.dispatch(ro.mixai.decks.ui.model.MidiAction("deck", "auto_loop", deck = 1, pressed = true, beats = 4.0))
        val scene = ImageComposeScene(width, height, Density(1f)) {
            CompositionLocalProvider(LocalStrings provides DesktopStrings.forLanguage(lang)) {
                DecksTheme(reducedMotion = false) { DecksScreen(ctl, autoFocus = false) }
            }
        }
        var t = 0L
        repeat(40) {
            now += 1.0 / 60
            t += 16_666_667L
            scene.render(t)
        }
        val img = scene.render(t + 16_666_667L)
        val dir = File(System.getProperty("decks.shotDir") ?: "build/screenshots").apply { mkdirs() }
        val out = File(dir, name)
        out.writeBytes(img.encodeToData(EncodedImageFormat.PNG)!!.bytes)
        scene.close()
        assertTrue(out.length() > 10_000, "screenshot too small: ${out.length()}")
    }

    @Test fun wideEnglish() = shot("en", 1600, 1000, "decks-desktop-en.png")

    @Test fun narrowRomanian() = shot("ro", 480, 1000, "decks-phone-ro.png")
}
