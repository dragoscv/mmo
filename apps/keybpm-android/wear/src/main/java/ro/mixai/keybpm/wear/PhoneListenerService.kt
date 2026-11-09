package ro.mixai.keybpm.wear

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService
import ro.mixai.listen.WearLink

/**
 * Wakes the watch app for the phone's last locked reading ([WearLink.PATH_LAST], DataClient): tile + complication
 * show it even when the watch app is not running. Live messages are handled by the app-level listener.
 */
class PhoneListenerService : WearableListenerService() {
    override fun onDataChanged(events: DataEventBuffer) {
        for (e in events) {
            if (e.type != DataEvent.TYPE_CHANGED || e.dataItem.uri.path != WearLink.PATH_LAST) continue
            val line = DataMapItem.fromDataItem(e.dataItem).dataMap.getString(WearLink.KEY_LINE) ?: continue
            val r = WearLink.decode(line) ?: continue
            if (r.keyIndex != null || r.bpm != null) LastReading.save(this, r.keyIndex, r.bpm)
        }
    }
}
