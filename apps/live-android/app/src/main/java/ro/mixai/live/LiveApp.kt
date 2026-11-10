package ro.mixai.live

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import ro.mixai.live.core.EngineStore
import ro.mixai.live.core.LiveClient

/** One client + store per process; the activity and the watch hand-off share them. */
class LiveApp : Application() {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val store by lazy { EngineStore(this) }
    val client by lazy { LiveClient(clientId = "phone-" + android.os.Build.MODEL.filter { it.isLetterOrDigit() }.take(16).ifEmpty { "android" }) }
    val watch by lazy { WatchHandoff(this) }
}
