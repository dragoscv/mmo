package ro.mixai.music

import android.app.Application
import android.os.Build
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import ro.mixai.mobile.MobileConfig
import ro.mixai.mobile.auth.SessionVault
import ro.mixai.music.data.MusicSettings
import ro.mixai.tv.data.ClientIdentity
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.newMixaiImageLoader

class MixaiMusicApp : Application(), SingletonImageLoader.Factory {
    lateinit var settings: Settings
        private set
    lateinit var musicSettings: MusicSettings
        private set
    lateinit var vault: SessionVault
        private set
    val config: MobileConfig by lazy {
        MobileConfig(
            origin = BuildConfig.MIXAI_ORIGIN,
            webOrigin = BuildConfig.MIXAI_WEB_ORIGIN,
            googleWebClientId = BuildConfig.GOOGLE_WEB_CLIENT_ID,
            appVersion = BuildConfig.VERSION_NAME,
            deviceLabel = "MixAI Music",
        )
    }

    override fun onCreate() {
        super.onCreate()
        ClientIdentity.current = ClientIdentity(
            platform = "android-music",
            appVersion = BuildConfig.VERSION_NAME,
            fallbackDeviceName = Build.MODEL ?: "Android",
            userAgentPrefix = "MixAI-Music-Android",
        )
        settings = Settings(this)
        musicSettings = MusicSettings(this)
        vault = SessionVault(musicSettings)
    }

    override fun newImageLoader(context: PlatformContext): ImageLoader = newMixaiImageLoader(context)
}
