package ro.mixai.music.ui

import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.MusicPlayback
import ro.mixai.tv.data.MusicRepository

/**
 * What the shared music screens need from the host app (WP17-41, D50). The phone app's `AppDeps`
 * and the MixAI Music app's own graph both implement it, so the screens carry no app coupling.
 */
interface MusicDeps {
    val api: MmoApi
    val music: MusicRepository
    val musicPlayback: MusicPlayback
    /** Track downloads; null = the host does not offer them (no download controls shown). */
    val offline: MusicOffline? get() = null
    /** Output picker (Cast, DLNA, Home Assistant, MixAI TVs); null = no picker shown. */
    val outputs: ro.mixai.music.ui.output.OutputController? get() = null
}

/** Navigation the music screens trigger; each host maps it onto its own back stack. */
interface MusicNav {
    fun openAlbum(id: String)
    fun openArtist(id: String)
    fun openNowPlaying()
    fun back()
}
