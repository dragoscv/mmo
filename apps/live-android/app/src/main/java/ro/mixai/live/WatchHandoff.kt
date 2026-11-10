package ro.mixai.live

import android.content.Context
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await
import ro.mixai.live.core.PairedEngine
import ro.mixai.live.core.WearEngineLink

/**
 * Hands the paired engine to MixAI Live on a Wear OS watch: DataClient item at [WearEngineLink.PATH] with the engine
 * JSON. The watch then talks to the engine directly over Wi-Fi. No-op without Play Services.
 */
class WatchHandoff(context: Context) {
    private val app = context.applicationContext
    private val available =
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(app) == ConnectionResult.SUCCESS

    /** True when a reachable watch has the app (capability `mixai_live_watch`). */
    suspend fun hasWatch(): Boolean = available && runCatching {
        Wearable.getCapabilityClient(app).getCapability(WearEngineLink.CAPABILITY_WATCH, CapabilityClient.FILTER_REACHABLE)
            .await().nodes.isNotEmpty()
    }.getOrDefault(false)

    suspend fun send(engine: PairedEngine): Boolean {
        if (!available) return false
        return runCatching {
            val req = PutDataMapRequest.create(WearEngineLink.PATH).apply {
                dataMap.putString(WearEngineLink.KEY_ENGINE, engine.toJson())
                dataMap.putLong("at", System.currentTimeMillis())
            }.asPutDataRequest().setUrgent()
            Wearable.getDataClient(app).putDataItem(req).await()
            true
        }.onFailure { Log.w("WatchHandoff", "send: ${it.message}") }.getOrDefault(false)
    }
}
