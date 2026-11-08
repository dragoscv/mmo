package ro.mixai.music.nav

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MusicNavigatorTest {
    @Test fun parsesAlbumArtistAndNowPlayingLinks() {
        assertEquals(Dest.Album("al-1"), MusicNavigator.parseLink("mixai-music", "album", listOf("al-1")))
        assertEquals(Dest.Artist("ar 2"), MusicNavigator.parseLink("mixai-music", "artist", listOf("ar 2")))
        assertEquals(Dest.NowPlaying, MusicNavigator.parseLink("mixai-music", "now-playing", emptyList()))
        assertEquals(Dest.TabRoot(Tab.Search), MusicNavigator.parseLink("mixai-music", "search", emptyList()))
        assertEquals(Dest.TabRoot(Tab.Downloads), MusicNavigator.parseLink("mixai-music", "downloads", emptyList()))
    }

    @Test fun playLinkCarriesTheQueryAndBlankMeansMix() {
        assertEquals(Dest.PlaySearch("queen"), MusicNavigator.parseLink("mixai-music", "play", emptyList()) { if (it == "q") "queen" else null })
        assertEquals(Dest.PlaySearch(""), MusicNavigator.parseLink("mixai-music", "play", emptyList()))
    }

    @Test fun canonicalSetSharedWithIosAndDesktop() {
        assertEquals(Dest.TabRoot(Tab.Home), MusicNavigator.parseLink("mixai-music", "home", emptyList()))
        assertEquals(Dest.NowPlaying, MusicNavigator.parseLink("mixai-music", "nowplaying", emptyList()))
        assertEquals(Dest.PlaySearch(""), MusicNavigator.parseLink("mixai-music", "mix", emptyList()))
        val q = mapOf("ids" to "tr_1, tr_2,,tr_3", "index" to "1", "q" to "ignored")
        assertEquals(Dest.PlayIds(listOf("tr_1", "tr_2", "tr_3"), 1), MusicNavigator.parseLink("mixai-music", "play", emptyList()) { q[it] })
        val bad = mapOf("ids" to "tr_1", "index" to "9")
        assertEquals(Dest.PlayIds(listOf("tr_1"), 0), MusicNavigator.parseLink("mixai-music", "play", emptyList()) { bad[it] })
        val neg = mapOf("ids" to "tr_1,tr_2", "index" to "-3")
        assertEquals(Dest.PlayIds(listOf("tr_1", "tr_2"), 0), MusicNavigator.parseLink("mixai-music", "play", emptyList()) { neg[it] })
        assertEquals(Dest.PlaySearch("x"), MusicNavigator.parseLink("mixai-music", "play", emptyList()) { mapOf("ids" to " , ", "q" to "x")[it] })
    }

    @Test fun rejectsForeignSchemesAndMissingIds() {
        assertNull(MusicNavigator.parseLink("mixai", "album", listOf("x")))
        assertNull(MusicNavigator.parseLink("mixai-music", "album", emptyList()))
        assertNull(MusicNavigator.parseLink("mixai-music", "album", listOf("")))
        assertNull(MusicNavigator.parseLink("mixai-music", "title", listOf("movie", "1")))
    }

    @Test fun reselectingTabPopsToItsRootAndOtherTabKeepsHomeBelow() {
        val nav = MusicNavigator(Dest.TabRoot(Tab.Home))
        nav.openAlbum("a"); nav.openArtist("b")
        nav.selectTab(Tab.Home)
        assertEquals(listOf<Dest>(Dest.TabRoot(Tab.Home)), nav.backStack.toList())
        nav.selectTab(Tab.Search)
        assertEquals(listOf(Dest.TabRoot(Tab.Home), Dest.TabRoot(Tab.Search)), nav.backStack.toList())
        nav.back()
        assertEquals(Tab.Home, nav.currentTab)
    }

    @Test fun pushIgnoresDuplicateTop() {
        val nav = MusicNavigator(Dest.TabRoot(Tab.Home))
        nav.openNowPlaying(); nav.openNowPlaying()
        assertEquals(2, nav.backStack.size)
    }
}
