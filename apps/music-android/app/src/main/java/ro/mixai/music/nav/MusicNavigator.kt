package ro.mixai.music.nav

import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.snapshots.SnapshotStateList
import ro.mixai.music.ui.MusicNav
import ro.mixai.tv.data.DiscoveredServer

/** Bottom bar / rail destinations of MixAI Music. */
enum class Tab { Home, Search, Downloads, Settings }

/** Navigation 3 back-stack keys. */
sealed interface Dest {
    data object Splash : Dest
    data object Welcome : Dest
    data object SignIn : Dest
    data class Discover(val preselected: DiscoveredServer? = null) : Dest
    data class Pair(val server: DiscoveredServer) : Dest
    data object Manual : Dest
    data object ProfilePicker : Dest
    data class TabRoot(val tab: Tab) : Dest
    data class Album(val id: String) : Dest
    data class Artist(val id: String) : Dest
    data object NowPlaying : Dest
    /** Voice / Assistant request (`MEDIA_PLAY_FROM_SEARCH`, `mixai-music://play?q=`); blank = a mix. Opens Now Playing. */
    data class PlaySearch(val query: String, val focus: String? = null, val artist: String? = null, val album: String? = null) : Dest
    /** `mixai-music://play?ids=a,b&index=n` (TV / desktop handoff): play these tracks, then Now Playing. */
    data class PlayIds(val ids: List<String>, val index: Int = 0) : Dest

    /** Onboarding / full-screen destinations hide the bottom bar and the mini player. */
    val isChromeless: Boolean
        get() = this is Splash || this is Welcome || this is SignIn || this is Discover || this is Pair ||
            this is Manual || this is ProfilePicker || this is NowPlaying
}

/** Single back stack observed by NavDisplay; also the [MusicNav] of the shared screens. */
@Stable
class MusicNavigator(start: Dest) : MusicNav {
    val backStack: SnapshotStateList<Dest> = mutableStateListOf(start)
    val current: Dest get() = backStack.last()
    val currentTab: Tab get() = backStack.filterIsInstance<Dest.TabRoot>().lastOrNull()?.tab ?: Tab.Home

    fun push(d: Dest) { if (backStack.lastOrNull() != d) backStack.add(d) }

    fun pop(): Boolean {
        if (backStack.size <= 1) return false
        backStack.removeAt(backStack.lastIndex)
        return true
    }

    fun resetTo(vararg dests: Dest) {
        backStack.clear()
        backStack.addAll(dests.toList().ifEmpty { listOf(Dest.TabRoot(Tab.Home)) })
    }

    /** Re-selecting the current tab pops to its root; another tab resets to Home + that root. */
    fun selectTab(tab: Tab) {
        val root = Dest.TabRoot(tab)
        if (currentTab == tab) {
            val i = backStack.indexOfLast { it == root }
            if (i >= 0) while (backStack.size > i + 1) backStack.removeAt(backStack.lastIndex)
            return
        }
        if (tab == Tab.Home) resetTo(root) else resetTo(Dest.TabRoot(Tab.Home), root)
    }

    override fun openAlbum(id: String) = push(Dest.Album(id))
    override fun openArtist(id: String) = push(Dest.Artist(id))
    override fun openNowPlaying() = push(Dest.NowPlaying)
    override fun back() { pop() }

    companion object {
        /**
         * Canonical `mixai-music://` set (WP17-45; iOS `MusicDeepLink`, desktop `links.rs`): `album/<id>`, `artist/<id>`,
         * `now-playing` | `nowplaying`, `search[?q=]`, `downloads`, `mix`, `play?ids=a,b&index=n` (ids win), `play?q=`
         * (blank = mix).
         */
        fun parseLink(scheme: String?, host: String?, segments: List<String>, query: (String) -> String? = { null }): Dest? {
            if (scheme != "mixai-music") return null
            val id = segments.firstOrNull()?.takeIf { it.isNotBlank() }
            return when (host?.lowercase()) {
                "home" -> Dest.TabRoot(Tab.Home)
                "album" -> id?.let { Dest.Album(it) }
                "artist" -> id?.let { Dest.Artist(it) }
                "now-playing", "nowplaying" -> Dest.NowPlaying
                "search" -> Dest.TabRoot(Tab.Search)
                "downloads" -> Dest.TabRoot(Tab.Downloads)
                "mix" -> Dest.PlaySearch("")
                "play" -> {
                    val ids = query("ids").orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }.take(500)
                    if (ids.isNotEmpty()) {
                        Dest.PlayIds(ids, (query("index")?.toIntOrNull() ?: 0).coerceIn(0, ids.lastIndex))
                    } else Dest.PlaySearch(query("q").orEmpty())
                }
                else -> null
            }
        }
    }
}
