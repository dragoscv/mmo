package ro.mixai.music.downloads

import android.annotation.SuppressLint
import android.content.Context
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import ro.mixai.music.ui.MusicOffline
import ro.mixai.music.ui.OfflineState
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.generated.TrackCard
import ro.mixai.tv.offline.TrackDownload
import ro.mixai.tv.offline.TrackDownloads

internal fun offlineState(state: Int): OfflineState = when (state) {
    Download.STATE_COMPLETED -> OfflineState.Done
    Download.STATE_DOWNLOADING -> OfflineState.Downloading
    Download.STATE_FAILED -> OfflineState.Failed
    Download.STATE_STOPPED -> OfflineState.Waiting
    else -> OfflineState.Queued
}

val TrackDownload.offline: OfflineState get() = offlineState(state)

/**
 * Track downloads of MixAI Music (WP17-41d) on the shared :core engine ([TrackDownloads], also used
 * by the Wear app), exposed to the shared screens as [MusicOffline].
 */
@SuppressLint("UnsafeOptInUsageError")
@UnstableApi
object MusicDownloads : MusicOffline {
    private val engine = TrackDownloads("music-downloads", MusicDownloadService::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    var api: MmoApi?
        get() = engine.api
        set(v) { engine.api = v }
    var capBytes: Long
        get() = engine.capBytes
        set(v) { engine.capBytes = v }

    val items: StateFlow<List<TrackDownload>> get() = engine.items
    override val states: StateFlow<Map<String, OfflineState>> =
        engine.items.map { list -> list.associate { it.track.id to it.offline } }.stateIn(scope, SharingStarted.Eagerly, emptyMap())

    fun init(context: Context) = engine.init(context)
    fun manager(context: Context): DownloadManager = engine.manager(context)
    fun dataSourceFactory(context: Context, upstream: DataSource.Factory): DataSource.Factory = engine.dataSourceFactory(context, upstream)
    fun setWifiOnly(context: Context, wifiOnly: Boolean) = engine.setWifiOnly(context, wifiOnly)
    override fun download(tracks: List<TrackCard>): Boolean = engine.download(tracks)
    override fun remove(trackIds: List<String>) = engine.remove(trackIds)
    fun removeAll() = engine.removeAll()
    fun prefetch(queue: List<TrackCard>, index: Int, n: Int) = engine.prefetch(queue, index, n)
    fun usedBytes(): Long = engine.usedBytes()
    fun completedTracks(): List<TrackCard> = engine.completedTracks()

    const val DEFAULT_CAP = TrackDownloads.DEFAULT_CAP
}
