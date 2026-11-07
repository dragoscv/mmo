package ro.mixai.music.wear

import android.app.Application
import android.os.Build
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import ro.mixai.tv.data.ClientIdentity
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.newMixaiImageLoader
import ro.mixai.tv.offline.TrackDownloads
import ro.mixai.tv.player.AudioPrefs
import ro.mixai.tv.player.MusicService

/** MixAI Music for Wear OS (WP17-41g). One process-wide [downloads] engine; the connection lives in core [Settings]. */
class WearMusicApp : Application(), SingletonImageLoader.Factory {
    lateinit var settings: Settings
        private set
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @OptIn(UnstableApi::class)
    override fun onCreate() {
        super.onCreate()
        ClientIdentity.current = ClientIdentity(
            platform = "wear-music",
            appVersion = BuildConfig.VERSION_NAME,
            fallbackDeviceName = Build.MODEL ?: "Wear OS",
            userAgentPrefix = "MixAI-Music-Wear",
        )
        settings = Settings(this)
        // Watch speaker is not a music output: Media3 suppresses it and opens the output switcher.
        MusicService.suppressOnUnsuitableOutput = true
        // Loudness normalisation on, no crossfade (one decoder at a time on a watch).
        MusicService.audioPrefs.value = AudioPrefs(crossfadeMs = 0, normalize = true)
        downloads.init(this)
        downloads.capBytes = WEAR_CAP
        // Any network: a watch is usually on Bluetooth proxy or Wi-Fi; WearNetwork asks for Wi-Fi while downloading.
        downloads.setWifiOnly(this, false)
        MusicService.dataSourceDecorator = { ctx, upstream -> downloads.dataSourceFactory(ctx, upstream) }
        appScope.launch {
            settings.connection.collect { c -> downloads.api = if (c.isComplete) MmoApi(c.baseUrl, c.token) else null }
        }
    }

    override fun newImageLoader(context: PlatformContext): ImageLoader = newMixaiImageLoader(context)

    companion object {
        @OptIn(UnstableApi::class)
        val downloads = TrackDownloads("wear-downloads", WearDownloadService::class.java)
        /** 4 GB default cap on the watch (Galaxy Watch8: 32 GB storage). */
        const val WEAR_CAP = 4L * 1024 * 1024 * 1024
    }
}
