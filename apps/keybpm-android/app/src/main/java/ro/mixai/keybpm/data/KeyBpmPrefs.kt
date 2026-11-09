package ro.mixai.keybpm.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.keyBpmStore by preferencesDataStore(name = "keybpm")

/** App-local settings (not shared with the other MixAI apps through `:core` Settings). */
class KeyBpmPrefs(private val context: Context) {
    private val keyTracklist = booleanPreferencesKey("tracklist_mode")

    /** Tracklist mode (WP18-06): identify each new song automatically while listening. Off by default. */
    val tracklistMode: Flow<Boolean> = context.keyBpmStore.data.map { it[keyTracklist] ?: false }

    suspend fun setTracklistMode(on: Boolean) {
        context.keyBpmStore.edit { it[keyTracklist] = on }
    }
}
