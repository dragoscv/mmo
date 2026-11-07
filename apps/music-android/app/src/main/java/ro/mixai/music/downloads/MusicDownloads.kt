package ro.mixai.music.downloads

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.media3.exoplayer.offline.DownloadService
import androidx.media3.exoplayer.scheduler.Requirements
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import ro.mixai.music.ui.MusicOffline
import ro.mixai.music.ui.OfflineState
import ro.mixai.tv.data.ClientIdentity
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.generated.TrackCard
import ro.mixai.tv.player.TrackItems
import java.io.File
import java.util.concurrent.Executors

/** A downloaded (or downloading) track with its Media3 state. */
data class TrackDownload(val track: TrackCard, val state: Int, val percent: Float, val bytes: Long) {
    val offline: OfflineState get() = offlineState(state)
}

internal fun offlineState(state: Int): OfflineState = when (state) {
    Download.STATE_COMPLETED -> OfflineState.Done
    Download.STATE_DOWNLOADING -> OfflineState.Downloading
    Download.STATE_FAILED -> OfflineState.Failed
    Download.STATE_STOPPED -> OfflineState.Waiting
    else -> OfflineState.Queued
}

/** Pure limit rule: queue only when the bytes already on disk are under [capBytes] (0 = no limit). */
internal fun canQueue(usedBytes: Long, capBytes: Long): Boolean = capBytes <= 0 || usedBytes < capBytes

/** The next [n] tracks after [index] in [queue] that are not already downloaded or queued. */
internal fun upcoming(queue: List<TrackCard>, index: Int, n: Int, known: Set<String>): List<TrackCard> =
    if (n <= 0 || index < 0) emptyList()
    else queue.drop(index + 1).distinctBy { it.id }.filter { it.id !in known }.take(n)

/**
 * Track downloads of MixAI Music (WP17-41d): original files via Subsonic `download.view`, one app-private
 * [SimpleCache] (no eviction) + [DownloadManager]. Requests and the player share the cache key
 * `track:<id>` (`TrackItems.cacheKey`), so a downloaded track plays from disk without the network.
 * The request data is the TrackCard JSON, so the downloads list works offline.
 */
@SuppressLint("UnsafeOptInUsageError")
@UnstableApi
object MusicDownloads : MusicOffline {
    private const val TAG = "MusicDownloads"
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Volatile private var manager: DownloadManager? = null
    @Volatile private var cache: SimpleCache? = null
    private lateinit var appContext: Context
    private lateinit var httpFactory: DefaultHttpDataSource.Factory

    /** Set by the app for the current connection (download URLs need the device token). */
    @Volatile var api: MmoApi? = null
    /** Storage cap in bytes (0 = unlimited); from MusicSettings. */
    @Volatile var capBytes: Long = DEFAULT_CAP

    private val _items = MutableStateFlow<List<TrackDownload>>(emptyList())
    val items: StateFlow<List<TrackDownload>> = _items.asStateFlow()
    private val _states = MutableStateFlow<Map<String, OfflineState>>(emptyMap())
    override val states: StateFlow<Map<String, OfflineState>> = _states.asStateFlow()

    @Synchronized
    fun init(context: Context) {
        if (manager != null) return
        appContext = context.applicationContext
        val db = StandaloneDatabaseProvider(appContext)
        val c = SimpleCache(File(appContext.filesDir, "music-downloads"), NoOpCacheEvictor(), db)
        httpFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(ClientIdentity.current.userAgent)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
        val m = DownloadManager(appContext, db, c, httpFactory, Executors.newFixedThreadPool(2))
        m.maxParallelDownloads = 2
        m.addListener(object : DownloadManager.Listener {
            override fun onDownloadChanged(downloadManager: DownloadManager, download: Download, finalException: Exception?) {
                if (finalException != null) Log.w(TAG, "download ${download.request.id} failed: ${finalException.message}")
                if (download.state == Download.STATE_COMPLETED) Log.i(TAG, "download ${download.request.id} completed bytes=${download.bytesDownloaded}")
                publish()
            }
            override fun onDownloadRemoved(downloadManager: DownloadManager, download: Download) { publish() }
            override fun onInitialized(downloadManager: DownloadManager) { publish() }
        })
        cache = c
        manager = m
        publish()
    }

