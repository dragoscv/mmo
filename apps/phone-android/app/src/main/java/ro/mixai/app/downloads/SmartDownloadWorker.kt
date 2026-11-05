package ro.mixai.app.downloads

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import androidx.media3.common.util.UnstableApi
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.flow.first
import ro.mixai.app.MixaiPhoneApp
import ro.mixai.app.data.PhoneApi
import ro.mixai.tv.data.MediaRepository
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.TmdbSize
import java.util.concurrent.TimeUnit

/**
 * Smart downloads (D38): every 6 h on Wi-Fi + charging, keeps the next N unwatched episodes of followed shows
 * downloaded and deletes smart downloads watched more than 24 h ago. Pure rules in [SmartDownloads].
 */
@SuppressLint("UnsafeOptInUsageError")
@UnstableApi
class SmartDownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as MixaiPhoneApp
        val phone = app.phone.settings
        if (!phone.smartDownloads.first()) return Result.success()
        val conn = app.settings.connection.first()
        if (!conn.isComplete) return Result.success()
        val active = app.settings.activeProfile.first()
        val profileId = active.id.ifBlank { "default" }
        val api = MmoApi(conn.baseUrl, conn.token).apply {
            extraHeaders = { if (active.tokenValid()) mapOf("x-profile-token" to active.token) else emptyMap() }
        }
        val repo = MediaRepository(api, { profileId }, null)
        val phoneApi = PhoneApi(api, { profileId }, { if (active.tokenValid()) active.token else "" })
        val followed = phone.followedShows.first()
        val n = phone.smartCount.first()

        val candidates = mutableListOf<EpisodeCandidate>()
        val metaByFile = mutableMapOf<String, DownloadMeta>()
        for (show in followed) {
            val title = runCatching { repo.title("tv", show) }.getOrNull() ?: continue
            val seasons = title.title.seasons.orEmpty().map { it.seasonNumber }.filter { it > 0 }.sorted()
            for (s in seasons) {
                val season = runCatching { repo.season(show, s) }.getOrNull() ?: continue
                for (ep in season.episodes) {
                    val file = ep.files.filter { it.serverFileId.isNotBlank() }.maxByOrNull { it.version.rank } ?: continue
                    candidates += EpisodeCandidate(show, s, ep.episodeNumber, file.serverFileId, ep.progress?.completed == true)
                    metaByFile[file.serverFileId] = DownloadMeta(
                        fileId = file.serverFileId, title = title.title.title, kind = "tv", tmdbId = show,
                        season = s, episode = ep.episodeNumber, episodeName = ep.name.ifBlank { null },
                        posterUrl = api.tmdbImageUrl(TmdbSize.poster(342), title.title.posterPath),
                        profileId = profileId, smart = true, sizeBytes = file.size,
                    )
                }
            }
        }
        val selected = SmartDownloads.select(candidates, followed, n)
        val completedIds = candidates.filter { it.completed }.map { it.fileId }.toSet()
        DownloadCenter.init(applicationContext)
        val existing = DownloadCenter.items.value
        val now = System.currentTimeMillis()
        // Stamp the watched clock on smart downloads that just became completed.
        existing.filter { it.meta.smart && it.meta.fileId in completedIds && it.meta.watchedAt == null }.forEach {
            DownloadCenter.updateMeta(applicationContext, it, it.meta.copy(watchedAt = now))
        }
        val metas = existing.map { if (it.meta.fileId in completedIds && it.meta.watchedAt == null) it.meta.copy(watchedAt = now) else it.meta }
        val del = SmartDownloads.toDelete(metas, selected.map { it.fileId }.toSet(), completedIds, now)
        del.forEach { DownloadCenter.remove(applicationContext, it.fileId) }
        val add = SmartDownloads.toAdd(selected, existing.map { it.meta.fileId }.toSet())
        add.forEach { c -> metaByFile[c.fileId]?.let { DownloadCenter.start(applicationContext, phoneApi.originalFileUrl(c.fileId), it) } }
        Log.i(TAG, "smart run: followed=${followed.size} selected=${selected.size} add=${add.size} delete=${del.size}")
        return Result.success()
    }

    companion object {
        private const val TAG = "SmartDownloads"
        private const val WORK = "mixai-smart-downloads"

        fun schedule(context: Context, enabled: Boolean) {
            val wm = WorkManager.getInstance(context)
            if (!enabled) { wm.cancelUniqueWork(WORK); return }
            val req = PeriodicWorkRequestBuilder<SmartDownloadWorker>(6, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).setRequiresCharging(true).build())
                .build()
            wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, req)
        }
    }
}
