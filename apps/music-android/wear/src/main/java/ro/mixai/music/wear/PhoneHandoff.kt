package ro.mixai.music.wear

import android.content.Context
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataItem
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.emptyFlow
import ro.mixai.tv.data.WearHandoff

/**
 * The connection the phone app publishes over the Data Layer (WP17-41g). Emits the current item (initial
 * read) and every later change (listener), so the offer appears whenever sync delivers it — the first
 * `dataItems` read can take tens of seconds on a freshly started watch process, or never complete.
 */
object PhoneHandoff {
    private const val TAG = "PhoneHandoff"

    fun offers(context: Context): Flow<WearHandoff.Payload?> {
        val app = context.applicationContext
        val gms = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(app)
        if (gms != ConnectionResult.SUCCESS) { Log.w(TAG, "play services unavailable: $gms"); return emptyFlow() }
        return callbackFlow {
            val client = Wearable.getDataClient(app)
            val listener = DataClient.OnDataChangedListener { events ->
                events.forEach { e ->
                    if (e.dataItem.uri.path != WearHandoff.PATH) return@forEach
                    trySend(if (e.type == DataEvent.TYPE_DELETED) null else decode(e.dataItem))
                }
                events.release()
            }
            client.addListener(listener)
            client.dataItems
                .addOnSuccessListener { buf ->
                    val item = buf.firstOrNull { it.uri.path == WearHandoff.PATH }
                    val p = item?.let(::decode)
                    Log.i(TAG, "initial read: items=${buf.count} offer=${p != null}")
                    buf.release()
                    if (p != null) trySend(p)
                }
                .addOnFailureListener { Log.w(TAG, "read: ${it.message}") }
            awaitClose { client.removeListener(listener) }
        }
    }

    private fun decode(item: DataItem): WearHandoff.Payload? {
        val map = DataMapItem.fromDataItem(item).dataMap
        return WearHandoff.fromMap(map.keySet().associateWith { k -> map.getString(k) }).also {
            Log.i(TAG, "handoff keys=${map.keySet()} decoded=${it != null}")
        }
    }
}
