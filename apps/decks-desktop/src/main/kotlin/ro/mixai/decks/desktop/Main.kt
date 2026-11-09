package ro.mixai.decks.desktop

import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import java.io.File
import javax.swing.JFileChooser
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.desktop.DecksDesktopRoot
import ro.mixai.decks.ui.desktop.DesktopDecks
import ro.mixai.decks.ui.desktop.DesktopMidi
import ro.mixai.decks.ui.desktop.waveModeFromEnv
import ro.mixai.decks.ui.i18n.DesktopStrings

/**
 * MixAI Decks desktop entry point. System properties:
 *  - `decks.lang` (en | ro, default = OS locale), `decks.reducedMotion` (true/false, default = OS)
 *  - `decks.waveform` (native | headless | compose), `decks.ffi.path` (host decks_ffi library)
 */
fun main() {
    val backend = DesktopDecks.createBackend()
    val ctl = DecksController(backend)
    val midi = DesktopMidi(ctl).also { it.start() }
    val lang = DesktopDecks.language()
    val reduced = DesktopDecks.reducedMotion()
    val waveMode = waveModeFromEnv()
    val title = DesktopStrings.forLanguage(lang)["app_name"] ?: "MixAI Decks"

    application {
        Window(
            onCloseRequest = {
                midi.close()
                backend.close()
                exitApplication()
            },
            title = title,
            state = rememberWindowState(size = DpSize(1440.dp, 900.dp)),
        ) {
            DecksDesktopRoot(ctl, lang, reduced, waveMode) {
                val chooser = JFileChooser(File(System.getProperty("user.home"), "Music")).apply {
                    fileSelectionMode = JFileChooser.DIRECTORIES_ONLY
                    dialogTitle = DesktopStrings.forLanguage(lang)["scan_folder"]
                }
                if (chooser.showOpenDialog(window) == JFileChooser.APPROVE_OPTION) {
                    ctl.scanFolder(chooser.selectedFile.absolutePath)
                }
            }
        }
    }
}
