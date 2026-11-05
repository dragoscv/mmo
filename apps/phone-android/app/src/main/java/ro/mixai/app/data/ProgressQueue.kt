package ro.mixai.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import ro.mixai.tv.data.MediaRepository
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.generated.ProgressInput

/** Pure merge rules of the offline progress queue (unit-tested). */
object ProgressQueue {
    fun key(p: ProgressInput): String = "${p.kind}:${p.tmdbId}:${p.season ?: 0}:${p.episode ?: 0}"

    /**
     * One entry per title/episode: the newest `updatedAt` wins; a `completed=true` entry is kept over an older
     * or equal-time partial one (finishing an episode offline must not be undone by a stale position).
     * Output is ordered oldest first so the server applies them in time order.
     */
    fun merge(pending: List<ProgressInput>, fresh: List<ProgressInput>): List<ProgressInput> {
        val out = LinkedHashMap<String, ProgressInput>()
        for (p in pending + fresh) {
            val k = key(p)
            val cur = out[k]
            out[k] = when {
                cur == null -> p
                (p.updatedAt ?: 0L) > (cur.updatedAt ?: 0L) -> p
                (p.updatedAt ?: 0L) == (cur.updatedAt ?: 0L) && p.completed == true -> p
                else -> cur
            }
        }
        return out.values.sortedBy { it.updatedAt ?: 0L }
    }
}

/**
 * Offline-first progress (D38): the core ProgressSync already queues failed writes in DataStore; this flushes that
 * queue as soon as the network comes back (ConnectivityManager callback) instead of waiting for the next write.
 */
class ProgressFlusher(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()
    @Volatile private var target: Pair<MediaRepository, Settings>? = null
    private var callback: ConnectivityManager.NetworkCallback? = null

    fun attach(repo: MediaRepository, settings: Settings) {
        target = repo to settings
        if (callback == null) {
            val cm = context.getSystemService(ConnectivityManager::class.java)
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { flushAsync("network") }
            }
            val req = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
            runCatching { cm.registerNetworkCallback(req, cb); callback = cb }
        }
        flushAsync("attach")
    }

    fun detach() { target = null }

    fun flushAsync(reason: String) {
        scope.launch { flush(reason) }
    }

    suspend fun flush(reason: String): Int = lock.withLock {
        val (repo, settings) = target ?: return 0
        val pending = settings.pendingProgress()
        if (pending.isEmpty()) return 0
        val merged = ProgressQueue.merge(pending, emptyList())
        return try {
            repo.putProgress(merged)
            settings.clearPendingProgress()
            Log.i(TAG, "flushed ${merged.size} queued progress entries ($reason)")
            merged.size
        } catch (e: Exception) {
            Log.i(TAG, "flush deferred ($reason): ${e.message}")
            0
        }
    }

    private companion object { const val TAG = "ProgressQueue" }
}
