package ro.mixai.tv.data

import android.util.Log
import kotlinx.coroutines.flow.first
import ro.mixai.tv.data.generated.ProgressInput

// Progress writes: server first (`PUT /media/progress`, seconds), DataStore queue as fallback.
// The queue is flushed on the next successful write. Also owns the one-shot migration of the
// legacy per-device `progress_json` map (fileId → ms) once a media-capable server is seen.
class ProgressSync(private val repo: MediaRepository, private val settings: Settings) {

    /** Saves `ref` at `posMs`/`durMs`. Never throws — failures land in the local queue. */
    suspend fun save(ref: MediaRef, posMs: Long, durMs: Long, completed: Boolean? = null) {
        if (durMs <= 0) return
        val input = ProgressInput(
            kind = ref.kind, tmdbId = ref.tmdbId, season = ref.season, episode = ref.episode,
            positionSec = posMs / 1000.0, durationSec = durMs / 1000.0, completed = completed,
            updatedAt = System.currentTimeMillis(),
        )
        put(listOf(input))
    }

    suspend fun markWatched(ref: MediaRef, durationSec: Double?) {
        put(listOf(ProgressInput(
            kind = ref.kind, tmdbId = ref.tmdbId, season = ref.season, episode = ref.episode,
            positionSec = durationSec ?: 0.0, durationSec = durationSec, completed = true,
            updatedAt = System.currentTimeMillis(),
        )))
    }

    private suspend fun put(fresh: List<ProgressInput>) {
        val pending = settings.pendingProgress()
        try {
            repo.putProgress(pending + fresh)
            if (pending.isNotEmpty()) settings.clearPendingProgress()
        } catch (e: Exception) {
            Log.w(TAG, "PUT /media/progress failed, queued: ${e.message}")
            fresh.forEach { settings.enqueueProgress(it) }
        }
    }

    /**
     * One-shot: push the legacy DataStore map (fileId → ms) as seconds, resolving file ids via
     * `/media/library`. Marks migrated even when nothing could be mapped (no library rows).
     */
    suspend fun migrateLegacyOnce() {
        if (settings.isMediaMigrated()) return
        val legacy = settings.progress.first()
        if (legacy.isEmpty()) { settings.markMediaMigrated(); return }
        val rows = try { repo.library().items } catch (e: Exception) { Log.w(TAG, "library for migration failed: ${e.message}"); return }
        val byFile = rows.filter { it.tmdbId != null }.associateBy { it.serverFileId }
        val inputs = legacy.mapNotNull { (fileId, p) ->
            val row = byFile[fileId] ?: return@mapNotNull null
            ProgressInput(
                kind = row.kind, tmdbId = row.tmdbId!!, season = row.season, episode = row.episode,
                positionSec = p.pos / 1000.0, durationSec = p.dur / 1000.0, updatedAt = p.at,
            )
        }
        try {
            if (inputs.isNotEmpty()) repo.putProgress(inputs)
            settings.markMediaMigrated()
            Log.i(TAG, "migrated ${inputs.size}/${legacy.size} legacy progress entries")
        } catch (e: Exception) {
            Log.w(TAG, "legacy migration PUT failed, retry next launch: ${e.message}")
        }
    }

    private companion object { const val TAG = "ProgressSync" }
}
