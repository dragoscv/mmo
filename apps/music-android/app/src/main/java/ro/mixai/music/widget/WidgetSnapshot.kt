package ro.mixai.music.widget

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** What the home-screen widget shows (WP17-41f). Persisted so it survives process death. */
@Serializable
data class WidgetSnapshot(
    val title: String = "",
    val artist: String = "",
    val artUri: String = "",
    val playing: Boolean = false,
    val hasNext: Boolean = false,
    val hasPrevious: Boolean = false,
) {
    val idle: Boolean get() = title.isBlank()

    fun encode(): String = json.encodeToString(serializer(), this)

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** Stored snapshot; a process that died while playing is not playing any more. */
        fun decode(s: String?): WidgetSnapshot {
            if (s.isNullOrBlank()) return WidgetSnapshot()
            return runCatching { json.decodeFromString(serializer(), s).copy(playing = false) }.getOrDefault(WidgetSnapshot())
        }
    }
}

/** Process-wide widget state: updated by [MusicWidgetBridge], read by [MusicWidget]. */
object WidgetBus {
    private const val PREFS = "mixai_music_widget"
    private const val KEY = "snapshot"
    private val _state = MutableStateFlow<WidgetSnapshot?>(null)

    fun state(context: Context): StateFlow<WidgetSnapshot?> {
        if (_state.value == null) _state.value = WidgetSnapshot.decode(prefs(context).getString(KEY, null))
        return _state.asStateFlow()
    }

    /** Returns true when the visible state changed (the caller then refreshes the widgets). */
    fun publish(context: Context, snap: WidgetSnapshot): Boolean {
        if (_state.value == snap) return false
        _state.value = snap
        prefs(context).edit().putString(KEY, snap.encode()).apply()
        return true
    }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
