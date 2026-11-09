package ro.mixai.decks.ui.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import java.io.File
import java.util.Locale
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.ComposeWaveforms
import ro.mixai.decks.ui.engine.DecksBackend
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.FfiBackend
import ro.mixai.decks.ui.i18n.DesktopStrings
import ro.mixai.decks.ui.i18n.LocalStrings
import ro.mixai.decks.ui.screens.DecksScreen
import ro.mixai.decks.ui.theme.DecksTheme
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.SkinState

object DesktopDecks {
    /**
     * Points UniFFI at the host decks_ffi library: explicit `decks.ffi.path`, else the file next to
     * the app resources (`compose.application.resources.dir`), else JNA's default search.
     */
    fun configureLibrary() {
        val key = "uniffi.component.decks_ffi.libraryOverride"
        if (System.getProperty(key) != null) return
        val name = System.mapLibraryName("decks_ffi")
        val candidates = listOfNotNull(
            System.getProperty("decks.ffi.path"),
            System.getProperty("compose.application.resources.dir")?.let { File(it, name).path },
        )
        candidates.firstOrNull { File(it).isFile }?.let { System.setProperty(key, File(it).absolutePath) }
    }

    fun createBackend(): DecksBackend = try {
        configureLibrary()
        val dir = File(System.getProperty("user.home"), ".mixai-decks").apply { mkdirs() }
        FfiBackend(File(dir, "library.sqlite").absolutePath)
    } catch (t: Throwable) {
        System.err.println("[decks] native engine unavailable, demo engine: $t")
        DemoBackend { System.nanoTime() / 1e9 }
    }

    fun language(): String = System.getProperty("decks.lang") ?: Locale.getDefault().language

    /** Skin persisted in java.util.prefs (`ro/mixai/decks` → `skin`); `-Ddecks.skin=<id>` overrides. */
    fun skinState(): SkinState {
        val prefs = java.util.prefs.Preferences.userRoot().node("ro/mixai/decks")
        val initial = System.getProperty("decks.skin")?.let { DecksSkin.decode("id=$it") } ?: DecksSkin.decode(prefs.get("skin", null))
        return SkinState(initial) { prefs.put("skin", it.encode()) }
    }

    /** Windows "show animations" off / GNOME enable-animations false → reduced motion. */
    fun reducedMotion(): Boolean {
        System.getProperty("decks.reducedMotion")?.let { return it.toBoolean() }
        val os = System.getProperty("os.name").lowercase()
        return runCatching {
            if (os.contains("win")) {
                val p = ProcessBuilder("reg", "query", "HKCU\\Control Panel\\Desktop\\WindowMetrics", "/v", "MinAnimate")
                    .redirectErrorStream(true).start()
                val out = p.inputStream.bufferedReader().readText()
                p.waitFor()
                Regex("MinAnimate\\s+REG_SZ\\s+0").containsMatchIn(out)
            } else {
                val p = ProcessBuilder("gsettings", "get", "org.gnome.desktop.interface", "enable-animations")
                    .redirectErrorStream(true).start()
                val out = p.inputStream.bufferedReader().readText().trim()
                p.waitFor()
                out == "false"
            }
        }.getOrDefault(false)
    }
}

@Composable
fun DecksDesktopRoot(
    ctl: DecksController, lang: String, reducedMotion: Boolean, waveMode: WaveMode,
    skins: SkinState? = null,
    onScanFolder: () -> Unit,
) {
    val backend = ctl.backend
    val state = skins ?: remember { SkinState(DecksSkin.default) }
    CompositionLocalProvider(LocalStrings provides DesktopStrings.forLanguage(lang)) {
        DecksTheme(reducedMotion, state.skin) {
            DecksScreen(
                ctl,
                waveforms = { frame, peaks, modifier ->
                    if (backend is FfiBackend && waveMode != WaveMode.COMPOSE) DesktopWaveforms(backend, waveMode, frame, peaks, modifier)
                    else ComposeWaveforms(frame, peaks, modifier)
                },
                onScanFolder = onScanFolder,
                skins = state,
            )
        }
    }
}
