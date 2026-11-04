package ro.mixai.tv

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.newMixaiImageLoader

class MixaiApp : Application(), SingletonImageLoader.Factory {
    lateinit var settings: Settings
        private set

    override fun onCreate() {
        super.onCreate()
        settings = Settings(this)
    }

    /** Coil singleton tuned for TV (memory/disk caches, crossfade, low-RAM RGB_565) — `data/ImageLoading.kt`. */
    override fun newImageLoader(context: PlatformContext): ImageLoader = newMixaiImageLoader(context)
}
