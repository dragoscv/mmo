package ro.mixai.tv.ui.nav

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import ro.mixai.tv.data.AccountSession
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

/**
 * Everything a screen needs, built once per server connection in MainActivity.
 * `scope` is the activity-lifetime scope for fire-and-forget writes that must outlive a screen.
 */
@Immutable
data class ScreenDeps(
    val api: MmoApi,
    val media: MediaRepository,
    val profiles: ProfileRepository,
    val music: MusicRepository,
    val musicPlayback: MusicPlayback,
    val liveTv: LiveTvRepository,
    val hub: HubClient,
    val settings: Settings,
    val progressSync: ProgressSync,
    val localeTag: String,
    val session: AccountSession,
    val scope: CoroutineScope,
    /** "Change server": forget the connection and go to discovery. */
    val onChangeServer: () -> Unit = {},
    /** "Sign out" of the MixAI account (null when not signed in). */
    val onSignOut: (() -> Unit)? = null,
) {
    /** Local per-device resume position (DataStore; ignored < 10 s, dropped at ≥ 95 %). */
    fun saveLocalProgress(fileId: String, posMs: Long, durMs: Long) {
        scope.launch { settings.saveProgress(fileId, posMs, durMs) }
    }

    /** Server progress (`PUT /media/progress`, offline queue on failure). */
    fun saveServerProgress(ref: MediaRef, posMs: Long, durMs: Long) {
        scope.launch { progressSync.save(ref, posMs, durMs) }
    }

    /** Language for server-provided `{ro,en}` texts (`HomeRow.titleFor`). */
    val lang: String get() = localeTag.ifBlank { java.util.Locale.getDefault().language }
}

/** Optional access for deep components (rail, mini-player); screens get deps as a parameter. */
val LocalScreenDeps = staticCompositionLocalOf<ScreenDeps?> { null }
