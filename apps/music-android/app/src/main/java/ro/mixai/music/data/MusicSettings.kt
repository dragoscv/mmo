package ro.mixai.music.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import ro.mixai.mobile.auth.SessionBlobStore

private val Context.musicStore: DataStore<Preferences> by preferencesDataStore(name = "mixai_music")

/** Music-app preferences (separate from the shared core `Settings`): theme, downloads, encrypted session blob. */
class MusicSettings(private val context: Context) : SessionBlobStore {
    private val kTheme = stringPreferencesKey("theme_mode")
    private val kSessionBlob = stringPreferencesKey("session_blob")
    private val kWifiOnly = stringPreferencesKey("dl_wifi_only")
    private val kUpcoming = stringPreferencesKey("dl_upcoming")
    private val kCapGb = stringPreferencesKey("dl_cap_gb")
    private val kCrossfade = stringPreferencesKey("pb_crossfade_s")
    private val kNormalize = stringPreferencesKey("pb_normalize")

    /** Crossfade between tracks in seconds (0 = gapless only, default 0). Album continuations stay gapless. */
    val crossfadeSec: Flow<Int> = context.musicStore.data.map { it[kCrossfade]?.toIntOrNull()?.coerceIn(0, 12) ?: 0 }
    suspend fun setCrossfadeSec(s: Int) { context.musicStore.edit { it[kCrossfade] = s.coerceIn(0, 12).toString() } }

    /** Loudness normalisation from the server's EBU R128 analysis (default on). */
    val normalize: Flow<Boolean> = context.musicStore.data.map { it[kNormalize] != "0" }
    suspend fun setNormalize(v: Boolean) { context.musicStore.edit { it[kNormalize] = if (v) "1" else "0" } }

    /** "system" | "dark" | "light". */
    val theme: Flow<String> = context.musicStore.data.map { it[kTheme] ?: "system" }
    suspend fun setTheme(mode: String) { context.musicStore.edit { it[kTheme] = mode } }

    /** Downloads only on unmetered networks (default on). */
    val wifiOnly: Flow<Boolean> = context.musicStore.data.map { it[kWifiOnly] != "0" }
    suspend fun setWifiOnly(v: Boolean) { context.musicStore.edit { it[kWifiOnly] = if (v) "1" else "0" } }

    /** Auto-download the next N queue tracks while playing (0 = off, default 0). */
    val upcoming: Flow<Int> = context.musicStore.data.map { it[kUpcoming]?.toIntOrNull()?.coerceIn(0, 50) ?: 0 }
    suspend fun setUpcoming(n: Int) { context.musicStore.edit { it[kUpcoming] = n.coerceIn(0, 50).toString() } }

    /** Storage limit for downloads in GB (0 = unlimited, default 2). */
    val capGb: Flow<Int> = context.musicStore.data.map { it[kCapGb]?.toIntOrNull()?.coerceIn(0, 512) ?: 2 }
    suspend fun setCapGb(gb: Int) { context.musicStore.edit { it[kCapGb] = gb.coerceIn(0, 512).toString() } }

    override suspend fun sessionBlob(): String = context.musicStore.data.first()[kSessionBlob] ?: ""
    override suspend fun setSessionBlob(v: String) {
        context.musicStore.edit { if (v.isBlank()) it.remove(kSessionBlob) else it[kSessionBlob] = v }
    }
}
