package ro.mixai.app.downloads

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.media3.common.MediaItem
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
import java.io.File
import java.util.concurrent.Executors

/** One row of the downloads list (Media3 state + our metadata). */
data class DownloadItem(
    val id: String,
    val meta: DownloadMeta,
    /** Download.STATE_* */
    val state: Int,
    val percent: Float,
    val bytes: Long,
    val totalBytes: Long,
    val stopReason: Int,
    val failureReason: Int,
) {
    val completed: Boolean get() = state == Download.STATE_COMPLETED
    val active: Boolean get() = state == Download.STATE_DOWNLOADING || state == Download.STATE_QUEUED || state == Download.STATE_RESTARTING
}

/**
 * Media3 offline downloads of ORIGINAL files (`GET /video/file/{id}`, Range): one process-wide [SimpleCache]
 * (no eviction, app-private files dir) + [DownloadManager]. Requests are keyed `file:<fileId>` and carry
 * [DownloadMeta] JSON, so the list works offline and the player can read from the cache with the same key.
 */
@SuppressLint("UnsafeOptInUsageError")
@UnstableApi
object DownloadCenter {
    private const val TAG = "MixaiDownloads"
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Volatile private var manager: DownloadManager? = null
    @Volatile private var cache: SimpleCache? = null
    private lateinit var appContext: Context
    private lateinit var httpFactory: DefaultHttpDataSource.Factory

    private val _items = MutableStateFlow<List<DownloadItem>>(emptyList())
    val items: StateFlow<List<DownloadItem>> = _items.asStateFlow()

    fun key(fileId: String) = "file:$fileId"

    @Synchronized
    fun init(context: Context) {
        if (manager != null) return
        appContext = context.applicationContext
        val db = StandaloneDatabaseProvider(appContext)
        val c = SimpleCache(File(appContext.filesDir, "downloads"), NoOpCacheEvictor(), db)
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

    /** Unmetered-only (Wi-Fi) or any network. */
    fun setWifiOnly(context: Context, wifiOnly: Boolean) {
        val req = Requirements(if (wifiOnly) Requirements.NETWORK_UNMETERED else Requirements.NETWORK)
        init(context)
        DownloadService.sendSetRequirements(context, MixaiDownloadService::class.java, req, false)
    }

    fun start(context: Context, url: String, meta: DownloadMeta) {
        init(context)
        val data = json.encodeToString(DownloadMeta.serializer(), meta).toByteArray()
        val req = DownloadRequest.Builder(key(meta.fileId), Uri.parse(url))
            .setCustomCacheKey(key(meta.fileId))
            .setData(data)
            .build()
        DownloadService.sendAddDownload(context, MixaiDownloadService::class.java, req, false)
        Log.i(TAG, "queued ${meta.fileId} smart=${meta.smart}")
    }

    fun remove(context: Context, fileId: String) {
        init(context)
        DownloadService.sendRemoveDownload(context, MixaiDownloadService::class.java, key(fileId), false)
    }

    /** Updates the stored metadata (e.g. watchedAt) by re-adding the same request (Media3 merges; bytes kept). */
    fun updateMeta(context: Context, item: DownloadItem, meta: DownloadMeta) {
        val m = manager(context)
        val cur = m.downloadIndex.getDownload(item.id) ?: return
        val req = DownloadRequest.Builder(cur.request.id, cur.request.uri)
            .setCustomCacheKey(cur.request.customCacheKey)
            .setData(json.encodeToString(DownloadMeta.serializer(), meta).toByteArray())
            .build()
        m.addDownload(req)
    }

    fun completed(fileId: String): DownloadItem? = _items.value.firstOrNull { it.meta.fileId == fileId && it.completed }

    /** Player media item that reads the downloaded bytes (falls back to the network for gaps). */
    fun offlineMediaItem(fileId: String, title: String): MediaItem? {
        val d = completed(fileId) ?: return null
        val m = manager ?: return null
        val req = m.downloadIndex.getDownload(d.id)?.request ?: return null
        return MediaItem.Builder().setMediaId(fileId).setUri(req.uri).setCustomCacheKey(req.customCacheKey)
            .setMediaMetadata(androidx.media3.common.MediaMetadata.Builder().setTitle(title).build()).build()
    }

    /** Cache-backed source factory for offline playback (read-only for downloaded keys). */
    fun cacheDataSourceFactory(context: Context): DataSource.Factory {
        init(context)
        return CacheDataSource.Factory()
            .setCache(cache!!)
            .setUpstreamDataSourceFactory(httpFactory)
            .setCacheWriteDataSinkFactory(null)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    }

    /** Bytes of all downloads on disk. */
    fun usedBytes(): Long = cache?.cacheSpace ?: 0L

    fun publish() {
        val m = manager ?: return
        val out = mutableListOf<DownloadItem>()
        runCatching {
            m.downloadIndex.getDownloads().use { c ->
                while (c.moveToNext()) {
                    val d = c.download
                    val meta = runCatching { json.decodeFromString(DownloadMeta.serializer(), String(d.request.data)) }.getOrNull() ?: continue
                    out += DownloadItem(
                        id = d.request.id, meta = meta, state = d.state,
                        percent = d.percentDownloaded.takeIf { it >= 0 } ?: 0f,
                        bytes = d.bytesDownloaded, totalBytes = d.contentLength,
                        stopReason = d.stopReason, failureReason = d.failureReason,
                    )
                }
            }
        }.onFailure { Log.w(TAG, "index read failed: ${it.message}") }
        _items.value = out
    }
}
