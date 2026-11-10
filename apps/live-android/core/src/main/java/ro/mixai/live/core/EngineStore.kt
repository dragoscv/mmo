package ro.mixai.live.core

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.builtins.ListSerializer

private val Context.liveStore by preferencesDataStore(name = "mixai_live")

/** Paired engines (most recent first) + the client id this device uses on every engine. */
class EngineStore(context: Context) {
    private val ds = context.applicationContext.liveStore
    private val listSer = ListSerializer(PairedEngine.serializer())

    val engines: Flow<List<PairedEngine>> = ds.data.map { p ->
        p[ENGINES]?.let { runCatching { LiveJson.decodeFromString(listSer, it) }.getOrNull() }.orEmpty()
            .sortedByDescending { it.lastUsedMillis }
    }

    suspend fun save(engine: PairedEngine) {
        ds.edit { p ->
            val cur = p[ENGINES]?.let { runCatching { LiveJson.decodeFromString(listSer, it) }.getOrNull() }.orEmpty()
            val next = listOf(engine.copy(lastUsedMillis = System.currentTimeMillis())) + cur.filter { it.key != engine.key }
            p[ENGINES] = LiveJson.encodeToString(listSer, next.take(MAX))
        }
    }

    suspend fun remove(key: String) {
        ds.edit { p ->
            val cur = p[ENGINES]?.let { runCatching { LiveJson.decodeFromString(listSer, it) }.getOrNull() }.orEmpty()
            p[ENGINES] = LiveJson.encodeToString(listSer, cur.filter { it.key != key })
        }
    }

    suspend fun clientId(prefix: String): String {
        ds.data.first()[CLIENT]?.let { return it }
        val id = prefix + "-" + java.util.UUID.randomUUID().toString().replace("-", "").take(12)
        ds.edit { it[CLIENT] = id }
        return id
    }

    private companion object {
        val ENGINES = stringPreferencesKey("engines")
        val CLIENT = stringPreferencesKey("client_id")
        const val MAX = 12
    }
}
