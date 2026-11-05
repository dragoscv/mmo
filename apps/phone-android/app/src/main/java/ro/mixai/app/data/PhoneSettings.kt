package ro.mixai.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.phoneStore: DataStore<Preferences> by preferencesDataStore(name = "mixai_phone")

/**
 * Phone-only preferences (separate store from the shared core `Settings`): downloads, smart downloads,
 * data saver, player audio, push token state and the encrypted account session blob.
 */
class PhoneSettings(private val context: Context) {
    private val kWifiOnly = stringPreferencesKey("dl_wifi_only")
    private val kSmart = stringPreferencesKey("dl_smart")
    private val kSmartCount = stringPreferencesKey("dl_smart_count")
    private val kFollowed = stringPreferencesKey("dl_followed_shows")
    private val kDataSaver = stringPreferencesKey("data_saver")
    private val kCellularOk = stringPreferencesKey("cellular_ok_titles")
    private val kNightMode = stringPreferencesKey("player_night_mode")
    private val kPushToken = stringPreferencesKey("push_token")
    private val kPushRegistered = stringPreferencesKey("push_registered_for")
    private val kSessionBlob = stringPreferencesKey("session_blob")

    private fun Preferences.bool(k: Preferences.Key<String>, def: Boolean) = this[k]?.let { it == "1" } ?: def

    /** Downloads (manual + smart) only on unmetered networks. Default on. */
    val wifiOnly: Flow<Boolean> = context.phoneStore.data.map { it.bool(kWifiOnly, true) }
    suspend fun setWifiOnly(v: Boolean) = put(kWifiOnly, if (v) "1" else "0")

    /** Smart downloads (D38): keep the next N unwatched episodes of followed shows. Default off. */
    val smartDownloads: Flow<Boolean> = context.phoneStore.data.map { it.bool(kSmart, false) }
    suspend fun setSmartDownloads(v: Boolean) = put(kSmart, if (v) "1" else "0")

    val smartCount: Flow<Int> = context.phoneStore.data.map { it[kSmartCount]?.toIntOrNull()?.coerceIn(1, 10) ?: 3 }

    /** Followed shows (TMDB ids) for smart downloads. */
    val followedShows: Flow<Set<Long>> = context.phoneStore.data.map { p ->
        p[kFollowed]?.split(',')?.mapNotNull { it.trim().toLongOrNull() }?.toSet() ?: emptySet()
    }
    suspend fun setFollowed(tmdbId: Long, follow: Boolean) {
        context.phoneStore.edit { p ->
            val cur = p[kFollowed]?.split(',')?.mapNotNull { it.trim().toLongOrNull() }?.toMutableSet() ?: mutableSetOf()
            if (follow) cur += tmdbId else cur -= tmdbId
            p[kFollowed] = cur.joinToString(",")
        }
    }

    /** Data saver: on cellular ask before streaming the original. Default on. */
    val dataSaver: Flow<Boolean> = context.phoneStore.data.map { it.bool(kDataSaver, true) }
    suspend fun setDataSaver(v: Boolean) = put(kDataSaver, if (v) "1" else "0")

    /** Titles the user allowed on cellular (per-title override, keys like `movie:603` / `file:<id>`). */
    suspend fun cellularAllowed(key: String): Boolean =
        context.phoneStore.data.first()[kCellularOk]?.split('|')?.contains(key) == true
    suspend fun allowCellular(key: String) {
        context.phoneStore.edit { p ->
            val cur = p[kCellularOk]?.split('|')?.filter { it.isNotBlank() }?.toMutableList() ?: mutableListOf()
            if (key !in cur) cur += key
            p[kCellularOk] = cur.takeLast(200).joinToString("|")
        }
    }

    /** Night mode / dialogue boost in the player (remembered across titles). */
    val nightMode: Flow<Boolean> = context.phoneStore.data.map { it.bool(kNightMode, false) }
    suspend fun setNightMode(v: Boolean) = put(kNightMode, if (v) "1" else "0")

    // ─── push ─────────────────────────────────────────────────────────────
    val pushToken: Flow<String> = context.phoneStore.data.map { it[kPushToken] ?: "" }
    suspend fun setPushToken(t: String) = put(kPushToken, t)
    /** `<token-hash>:<userId>` of the last successful registration (avoids re-posting on every start). */
    suspend fun pushRegisteredFor(): String = context.phoneStore.data.first()[kPushRegistered] ?: ""
    suspend fun setPushRegisteredFor(v: String) = put(kPushRegistered, v)

    // ─── session blob (AES-GCM ciphertext from SessionVault) ─────────────
    suspend fun sessionBlob(): String = context.phoneStore.data.first()[kSessionBlob] ?: ""
    suspend fun setSessionBlob(v: String) = if (v.isBlank()) context.phoneStore.edit { it.remove(kSessionBlob) }.let { } else put(kSessionBlob, v)

    private suspend fun put(k: Preferences.Key<String>, v: String) { context.phoneStore.edit { it[k] = v } }
}
