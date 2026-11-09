package ro.mixai.keybpm.songid

import android.content.Context
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Offline queue: signatures (a few KB of fingerprint, never audio) captured without a network are matched later.
 * Capped at [MAX]; entries older than [MAX_AGE_MS] are dropped (the set log entry may be gone by then).
 */
class PendingSignatures(context: Context) {
    private val file = File(context.filesDir, "shazam-pending.json")
    private val json = Json { ignoreUnknownKeys = true }

    @Synchronized
    fun all(): List<StoredSignature> =
        runCatching { json.decodeFromString<List<StoredSignature>>(file.readText()) }.getOrDefault(emptyList())
            .filter { System.currentTimeMillis() - it.createdAtMillis < MAX_AGE_MS }

    @Synchronized
    fun add(s: StoredSignature) = write((all() + s).takeLast(MAX))

    @Synchronized
    fun remove(s: StoredSignature) = write(all().filterNot { it.createdAtMillis == s.createdAtMillis && it.data == s.data })

    private fun write(list: List<StoredSignature>) {
        if (list.isEmpty()) file.delete() else file.writeText(json.encodeToString(list))
    }

    companion object {
        const val MAX = 50
        const val MAX_AGE_MS = 7L * 24 * 3600 * 1000
    }
}
