package ro.mixai.music

import android.app.Application
import android.os.Build
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import ro.mixai.mobile.MobileConfig
import ro.mixai.mobile.auth.SessionVault
import ro.mixai.music.data.MusicSettings
import ro.mixai.music.downloads.MusicDownloadService
import ro.mixai.music.downloads.MusicDownloads
import ro.mixai.tv.data.ClientIdentity
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.newMixaiImageLoader
import ro.mixai.tv.player.AudioPrefs
import ro.mixai.tv.player.MusicService

class MixaiMusicApp : Application(), SingletonImageLoader.Factory {
    lateinit var settings: Settings
        private set
    lateinit var musicSettings: MusicSettings
        private set
    lateinit var vault: SessionVault
        private set
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val config: MobileConfig by lazy {
        MobileConfig(
            origin = BuildConfig.MIXAI_ORIGIN,
            webOrigin = BuildConfig.MIXAI_WEB_ORIGIN,
            googleWebClientId = BuildConfig.GOOGLE_WEB_CLIENT_ID,
            appVersion = BuildConfig.VERSION_NAME,
            deviceLabel = "MixAI Music",
        )
    }

    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
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
        // Downloads (WP17-41d): DownloadManager binds to the main looper; the player reads downloaded tracks.
        MusicDownloadService.ensureChannel(this)
        MusicDownloads.init(this)
        MusicService.dataSourceDecorator = { ctx, upstream -> MusicDownloads.dataSourceFactory(ctx, upstream) }
        appScope.launch {
            settings.connection.collect { c -> MusicDownloads.api = if (c.isComplete) MmoApi(c.baseUrl, c.token) else null }
        }
        // Gapless / ReplayGain-style normalisation / crossfade (WP17-41e): read by the core MusicService.
        appScope.launch {
            combine(musicSettings.crossfadeSec, musicSettings.normalize) { s, n -> AudioPrefs(crossfadeMs = s * 1000, normalize = n) }
                .collect { MusicService.audioPrefs.value = it }
        }
        appScope.launch {
            combine(musicSettings.wifiOnly, musicSettings.capGb) { w, gb -> w to gb }.collect { (w, gb) ->
                MusicDownloads.capBytes = gb.toLong() * 1024 * 1024 * 1024
                MusicDownloads.setWifiOnly(this@MixaiMusicApp, w)
            }
        }
    }

    override fun newImageLoader(context: PlatformContext): ImageLoader = newMixaiImageLoader(context)
}
