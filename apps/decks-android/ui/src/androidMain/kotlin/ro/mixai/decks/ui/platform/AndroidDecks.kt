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
}

@Composable
fun DecksAndroidRoot(ctl: DecksController, strings: StringTable, reducedMotion: Boolean, onScanFolder: () -> Unit, skins: SkinState? = null) {
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
            )
        }
    }
}
