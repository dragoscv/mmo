package ro.mixai.app.nav

import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.snapshots.SnapshotStateList
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.MediaRef

/** Bottom bar / rail destinations. */
enum class Tab { Home, Search, Library, Music, Live }

/** Navigation 3 back-stack keys. Tab roots are [Dest.TabRoot]; everything else is pushed on top. */
sealed interface Dest {
    data object Splash : Dest
    data object Welcome : Dest
    data object SignIn : Dest
    data class Discover(val preselected: DiscoveredServer? = null) : Dest
    data class Pair(val server: DiscoveredServer) : Dest
    data object Manual : Dest
    data object ProfilePicker : Dest
    data class TabRoot(val tab: Tab) : Dest
    data class Title(val kind: String, val tmdbId: Long) : Dest
    /** `resumeMs` = absolute start; -1 = local resume position; 0 = from start. */
    data class Player(val fileId: String, val ref: MediaRef? = null, val resumeMs: Long = -1L) : Dest
    data class Artist(val id: String) : Dest
    data class Album(val id: String) : Dest
    data object NowPlaying : Dest
    data class LivePlayer(val channelId: String) : Dest
    data object Settings : Dest
    // Slice 2 (WP16-46 / D38)
    data object Downloads : Dest
    /** Phone as TV remote; `deviceId` preselects a TV. */
    data class Remote(val deviceId: String? = null) : Dest
    /** Watch Together; `roomId` joins an existing room. */
    data class Together(val roomId: String? = null) : Dest
    data object FamilyStats : Dest
    data object PlexImport : Dest

    /** Onboarding / full-screen destinations hide the bottom bar. */
    val isChromeless: Boolean
        get() = this is Splash || this is Welcome || this is SignIn || this is Discover || this is Pair ||
            this is Manual || this is ProfilePicker || this is Player || this is NowPlaying || this is LivePlayer ||
            this is Remote
}

/** Single back stack observed by NavDisplay. */
@Stable
class Navigator(start: Dest) {
    val backStack: SnapshotStateList<Dest> = mutableStateListOf(start)

    val current: Dest get() = backStack.last()

    /** Tab whose root is at the bottom of the current stack (Home when none). */
    val currentTab: Tab get() = backStack.filterIsInstance<Dest.TabRoot>().lastOrNull()?.tab ?: Tab.Home

    fun push(d: Dest) { if (backStack.lastOrNull() != d) backStack.add(d) }

    fun pop(): Boolean {
        if (backStack.size <= 1) return false
        backStack.removeAt(backStack.lastIndex)
        return true
    }

    fun replace(d: Dest) {
        if (backStack.isEmpty()) backStack.add(d) else backStack[backStack.lastIndex] = d
    }

    fun resetTo(vararg dests: Dest) {
        val list = dests.toList().ifEmpty { listOf(Dest.TabRoot(Tab.Home)) }
        backStack.clear()
        backStack.addAll(list)
    }

    /** Re-selecting the current tab pops to its root; another tab resets the stack to that root. */
    fun selectTab(tab: Tab) {
        val root = Dest.TabRoot(tab)
        if (currentTab == tab) {
            val i = backStack.indexOfLast { it == root }
            if (i >= 0) while (backStack.size > i + 1) backStack.removeAt(backStack.lastIndex)
            return
        }
        // Home stays at the bottom so Back from another tab returns to Home.
        if (tab == Tab.Home) resetTo(root) else resetTo(Dest.TabRoot(Tab.Home), root)
    }
}
