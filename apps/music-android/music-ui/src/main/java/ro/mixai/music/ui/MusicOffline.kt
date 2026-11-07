package ro.mixai.music.ui

import kotlinx.coroutines.flow.StateFlow
import ro.mixai.tv.data.generated.TrackCard

/** Offline state of one track. */
enum class OfflineState { Queued, Downloading, Waiting, Done, Failed }

/**
 * Track downloads (WP17-41d). Implemented by MixAI Music; the phone app passes none, so the shared
 * screens show no download controls there.
 */
interface MusicOffline {
    /** trackId → state, for every track with a download (any state). */
    val states: StateFlow<Map<String, OfflineState>>

    /** Queues [tracks]; returns false (nothing queued) when the storage limit is reached. */
    fun download(tracks: List<TrackCard>): Boolean

    fun remove(trackIds: List<String>)
}
