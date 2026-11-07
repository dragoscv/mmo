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

/** Music-app preferences (separate from the shared core `Settings`): theme and the encrypted session blob. */
class MusicSettings(private val context: Context) : SessionBlobStore {
    private val kTheme = stringPreferencesKey("theme_mode")
    private val kSessionBlob = stringPreferencesKey("session_blob")

    /** "system" | "dark" | "light". */
    val theme: Flow<String> = context.musicStore.data.map { it[kTheme] ?: "system" }
    suspend fun setTheme(mode: String) { context.musicStore.edit { it[kTheme] = mode } }

    override suspend fun sessionBlob(): String = context.musicStore.data.first()[kSessionBlob] ?: ""
    override suspend fun setSessionBlob(v: String) {
        context.musicStore.edit { if (v.isBlank()) it.remove(kSessionBlob) else it[kSessionBlob] = v }
    }
}
