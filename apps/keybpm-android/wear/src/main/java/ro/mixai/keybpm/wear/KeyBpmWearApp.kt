package ro.mixai.keybpm.wear

import android.app.Application
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.Wearable
import ro.mixai.listen.WearLink

class KeyBpmWearApp : Application() {
    lateinit var listen: WearListen
        private set

    /** Live phone readings while any activity is alive (the listener service covers the app-not-running case). */
    private val live = MessageClient.OnMessageReceivedListener { e ->
        if (e.path == WearLink.PATH_LIVE) WearLink.decode(String(e.data, Charsets.UTF_8))?.let(listen::onPhone)
    }

    override fun onCreate() {
        super.onCreate()
        listen = WearListen(this)
        WearListenService.createChannel(this)
        runCatching { Wearable.getMessageClient(this).addListener(live) }
    }
}
