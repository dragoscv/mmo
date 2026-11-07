package ro.mixai.music.wear

import android.content.Context
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import ro.mixai.tv.data.WearHandoff

/**
 * Publishes the current server connection to MixAI Music on a paired watch (WP17-41g) as a Data Layer
 * item; the watch signs in with it, no code needed. No-op without Play Services (watch falls back to
 * a Quick Connect code). Cleared on sign-out / server change.
 */
object WearPublisher {
    private const val TAG = "WearPublisher"

    fun publish(context: Context, payload: WearHandoff.Payload?) {
        val app = context.applicationContext
        if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(app) != ConnectionResult.SUCCESS) return
        val client = Wearable.getDataClient(app)
        if (payload == null || !payload.isComplete) {
            client.deleteDataItems(android.net.Uri.Builder().scheme("wear").path(WearHandoff.PATH).build())
                .addOnFailureListener { Log.w(TAG, "clear: ${it.message}") }
            return
        }
        val req = PutDataMapRequest.create(WearHandoff.PATH).apply {
            WearHandoff.toMap(payload).forEach { (k, v) -> dataMap.putString(k, v) }
        }.asPutDataRequest().setUrgent()
        client.putDataItem(req).addOnFailureListener { Log.w(TAG, "publish: ${it.message}") }
    }
}