    fun manager(context: Context): DownloadManager { init(context); return manager!! }

    /** Player data sources: downloaded keys from disk, everything else from the network (no cache writes). */
    fun dataSourceFactory(context: Context, upstream: DataSource.Factory): DataSource.Factory {
        init(context)
        return CacheDataSource.Factory()
            .setCache(cache!!)
            .setUpstreamDataSourceFactory(upstream)
            .setCacheWriteDataSinkFactory(null)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    }

    /**
     * Unmetered-only (Wi-Fi) or any network. Set on the in-process manager, not via
     * `DownloadService.sendSetRequirements`: that starts the service and throws
     * BackgroundServiceStartNotAllowedException when the process was started in the background
     * (widget broadcast, boot, media button).
     */
    fun setWifiOnly(context: Context, wifiOnly: Boolean) {
        init(context)
        val req = Requirements(if (wifiOnly) Requirements.NETWORK_UNMETERED else Requirements.NETWORK)
        manager?.requirements = req
    }

    override fun download(tracks: List<TrackCard>): Boolean {
        val a = api ?: return false
        init(appContext)
        if (!canQueue(usedBytes(), capBytes)) { Log.i(TAG, "storage limit reached"); return false }
        val known = _states.value.keys
        tracks.distinctBy { it.id }.filter { it.id !in known || _states.value[it.id] == OfflineState.Failed }.forEach { t ->
            val req = DownloadRequest.Builder(TrackItems.cacheKey(t.id), Uri.parse(a.withApiKey("/rest/download.view?id=${a.encode(t.id)}")))
                .setCustomCacheKey(TrackItems.cacheKey(t.id))
                .setData(json.encodeToString(TrackCard.serializer(), t).toByteArray())
                .build()
            DownloadService.sendAddDownload(appContext, MusicDownloadService::class.java, req, false)
        }
        return true
    }

    override fun remove(trackIds: List<String>) {
        init(appContext)
        trackIds.forEach { DownloadService.sendRemoveDownload(appContext, MusicDownloadService::class.java, TrackItems.cacheKey(it), false) }
    }

    fun removeAll() {
        init(appContext)
        DownloadService.sendRemoveAllDownloads(appContext, MusicDownloadService::class.java, false)
    }

    /** Auto-download the next [n] queue tracks (setting "Download upcoming tracks"). */
    fun prefetch(queue: List<TrackCard>, index: Int, n: Int) {
        val next = upcoming(queue, index, n, _states.value.keys)
        if (next.isNotEmpty()) download(next)
    }

    fun usedBytes(): Long = cache?.cacheSpace ?: 0L

    fun completedTracks(): List<TrackCard> = _items.value.filter { it.state == Download.STATE_COMPLETED }.map { it.track }

    private fun publish() {
        val m = manager ?: return
        val out = mutableListOf<TrackDownload>()
        runCatching {
            m.downloadIndex.getDownloads().use { c ->
                while (c.moveToNext()) {
                    val d = c.download
                    val t = runCatching { json.decodeFromString(TrackCard.serializer(), String(d.request.data)) }.getOrNull() ?: continue
                    out += TrackDownload(t, d.state, d.percentDownloaded.takeIf { it >= 0 } ?: 0f, d.bytesDownloaded)
                }
            }
        }.onFailure { Log.w(TAG, "index read failed: ${it.message}") }
        _items.value = out
        _states.value = out.associate { it.track.id to it.offline }
    }

    const val DEFAULT_CAP = 2L * 1024 * 1024 * 1024
}
