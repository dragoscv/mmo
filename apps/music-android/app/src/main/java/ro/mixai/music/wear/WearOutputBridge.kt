package ro.mixai.music.wear

import android.content.Context
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import ro.mixai.tv.cast.MusicOutputs
import ro.mixai.tv.cast.OutputTarget
import ro.mixai.tv.data.WearHandoff

/**
 * Phone side of the watch output tile (WP17-41h): publishes where the phone's music plays (Data Layer item)
 * and moves it back to the phone when the watch asks (message). No-op without Play Services.
 */
object WearOutputBridge {
    private const val TAG = "WearOutputBridge"
    private val listener = MessageClient.OnMessageReceivedListener { e ->
        if (e.path == WearHandoff.MSG_OUTPUT_LOCAL) MusicOutputs.select(OutputTarget.Local)
    }

    fun start(context: Context, scope: CoroutineScope) {
        val app = context.applicationContext
        if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(app) != ConnectionResult.SUCCESS) return
        Wearable.getMessageClient(app).addListener(listener)
        scope.launch {
            MusicOutputs.active.map { WearHandoff.Output(it.kind, it.name) }.distinctUntilChanged().collect { o ->
                val req = PutDataMapRequest.create(WearHandoff.OUTPUT_PATH).apply {
                    WearHandoff.outputToMap(o).forEach { (k, v) -> dataMap.putString(k, v) }
                }.asPutDataRequest().setUrgent()
                Wearable.getDataClient(app).putDataItem(req).addOnFailureListener { Log.w(TAG, "publish: ${it.message}") }
            }
        }
    }
}
