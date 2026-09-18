package ro.mixai.tv.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "mixai_tv")

data class Connection(val baseUrl: String, val token: String, val userId: String = "") {
    val isComplete: Boolean get() = baseUrl.isNotBlank() && token.isNotBlank()
}

/** MixAI account session from the device-code flow (`/api/device/token`). */
data class AccountSession(val sessionToken: String, val userId: String, val userName: String, val userImage: String) {
    val isSignedIn: Boolean get() = sessionToken.isNotBlank() && userId.isNotBlank()
    val displayName: String get() = userName.ifBlank { userId }
}

/** Resume position for one video file (per device). */
@Serializable
data class Progress(val pos: Long, val dur: Long, val at: Long) {
    val fraction: Float get() = if (dur <= 0) 0f else (pos.toFloat() / dur).coerceIn(0f, 1f)
}

/** Persisted server connection: normalised base URL + device token. */
class Settings(private val context: Context) {
    private val keyBase = stringPreferencesKey("base_url")
    private val keyToken = stringPreferencesKey("device_token")
    private val keyUser = stringPreferencesKey("user_id")
    private val keySession = stringPreferencesKey("session_token")
    private val keySessionUser = stringPreferencesKey("session_user_id")
    private val keySessionName = stringPreferencesKey("session_user_name")
    private val keySessionImage = stringPreferencesKey("session_user_image")
    private val keyProgress = stringPreferencesKey("progress_json")
    private val keyLocale = stringPreferencesKey("ui_locale")
    private val json = Json { ignoreUnknownKeys = true }

    val connection: Flow<Connection> = context.dataStore.data.map { p ->
        Connection(p[keyBase] ?: "", p[keyToken] ?: "", p[keyUser] ?: "")
    }

    val session: Flow<AccountSession> = context.dataStore.data.map { p ->
        AccountSession(p[keySession] ?: "", p[keySessionUser] ?: "", p[keySessionName] ?: "", p[keySessionImage] ?: "")
    }

    /** `""` = follow the system, else `"ro"` / `"en"`. */
    val locale: Flow<String> = context.dataStore.data.map { p -> p[keyLocale] ?: "" }

    val progress: Flow<Map<String, Progress>> = context.dataStore.data.map { p -> decodeProgress(p[keyProgress]) }

    suspend fun setLocale(tag: String) {
        context.dataStore.edit { p -> if (tag.isBlank()) p.remove(keyLocale) else p[keyLocale] = tag }
    }

    /** Ignores positions under 10 s; forgets the entry once ≥ 95 % has been watched. */
    suspend fun saveProgress(fileId: String, posMs: Long, durMs: Long) {
        context.dataStore.edit { p ->
            val map = decodeProgress(p[keyProgress]).toMutableMap()
            val finished = durMs > 0 && posMs.toDouble() / durMs > 0.95
            if (posMs < 10_000 || finished) map.remove(fileId)
            else map[fileId] = Progress(posMs, durMs, System.currentTimeMillis())
            p[keyProgress] = json.encodeToString(map)
        }
    }

    suspend fun clearProgress() {
        context.dataStore.edit { p -> p.remove(keyProgress) }
    }

    private fun decodeProgress(raw: String?): Map<String, Progress> =
        if (raw.isNullOrBlank()) emptyMap() else runCatching { json.decodeFromString<Map<String, Progress>>(raw) }.getOrDefault(emptyMap())

    suspend fun save(baseUrl: String, token: String, userId: String = "") {
        context.dataStore.edit { p ->
            p[keyBase] = normalizeBaseUrl(baseUrl)
            p[keyToken] = token.trim()
            p[keyUser] = userId
        }
    }

    suspend fun saveSession(sessionToken: String, user: SessionUser) {
        context.dataStore.edit { p ->
            p[keySession] = sessionToken
            p[keySessionUser] = user.id
            p[keySessionName] = user.name ?: ""
            p[keySessionImage] = user.image ?: ""
        }
    }

    /** "Change server": forget the connection but keep the account session. */
    suspend fun clear() {
        context.dataStore.edit { p -> p.remove(keyBase); p.remove(keyToken); p.remove(keyUser) }
    }

    /** "Sign out": forget everything. */
    suspend fun clearAll() {
        context.dataStore.edit { it.clear() }
    }

    companion object {
        /** `192.168.1.5` → `http://192.168.1.5:17899`; keeps an explicit scheme/port if given. */
        fun normalizeBaseUrl(raw: String): String {
            var s = raw.trim().trimEnd('/')
            if (s.isEmpty()) return ""
            if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
            val afterScheme = s.substringAfter("://")
            if (!afterScheme.contains(':')) s = "$s:17899"
            return s
        }
    }
}
