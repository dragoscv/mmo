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
    }

    @Test fun playLinkCarriesTheQueryAndBlankMeansMix() {
        assertEquals(Dest.PlaySearch("queen"), MusicNavigator.parseLink("mixai-music", "play", emptyList()) { if (it == "q") "queen" else null })
        assertEquals(Dest.PlaySearch(""), MusicNavigator.parseLink("mixai-music", "play", emptyList()))
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
