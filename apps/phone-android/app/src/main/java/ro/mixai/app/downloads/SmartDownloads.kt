package ro.mixai.app.downloads

import kotlinx.serialization.Serializable

/** Metadata stored in a Media3 `DownloadRequest.data` (JSON) so the list can group without the server. */
@Serializable
data class DownloadMeta(
    val fileId: String,
    val title: String,
    val kind: String = "movie",
    val tmdbId: Long? = null,
    val season: Long? = null,
    val episode: Long? = null,
    val episodeName: String? = null,
    val posterUrl: String? = null,
    val profileId: String = "default",
    /** true = picked by smart downloads (auto-deleted after watched + 24 h). */
    val smart: Boolean = false,
    val sizeBytes: Long = 0L,
    /** Epoch ms when the episode was first seen as completed (smart cleanup clock). */
    val watchedAt: Long? = null,
)

/** Candidate episode for smart selection. */
data class EpisodeCandidate(
    val tmdbId: Long,
    val season: Long,
    val episode: Long,
    val fileId: String,
    val completed: Boolean,
)

/** Pure smart-download rules (D38), unit-tested. */
object SmartDownloads {
    const val WATCHED_GRACE_MS = 24 * 60 * 60 * 1000L

    /**
     * Next `n` unwatched episodes per followed show, in (season, episode) order, starting after the last completed
     * episode (a rewatch of an old one does not reset the window). Episodes without a file are skipped.
     */
    fun select(candidates: List<EpisodeCandidate>, followed: Set<Long>, n: Int): List<EpisodeCandidate> {
        if (n <= 0) return emptyList()
        return candidates.filter { it.tmdbId in followed && it.fileId.isNotBlank() }
            .groupBy { it.tmdbId }
            .flatMap { (_, eps) ->
                val ordered = eps.distinctBy { it.season to it.episode }.sortedWith(compareBy({ it.season }, { it.episode }))
                val lastDone = ordered.indexOfLast { it.completed }
                ordered.drop(lastDone + 1).filter { !it.completed }.take(n)
            }
    }

    /** Smart downloads to delete now: watched for at least 24 h, or no longer selected (show unfollowed / window moved). */
    fun toDelete(existing: List<DownloadMeta>, selectedFileIds: Set<String>, completedFileIds: Set<String>, now: Long): List<DownloadMeta> =
        existing.filter { it.smart }.filter { m ->
            val watchedLongAgo = m.fileId in completedFileIds && (m.watchedAt ?: now) + WATCHED_GRACE_MS <= now
            val notSelected = m.fileId !in selectedFileIds && m.fileId !in completedFileIds
            watchedLongAgo || notSelected
        }

    /** Smart downloads to start: selected and not already present. */
    fun toAdd(selected: List<EpisodeCandidate>, existingFileIds: Set<String>): List<EpisodeCandidate> =
        selected.filter { it.fileId !in existingFileIds }
}
