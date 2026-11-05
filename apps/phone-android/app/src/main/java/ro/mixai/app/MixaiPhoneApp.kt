package ro.mixai.app

import android.app.Application
import android.os.Build
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import ro.mixai.tv.data.ClientIdentity
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.newMixaiImageLoader

class MixaiPhoneApp : Application(), SingletonImageLoader.Factory {
    lateinit var settings: Settings
        private set

    override fun onCreate() {
        super.onCreate()
        ClientIdentity.current = ClientIdentity(
            platform = "android-phone",
            appVersion = BuildConfig.VERSION_NAME,
            fallbackDeviceName = Build.MODEL ?: "Android",
            userAgentPrefix = "MixAI-Android",
        )
        settings = Settings(this)
    }

    /** Coil singleton (memory/disk caches, crossfade, OkHttp shared with the API) — core `data/ImageLoading.kt`. */
    override fun newImageLoader(context: PlatformContext): ImageLoader = newMixaiImageLoader(context)
}
