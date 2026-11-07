package ro.mixai.music.wear

import android.content.Context
import ro.mixai.tv.data.Connection
import ro.mixai.tv.data.MediaRepository
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.MusicPlayback
import ro.mixai.tv.data.MusicRepository
import ro.mixai.tv.data.ProfileRepository
import ro.mixai.tv.data.Settings

/** Objects of one server connection on the watch. */
class WearGraph(
    val api: MmoApi,
    val profiles: ProfileRepository,
    val music: MusicRepository,
    val playback: MusicPlayback,
)

fun buildWearGraph(context: Context, conn: Connection, settings: Settings): WearGraph {
    val api = MmoApi(conn.baseUrl, conn.token)
    val profiles = ProfileRepository(api, settings)
    val profileId = { profiles.activeId }
    val media = MediaRepository(api, profileId, context.cacheDir)
    val music = MusicRepository(api, profileId)
    return WearGraph(api, profiles, music, MusicPlayback(context.applicationContext, music, media))
}
