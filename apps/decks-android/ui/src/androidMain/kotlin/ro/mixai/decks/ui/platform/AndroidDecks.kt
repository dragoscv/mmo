package ro.mixai.decks.ui.platform

import android.content.Context
import android.provider.Settings
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.engine.DecksBackend
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.FfiBackend
import ro.mixai.decks.ui.i18n.LocalStrings
import ro.mixai.decks.ui.i18n.StringTable
import ro.mixai.decks.ui.screens.DecksScreen
import ro.mixai.decks.ui.theme.DecksTheme
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.SkinState

object AndroidDecks {
    /** Native engine (libdecks_ffi.so via JNA); the demo engine when the library cannot load. */
    fun createBackend(context: Context): DecksBackend = try {
        ro.mixai.decks.ffi.DecksAndroid.init(context)
        FfiBackend(context.filesDir.resolve("decks-library.sqlite").absolutePath)
    } catch (t: Throwable) {
        Log.e("Decks", "native engine unavailable, demo engine", t)
        DemoBackend { System.nanoTime() / 1e9 }
    }

    /** OS "remove animations" / animator scale 0 → reduced motion. */
    fun reducedMotion(context: Context): Boolean =
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

    /** Skin persisted in SharedPreferences `decks` / `skin` ([DecksSkin.encode]). */
    fun skinState(context: Context): SkinState {
        val prefs = context.getSharedPreferences("decks", Context.MODE_PRIVATE)
        return SkinState(DecksSkin.decode(prefs.getString("skin", null))) { prefs.edit().putString("skin", it.encode()).apply() }
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
) {
    val backend = ctl.backend
    val state = skins ?: remember { SkinState(DecksSkin.default) }
    CompositionLocalProvider(LocalStrings provides strings) {
        DecksTheme(reducedMotion, state.skin) {
            DecksScreen(
                ctl,
                waveforms = { frame, peaks, modifier ->
                    if (backend is FfiBackend) GpuWaveforms(backend, frame, peaks, modifier)
                    else ro.mixai.decks.ui.components.ComposeWaveforms(frame, peaks, modifier)
                },
                onScanFolder = onScanFolder,
                skins = state,
                recordPath = recordPath,
                onExport = onExport,
            )
        }
    }
}
