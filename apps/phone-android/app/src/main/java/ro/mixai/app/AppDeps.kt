package ro.mixai.app

import android.content.Context
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import ro.mixai.tv.data.AccountSession
import ro.mixai.tv.data.Connection
import ro.mixai.tv.data.HubClient
import ro.mixai.tv.data.LiveTvRepository
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MediaRepository
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.MusicPlayback
import ro.mixai.tv.data.MusicRepository
import ro.mixai.tv.data.ProfileRepository
import ro.mixai.tv.data.ProgressSync
import ro.mixai.tv.data.Settings
import ro.mixai.app.data.PhoneApi
import ro.mixai.app.data.PhoneDeps
import ro.mixai.music.ui.MusicDeps

/** Long-lived objects of one server connection (rebuilt when base URL / token change). Same wiring as the TV app. */
class ConnectionGraph(
    val api: MmoApi,
    val profiles: ProfileRepository,
    val media: MediaRepository,
    val music: MusicRepository,
    val musicPlayback: MusicPlayback,
    val liveTv: LiveTvRepository,
    val hub: HubClient,
    val progressSync: ProgressSync,
    val phoneApi: PhoneApi,
)

fun buildGraph(context: Context, conn: Connection, settings: Settings): ConnectionGraph {
    val api = MmoApi(conn.baseUrl, conn.token)
    val profiles = ProfileRepository(api, settings)
    val profileId = { profiles.activeId }
    val media = MediaRepository(api, profileId, context.cacheDir)
    val music = MusicRepository(api, profileId)
    return ConnectionGraph(
        api = api,
        profiles = profiles,
        media = media,
        music = music,
        musicPlayback = MusicPlayback(context.applicationContext, music, media),
        liveTv = LiveTvRepository(api, profileId),
        hub = HubClient(api, settings) { profiles.activeProfile.value?.id },
        progressSync = ProgressSync(media, settings),
        phoneApi = PhoneApi(api, profileId) { profiles.profileToken },
    )
}

/**
 * Everything a connected screen needs. `scope` is activity-lifetime for writes that must outlive a
 * screen (progress, watchlist).
 */
@Immutable
data class AppDeps(
    override val api: MmoApi,
    val media: MediaRepository,
    val profiles: ProfileRepository,
    override val music: MusicRepository,
    override val musicPlayback: MusicPlayback,
    val liveTv: LiveTvRepository,
    val hub: HubClient,
    val settings: Settings,
    val progressSync: ProgressSync,
    /** Server 3.9 phone routes (bookmarks, usage, family stats, subtitle search, Plex import, downloads). */
    val phoneApi: PhoneApi,
    /** Phone-only prefs, session vault, web API (push, native sign-in). */
    val phone: PhoneDeps,
    val localeTag: String,
    val session: AccountSession,
    val scope: CoroutineScope,
    val onChangeServer: () -> Unit = {},
    val onSignOut: (() -> Unit)? = null,
) : MusicDeps {
    fun saveLocalProgress(fileId: String, posMs: Long, durMs: Long) {
        scope.launch { settings.saveProgress(fileId, posMs, durMs) }
    }

    fun saveServerProgress(ref: MediaRef, posMs: Long, durMs: Long) {
        scope.launch { progressSync.save(ref, posMs, durMs) }
    }

    /** Language for server `{ro,en}` texts. */
    val lang: String get() = localeTag.ifBlank { java.util.Locale.getDefault().language }
}

val LocalAppDeps = staticCompositionLocalOf<AppDeps?> { null }
