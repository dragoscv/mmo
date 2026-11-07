package ro.mixai.app

import android.app.Application
import android.os.Build
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import ro.mixai.app.cast.CastSupport
import ro.mixai.app.data.PhoneDeps
import ro.mixai.app.data.PhoneSettings
import ro.mixai.app.data.ProgressFlusher
import ro.mixai.mobile.auth.SessionVault
import ro.mixai.app.downloads.DownloadCenter
import ro.mixai.app.downloads.SmartDownloadWorker
import ro.mixai.app.push.Channels
import ro.mixai.app.push.PushRegistrar
import ro.mixai.tv.data.ClientIdentity
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.newMixaiImageLoader

class MixaiPhoneApp : Application(), SingletonImageLoader.Factory {
    lateinit var settings: Settings
        private set
    lateinit var phone: PhoneDeps
        private set
    lateinit var progressFlusher: ProgressFlusher
        private set
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    override fun onCreate() {
        super.onCreate()
        Telemetry.init(this)
        ClientIdentity.current = ClientIdentity(
            platform = "android-phone",
            appVersion = BuildConfig.VERSION_NAME,
            fallbackDeviceName = Build.MODEL ?: "Android",
            userAgentPrefix = "MixAI-Android",
        )
        settings = Settings(this)
        val phoneSettings = PhoneSettings(this)
        phone = PhoneDeps(phoneSettings, SessionVault(phoneSettings))
        progressFlusher = ProgressFlusher(this)
        Channels.ensure(this)
        CastSupport.init(this)
        // DownloadManager binds to the creating thread's looper (main); SimpleCache indexes on its own thread.
        DownloadCenter.init(this)
        appScope.launch {
            SmartDownloadWorker.schedule(this@MixaiPhoneApp, phoneSettings.smartDownloads.first())
            PushRegistrar.sync(this@MixaiPhoneApp)
        }
    }

    /** Coil singleton (memory/disk caches, crossfade, OkHttp shared with the API) — core `data/ImageLoading.kt`. */
    override fun newImageLoader(context: PlatformContext): ImageLoader = newMixaiImageLoader(context)
}
