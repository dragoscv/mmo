package ro.mixai.decks.ui.platform

import android.content.Context
import android.provider.Settings
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.engine.DecksBackend
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.FfiBackend
import ro.mixai.decks.ui.i18n.LocalStrings
import ro.mixai.decks.ui.i18n.StringTable
import ro.mixai.decks.ui.screens.DecksScreen
import ro.mixai.decks.ui.screens.PackNotice
import ro.mixai.decks.ui.theme.DecksTheme
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.SkinState
import ro.mixai.decks.ui.theme.packColorOverrides

object AndroidDecks {
    /** Native engine (libdecks_ffi.so via JNA); the demo engine when the library cannot load. */
    fun createBackend(context: Context): DecksBackend = try {
        ro.mixai.decks.ffi.DecksAndroid.init(context)
        FfiBackend(
            context.filesDir.resolve("decks-library.sqlite").absolutePath,
            packsDir = context.filesDir.resolve("packs").absolutePath,
        )
    } catch (t: Throwable) {
        Log.e("Decks", "native engine unavailable, demo engine", t)
        DemoBackend { System.nanoTime() / 1e9 }
    }

    /** OS "remove animations" / animator scale 0 → reduced motion. */
    fun reducedMotion(context: Context): Boolean =
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

    /**
     * Touch input ([ro.mixai.decks.ui.theme.LocalTouchInput]): the device has a touch screen. The manifest marks
     * the feature as not required, so the app also installs on TV boxes and mouse-only Chromebooks: false there.
     */
    fun touchInput(context: Context): Boolean =
        context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_TOUCHSCREEN)

    /**
     * SAF tree → plain path for the Rust reader: `primary:Music/Sets` →
     * `/storage/emulated/0/Music/Sets`, other volumes → `/storage/<id>/…` (same rule as the
     * activity's scan-folder picker).
     */
    fun treePath(uri: android.net.Uri): String? {
        val id = runCatching { android.provider.DocumentsContract.getTreeDocumentId(uri) }.getOrNull() ?: return null
        val vol = id.substringBefore(':')
        val rel = id.substringAfter(':', "")
        val base = if (vol.equals("primary", true)) {
            android.os.Environment.getExternalStorageDirectory().absolutePath
        } else {
            "/storage/$vol"
        }
        return if (rel.isEmpty()) base else "$base/$rel"
    }

    /** Skin persisted in SharedPreferences `decks` / `skin` ([DecksSkin.encode]). */
    fun skinState(context: Context): SkinState {
        val prefs = context.getSharedPreferences("decks", Context.MODE_PRIVATE)
        return SkinState(DecksSkin.decode(prefs.getString("skin", null))) { prefs.edit().putString("skin", it.encode()).apply() }
    }

    /**
     * Install a `.mixaipack` picked with SAF (`ActivityResultContracts.OpenDocument`, MIME
     * `application/octet-stream` / `application/zip`). A skin pack becomes the active skin's colour
     * source; returns the pack name, or null with the English reason in [error].
        *
        * Reads up to 25 MB and verifies it in Rust: blocking, so it must run on [Dispatchers.IO],
        * never on Main (WP19-40 P1-17). [DecksAndroidRoot] does that.
     */
    fun importPack(context: Context, uri: android.net.Uri, backend: DecksBackend, skins: SkinState, error: (String) -> Unit = {}): String? {
        val info = installPack(context, uri, backend, error) ?: return null
        applyInstalled(info, skins)
        return info.name
    }

    /** Blocking half of [importPack]: read (≤ 25 MB) + Rust verify/install. Run on [Dispatchers.IO]. */
    fun installPack(
        context: Context, uri: android.net.Uri, backend: DecksBackend, error: (String) -> Unit = {},
    ): ro.mixai.decks.ui.engine.PackSummaryUi? {
        val port = backend.packs() ?: return null.also { error("packs unavailable (demo engine)") }
        val cap = 25 * 1024 * 1024 // decks-packs MAX_ARCHIVE_BYTES: never read an unbounded stream.
        val bytes = runCatching {
            context.contentResolver.openInputStream(uri)?.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(64 * 1024)
                while (out.size() <= cap) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    out.write(chunk, 0, n)
                }
                out.toByteArray().takeIf { it.size <= cap }
            }
        }.getOrNull() ?: return null.also { error("cannot read the file or it is larger than 25 MB") }
        return port.install(bytes) ?: null.also { error(port.lastError ?: "rejected") }
    }

    /** UI half of [importPack]: re-read pack layouts/colours and make a skin pack the active one. */
    fun applyInstalled(info: ro.mixai.decks.ui.engine.PackSummaryUi, skins: SkinState) {
        skins.packsChanged()
        if (info.kind == "skin" || info.kind == "bundle") skins.select(skins.skin.copy(packId = info.id))
    }

    /** New WAV path in the app's Music dir (no storage permission needed). */
    fun newRecordPath(context: Context): String {
        val dir = (context.getExternalFilesDir(android.os.Environment.DIRECTORY_MUSIC) ?: context.filesDir).resolve("sets").apply { mkdirs() }
        val stamp = java.text.SimpleDateFormat("yyyy-MM-dd_HH-mm", java.util.Locale.ROOT).format(java.util.Date())
        return dir.resolve("set_$stamp.wav").absolutePath
    }

    /** Share a tracklist export as text (Mixcloud / notes / email / ORDA submission). */
    fun shareExport(context: Context, ext: String, content: String) {
        val mime = when (ext) { "csv" -> "text/csv"; "json" -> "application/json"; else -> "text/plain" }
        val send = android.content.Intent(android.content.Intent.ACTION_SEND)
            .setType(mime)
            .putExtra(android.content.Intent.EXTRA_TEXT, content)
            .putExtra(android.content.Intent.EXTRA_SUBJECT, "tracklist.$ext")
        context.startActivity(android.content.Intent.createChooser(send, null).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

@Composable
fun DecksAndroidRoot(
    ctl: DecksController, strings: StringTable, reducedMotion: Boolean, onScanFolder: () -> Unit, skins: SkinState? = null,
    recordPath: (() -> String)? = null, onExport: (String, String) -> Unit = { _, _ -> },
    onImportPack: (() -> Unit)? = null,
) {
    val backend = ctl.backend
    val state = skins ?: remember { SkinState(DecksSkin.default) }
    val packColors = remember(state.skin.packId, state.packRevision) { packColorOverrides(backend.packs(), state.skin.packId) }
    val context = androidx.compose.ui.platform.LocalContext.current
    var packNotice by remember { mutableStateOf<PackNotice?>(null) }
    // The picked uri, handled by a LaunchedEffect: reading + verifying a 25 MB pack is blocking
    // and must not run on Main (P1-17). The result is shown, not only logged.
    var pendingPack by remember { mutableStateOf<android.net.Uri?>(null) }
    val picker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument(),
    ) { uri ->
        pendingPack = uri
    }
    LaunchedEffect(pendingPack) {
        val uri = pendingPack ?: return@LaunchedEffect
        pendingPack = null
        var reason = "rejected"
        val info = withContext(Dispatchers.IO) {
            AndroidDecks.installPack(context, uri, backend) { reason = it }
        }
        if (info == null) {
            Log.w("Decks", "pack rejected: $reason")
            packNotice = PackNotice.Rejected(reason)
        } else {
            AndroidDecks.applyInstalled(info, state)
            packNotice = PackNotice.Installed(info.name)
        }
    }
    val importPack = onImportPack ?: if (backend.packs() != null) ({ picker.launch(arrayOf("application/octet-stream", "application/zip")) }) else null
    // Import (WP19-38) and relocation folders: one SAF tree picker; the Rust reader takes plain
    // paths, so a tree is mapped the same way as a scan folder.
    var pendingPick by remember { mutableStateOf<((String) -> Unit)?>(null) }
    val treePicker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree(),
    ) { uri ->
        val cb = pendingPick
        pendingPick = null
        if (uri != null && cb != null) AndroidDecks.treePath(uri)?.let(cb)
    }
    val touch = remember(context) { AndroidDecks.touchInput(context) }
    CompositionLocalProvider(LocalStrings provides strings, ro.mixai.decks.ui.theme.LocalTouchInput provides touch) {
        DecksTheme(reducedMotion, state.skin, packColors) {
            DecksScreen(
                ctl,
                waveforms = { frame, peaks, modifier ->
                    if (backend is FfiBackend) {
                        androidx.compose.foundation.layout.Box(modifier) {
                            GpuWaveforms(backend, frame, peaks, androidx.compose.ui.Modifier.matchParentSize())
                            // decks-render only knows a constant grid: markers / fixed bar on top (P1-18).
                            ro.mixai.decks.ui.components.GridMarkersOverlay(frame, androidx.compose.ui.Modifier.matchParentSize())
                        }
                    } else {
                        ro.mixai.decks.ui.components.ComposeWaveforms(frame, peaks, modifier)
                    }
                },
                onScanFolder = onScanFolder,
                skins = state,
                recordPath = recordPath,
                onExport = onExport,
                onImportPack = importPack,
                packNotice = packNotice,
                onDismissPackNotice = { packNotice = null },
                pickFile = { cb ->
                    pendingPick = cb
                    treePicker.launch(null)
                },
            )
        }
    }
}
