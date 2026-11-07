package ro.mixai.music

import android.content.Context
import androidx.compose.runtime.Immutable
import ro.mixai.music.downloads.MusicDownloads
import ro.mixai.music.ui.MusicDeps
import ro.mixai.music.ui.MusicOffline
import ro.mixai.music.ui.output.OutputController
import ro.mixai.tv.data.Connection
import ro.mixai.tv.data.HubClient
import ro.mixai.tv.data.MediaRepository
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.MusicPlayback
import ro.mixai.tv.data.MusicRepository
import ro.mixai.tv.data.ProfileRepository
import ro.mixai.tv.data.Settings

/** Long-lived objects of one server connection (rebuilt when base URL / token change). */
@Immutable
class MusicGraph(
    override val api: MmoApi,
    val profiles: ProfileRepository,
    val media: MediaRepository,
    override val music: MusicRepository,
    override val musicPlayback: MusicPlayback,
    val hub: HubClient,
    override val outputs: OutputController,
) : MusicDeps {
    override val offline: MusicOffline get() = MusicDownloads
}

fun buildMusicGraph(context: Context, conn: Connection, settings: Settings): MusicGraph {
    val api = MmoApi(conn.baseUrl, conn.token)
    val profiles = ProfileRepository(api, settings)
    val profileId = { profiles.activeId }
    val media = MediaRepository(api, profileId, context.cacheDir)
    val music = MusicRepository(api, profileId)
    val hub = HubClient(api, settings, profileId = { profiles.activeProfile.value?.id })
    return MusicGraph(
        api = api,
        profiles = profiles,
        media = media,
        music = music,
        musicPlayback = MusicPlayback(context.applicationContext, music, media),
        hub = hub,
        outputs = OutputController(context, api, hub, castEnabled = true) { settings.deviceId() },
    )
}
