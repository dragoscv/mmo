package ro.mixai.decks.ui.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import java.io.File
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.ComposeWaveforms
import ro.mixai.decks.ui.components.GridMarkersOverlay
import ro.mixai.decks.ui.engine.DecksBackend
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.FfiBackend
import ro.mixai.decks.ui.engine.PackSummaryUi
import ro.mixai.decks.ui.i18n.DesktopStrings
import ro.mixai.decks.ui.i18n.LocalStrings
import ro.mixai.decks.ui.screens.DecksScreen
import ro.mixai.decks.ui.screens.PackNotice
import ro.mixai.decks.ui.theme.DecksTheme
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.SkinState
import ro.mixai.decks.ui.theme.packColorOverrides

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
        FfiBackend(File(dir, "library.sqlite").absolutePath, packsDir = File(dir, "packs").absolutePath)
    } catch (t: Throwable) {
        System.err.println("[decks] native engine unavailable, demo engine: $t")
        DemoBackend { System.nanoTime() / 1e9 }
    }

    fun language(): String = System.getProperty("decks.lang") ?: Locale.getDefault().language

    /** Recordings and tracklist exports: `~/Music/MixAI Decks` (`-Ddecks.recordDir` overrides). */
    fun recordDir(): File =
        File(System.getProperty("decks.recordDir") ?: File(System.getProperty("user.home"), "Music/MixAI Decks").path).apply { mkdirs() }

    fun newRecordPath(): String {
        val stamp = java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd_HH-mm"))
        return File(recordDir(), "set_$stamp.wav").absolutePath
    }

    /** Writes the export next to the latest recording (`set_<stamp>.<ext>`); returns the file. */
    fun saveExport(wavPath: String?, ext: String, content: String): File {
        val base = wavPath?.let { File(it).nameWithoutExtension } ?: "tracklist"
        return File(recordDir(), "$base.$ext").apply { writeText(content, Charsets.UTF_8) }
    }

    /** Skin persisted in java.util.prefs (`ro/mixai/decks` → `skin`); `-Ddecks.skin=<id>` overrides. */
    fun skinState(): SkinState {
        val prefs = java.util.prefs.Preferences.userRoot().node("ro/mixai/decks")
        val initial = System.getProperty("decks.skin")?.let { DecksSkin.decode("id=$it") } ?: DecksSkin.decode(prefs.get("skin", null))
        return SkinState(initial) { prefs.put("skin", it.encode()) }
    }

    /**
     * File chooser for `.mixaipack` → verify + install through decks-ffi. A skin/bundle pack becomes
     * the colour source of the active skin. Returns the pack name, or null (cancelled / rejected,
     * the English reason goes to [error]).
     */
    fun importPack(backend: DecksBackend, skins: SkinState, error: (String) -> Unit = {}): String? {
        val f = choosePack() ?: return null
        val info = installPack(f, backend, error) ?: return null
        applyInstalled(info, skins)
        return info.name
    }

    /** Modal `.mixaipack` chooser; must run on the EDT. Null = cancelled. */
    fun choosePack(): File? {
        val dialog = java.awt.FileDialog(null as java.awt.Frame?, "MixAI pack", java.awt.FileDialog.LOAD).apply {
            setFilenameFilter { _, name -> name.endsWith(".mixaipack", ignoreCase = true) }
            file = "*.mixaipack"
            isVisible = true
        }
        val name = dialog.file ?: return null
        return File(dialog.directory, name)
    }

    /**
     * Blocking half: read (≤ 25 MB) + Rust verify/install. Run on [Dispatchers.IO], never on the
     * EDT (WP19-40 P1-17) — a 25 MB read plus signature checks froze the window.
     */
    fun installPack(f: File, backend: DecksBackend, error: (String) -> Unit = {}): PackSummaryUi? {
        val port = backend.packs() ?: return null.also { error("packs unavailable (demo engine)") }
        if (f.length() > 25L * 1024 * 1024) return null.also { error("pack is larger than 25 MB") }
        val bytes = try {
            f.readBytes()
        } catch (e: java.io.IOException) {
            error(e.message ?: "cannot read the file")
            return null
        }
        return port.install(bytes) ?: null.also { error(port.lastError ?: "rejected") }
    }

    /** UI half: re-read pack layouts/colours and make a skin pack the active one. */
    fun applyInstalled(info: PackSummaryUi, skins: SkinState) {
        skins.packsChanged()
        if (info.kind == "skin" || info.kind == "bundle") skins.select(skins.skin.copy(packId = info.id))
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

    /**
     * File or folder chooser for the import panel (WP19-38): a Serato `_Serato_` folder and the
     * relocation roots are directories, rekordbox XML / NML / PDB are files, so the chooser accepts
     * both (Swing `JFileChooser`, FILES_AND_DIRECTORIES).
     */
    fun pickImportPath(onPicked: (String) -> Unit) {
        val chooser = javax.swing.JFileChooser().apply {
            fileSelectionMode = javax.swing.JFileChooser.FILES_AND_DIRECTORIES
            dialogTitle = "MixAI Decks"
        }
        if (chooser.showOpenDialog(null) == javax.swing.JFileChooser.APPROVE_OPTION) {
            chooser.selectedFile?.absolutePath?.let(onPicked)
        }
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
    val packColors = remember(state.skin.packId, state.packRevision) { packColorOverrides(backend.packs(), state.skin.packId) }
    val scope = rememberCoroutineScope()
    var packNotice by remember { mutableStateOf<PackNotice?>(null) }
    CompositionLocalProvider(LocalStrings provides DesktopStrings.forLanguage(lang)) {
        DecksTheme(reducedMotion, state.skin, packColors) {
            DecksScreen(
                ctl,
                waveforms = { frame, peaks, modifier ->
                    if (backend is FfiBackend && waveMode != WaveMode.COMPOSE) {
                        androidx.compose.foundation.layout.Box(modifier) {
                            DesktopWaveforms(backend, waveMode, frame, peaks, androidx.compose.ui.Modifier.matchParentSize())
                            // decks-render only knows a constant grid: markers / fixed bar on top (P1-18).
                            GridMarkersOverlay(frame, androidx.compose.ui.Modifier.matchParentSize())
                        }
                    } else {
                        ComposeWaveforms(frame, peaks, modifier)
                    }
                },
                onScanFolder = onScanFolder,
                skins = state,
                recordPath = DesktopDecks::newRecordPath,
                onExport = { ext, content -> DesktopDecks.saveExport(ctl.lastSetWav, ext, content) },
                // Chooser on the EDT (modal AWT dialog), read + verify on IO, result shown (P1-17).
                onImportPack = if (backend.packs() != null) ({
                    DesktopDecks.choosePack()?.let { f ->
                        scope.launch {
                            var reason = "rejected"
                            val info = withContext(Dispatchers.IO) { DesktopDecks.installPack(f, backend) { reason = it } }
                            if (info == null) {
                                System.err.println("[decks] pack rejected: $reason")
                                packNotice = PackNotice.Rejected(reason)
                            } else {
                                DesktopDecks.applyInstalled(info, state)
                                packNotice = PackNotice.Installed(info.name)
                            }
                        }
                    }
                }) else null,
                packNotice = packNotice,
                onDismissPackNotice = { packNotice = null },
                pickFile = { cb -> DesktopDecks.pickImportPath(cb) },
            )
        }
    }
}
