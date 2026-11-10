package ro.mixai.live.wear

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService
import ro.mixai.live.core.PairedEngine
import ro.mixai.live.core.WearEngineLink

/** The phone handed us an engine ([WearEngineLink.PATH]): store it and connect over the watch's own Wi-Fi. */
class PhoneEngineService : WearableListenerService() {
    override fun onDataChanged(events: DataEventBuffer) {
        for (e in events) {
            if (e.type != DataEvent.TYPE_CHANGED || e.dataItem.uri.path != WearEngineLink.PATH) continue
            val json = DataMapItem.fromDataItem(e.dataItem).dataMap.getString(WearEngineLink.KEY_ENGINE) ?: continue
            val engine = PairedEngine.fromJson(json) ?: continue
            (application as LiveWearApp).use(engine)
        }
    }
}
