package ro.mixai.tv.offline

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
import ro.mixai.tv.data.ClientIdentity
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.generated.TrackCard
import ro.mixai.tv.player.TrackItems
import java.io.File
import java.util.concurrent.Executors

/** A downloaded (or downloading) track with its Media3 [Download] state. */
data class TrackDownload(val track: TrackCard, val state: Int, val percent: Float, val bytes: Long) {
    val done: Boolean get() = state == Download.STATE_COMPLETED
}

/** Pure limit rule: queue only when the bytes already on disk are under [capBytes] (0 = no limit). */
fun canQueue(usedBytes: Long, capBytes: Long): Boolean = capBytes <= 0 || usedBytes < capBytes

/** The next [n] tracks after [index] in [queue] that are not already downloaded or queued. */
fun upcoming(queue: List<TrackCard>, index: Int, n: Int, known: Set<String>): List<TrackCard> =
    if (n <= 0 || index < 0) emptyList()
    else queue.drop(index + 1).distinctBy { it.id }.filter { it.id !in known }.take(n)

/**
 * Track downloads shared by MixAI Music on the phone and on Wear OS (WP17-41d/g): original files via
 * Subsonic `download.view`, one app-private [SimpleCache] (no eviction) + [DownloadManager]. Requests
 * and the player share the cache key `track:<id>` ([TrackItems.cacheKey]), so a downloaded track plays
 * from disk without the network. Request data is the TrackCard JSON, so the list works offline.
 * Each app owns its [DownloadService] subclass ([serviceClass]), which returns [manager].
 */
@UnstableApi
class TrackDownloads(private val dirName: String, private val serviceClass: Class<out DownloadService>) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Volatile private var manager: DownloadManager? = null
    @Volatile private var cache: SimpleCache? = null
    private lateinit var appContext: Context

    /** Set by the app for the current connection (download URLs need the device token). */
    @Volatile var api: MmoApi? = null
    /** Storage cap in bytes (0 = unlimited). */
    @Volatile var capBytes: Long = DEFAULT_CAP

    private val _items = MutableStateFlow<List<TrackDownload>>(emptyList())
    val items: StateFlow<List<TrackDownload>> = _items.asStateFlow()

    @Synchronized
    fun init(context: Context) {
        if (manager != null) return
        appContext = context.applicationContext
        val db = StandaloneDatabaseProvider(appContext)
        val c = SimpleCache(File(appContext.filesDir, dirName), NoOpCacheEvictor(), db)
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(ClientIdentity.current.userAgent)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
        val m = DownloadManager(appContext, db, c, http, Executors.newFixedThreadPool(2))
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

    /** Player data sources: downloaded keys from disk, everything else from [upstream] (no cache writes). */
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
        manager?.requirements = Requirements(if (wifiOnly) Requirements.NETWORK_UNMETERED else Requirements.NETWORK)
    }

    /** Queues [tracks]; false (nothing queued) without a connection or when the storage limit is reached. */
    fun download(tracks: List<TrackCard>): Boolean {
        val a = api ?: return false
        if (!::appContext.isInitialized) return false
        if (!canQueue(usedBytes(), capBytes)) { Log.i(TAG, "storage limit reached"); return false }
        val states = _items.value.associate { it.track.id to it.state }
        tracks.distinctBy { it.id }.filter { it.id !in states || states[it.id] == Download.STATE_FAILED }.forEach { t ->
            val req = DownloadRequest.Builder(TrackItems.cacheKey(t.id), Uri.parse(a.withApiKey("/rest/download.view?id=${a.encode(t.id)}")))
                .setCustomCacheKey(TrackItems.cacheKey(t.id))
                .setData(json.encodeToString(TrackCard.serializer(), t).toByteArray())
                .build()
            DownloadService.sendAddDownload(appContext, serviceClass, req, false)
        }
        return true
    }

    fun remove(trackIds: List<String>) {
        if (!::appContext.isInitialized) return
        trackIds.forEach { DownloadService.sendRemoveDownload(appContext, serviceClass, TrackItems.cacheKey(it), false) }
    }

    fun removeAll() {
        if (!::appContext.isInitialized) return
        DownloadService.sendRemoveAllDownloads(appContext, serviceClass, false)
    }

    /** Auto-download the next [n] queue tracks. */
    fun prefetch(queue: List<TrackCard>, index: Int, n: Int) {
        val next = upcoming(queue, index, n, _items.value.mapTo(HashSet()) { it.track.id })
        if (next.isNotEmpty()) download(next)
    }

    fun usedBytes(): Long = cache?.cacheSpace ?: 0L

    fun completedTracks(): List<TrackCard> = _items.value.filter { it.done }.map { it.track }

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
    }

    companion object {
        private const val TAG = "TrackDownloads"
        const val DEFAULT_CAP = 2L * 1024 * 1024 * 1024
    }
}
