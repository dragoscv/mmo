package ro.mixai.keybpm

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import ro.mixai.listen.WearLink

/**
 * Mirrors the live reading to MixAI Key & BPM on a paired Wear OS watch (WP18-04): MessageClient on change
 * (≤ 2/s + 2 s heartbeat) while listening, and the last locked reading as a DataClient item for the watch tile.
 * No-op without Play Services or without a watch that has the app (capability `mixai_keybpm_watch`).
 */
class WatchBridge(context: Context) {
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val available = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(app) == ConnectionResult.SUCCESS
    private var nodes: List<String> = emptyList()
    private var nodesAt = 0L
    private var last: WearLink.Reading? = null
    private var lastAt = 0L
    private var lastLocked: Pair<Int?, Double?>? = null

    fun publish(u: ListenUi) {
        if (!available) return
        val s = u.snapshot
        val r = WearLink.Reading(
            listening = u.listening,
            keyIndex = s?.key?.key?.index?.toInt(),
            keyLocked = s?.key?.locked == true,
            bpm = u.bpm,
            tempoLocked = s?.tempo?.locked == true,
            nextBeatMs = s?.tempo?.let { (it.nextBeatInSecs * 1000).toLong() },
            atMillis = System.currentTimeMillis(),
            title = (u.songId as? SongIdUi.Found)?.song?.let { listOfNotNull(it.title, it.artist).joinToString(" — ") },
        )
        val now = SystemClock.uptimeMillis()
        if (!u.listening && last?.listening != true) return
        if (!WearLink.shouldSend(last, r, now - lastAt)) return
        last = r
        lastAt = now
        val line = WearLink.encode(r).toByteArray(Charsets.UTF_8)
        scope.launch {
            runCatching {
                for (n in watchNodes()) Wearable.getMessageClient(app).sendMessage(n, WearLink.PATH_LIVE, line).await()
            }.onFailure { Log.w(TAG, "live: ${it.message}") }
        }
        if (r.keyLocked && r.tempoLocked) {
            val locked = r.keyIndex to r.bpm?.let { Math.round(it * 2) / 2.0 }
            if (locked != lastLocked) {
                lastLocked = locked
                val req = PutDataMapRequest.create(WearLink.PATH_LAST).apply { dataMap.putString(WearLink.KEY_LINE, WearLink.encode(r)) }
                    .asPutDataRequest().setUrgent()
                Wearable.getDataClient(app).putDataItem(req).addOnFailureListener { Log.w(TAG, "last: ${it.message}") }
            }
        }
    }

    /** Reachable watches with the app; cached for 30 s (capability lookups are not free). */
    private suspend fun watchNodes(): List<String> {
        val now = SystemClock.uptimeMillis()
        if (now - nodesAt < 30_000) return nodes
        nodesAt = now
        nodes = runCatching {
            Wearable.getCapabilityClient(app).getCapability(WearLink.CAPABILITY_WATCH, CapabilityClient.FILTER_REACHABLE).await()
                .nodes.map { it.id }
        }.getOrDefault(emptyList())
        return nodes
    }

    private companion object {
        const val TAG = "WatchBridge"
    }
}
